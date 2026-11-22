import { Hono } from "hono";
import { z } from "zod";
import { gradeViewFor } from "../clients/gradeData";
import { getClientRecord, isClient, isTestClient, listClients } from "../clients/record";
import { logActivity } from "../db/activity";
import { getGrades, setGrade } from "../db/grade";
import { settleAccessItem } from "../db/onboardings";
import {
  ACCESS_KEYS, SiteConflictError, SiteInputError, archiveSite, createSite, getSite, listAccess, setAccess, updateSite,
  type AccessKey, type AccessStatus, type Site, type SiteFields,
} from "../db/sites";
import type { Env } from "../env";
import { bodyOf, invalid, NOT_FOUND, ownerOnError, type Ctx } from "../projects/http";
import { cleanText } from "../onboarding/templates";
import { ACCESS_LABELS, cleanVaultName, isHttpUrl, noteProblem, vaultNameProblem } from "../sites/access";

/** Mounted at /api (behind requireAuth): /clients, /clients/:id, /clients/:id/sites, /sites/:id, /sites/:id/access/:key (and the same site routes under /clients/:id/sites/:siteId). */
export const clientRoutes = new Hono<{ Bindings: Env }>();
clientRoutes.onError((e, c) => (e instanceof SiteConflictError ? c.json({ error: e.message }, 409) : e instanceof SiteInputError ? c.json({ error: e.message }, 400) : ownerOnError(e, c)));

const SHORT = 120;
const URL_MAX = 300;
const NOTE_MAX = 500;

/** Short text: cleaned (control and bidirectional characters out, ends trimmed), then measured, so what is stored is what was counted. Empty clears the field. */
const short = (label: string) =>
  z.string(`${label} must be text.`).transform((s) => cleanText(s, s.length))
    .pipe(z.string().max(SHORT, `${label} is at most ${SHORT} characters.`))
    .superRefine((s, ctx) => { const p = noteProblem(s); if (p) ctx.addIssue({ code: "custom", message: p }); }).transform((s) => s || null);

/** True when the address carries a user name or password (`https://admin:pw@host/`): a login must never be stored in an address. */
const hasLogin = (s: string): boolean => { try { const u = new URL(s); return !!(u.username || u.password); } catch { return false; } };

/** An http or https address with no login in it, or empty to clear it. A refusal never repeats what was typed. */
const link = (label: string) =>
  z.string(`${label} must be text.`).transform((s) => cleanText(s, s.length))
    .pipe(z.string().max(URL_MAX, `${label} is at most ${URL_MAX} characters.`)
      .refine((s) => s === "" || isHttpUrl(s), `${label} must start with http:// or https://.`)
      .refine((s) => !isHttpUrl(s) || !hasLogin(s), "Leave the login out of the address.")).transform((s) => s || null);

const siteNote = z.string("Notes must be text.").transform((s) => cleanText(s, s.length))
  .superRefine((s, ctx) => { const p = noteProblem(s); if (p) ctx.addIssue({ code: "custom", message: p }); }).transform((s) => s || null);

const FIELDS = {
  url: link("The site address").nullable(),
  domain: short("The domain").nullable(),
  cms: z.enum(["wordpress", "webflow", "wix", "squarespace", "shopify", "custom", "unknown"], "That is not one of the site platforms."),
  hostProvider: short("The host").nullable(),
  registrar: short("The registrar").nullable(),
  dnsProvider: short("The DNS provider").nullable(),
  adminUrl: link("The admin address").nullable(),
  hostingTier: z.enum(["logan_hosted", "client_hosted", "unknown"], "That is not one of the hosting options."),
  accessMethod: z.enum(["ssh_wpcli", "mainwp", "none", "unknown"], "That is not one of the access methods."),
  notes: siteNote.nullable(),
};
const SiteBody = z.object(FIELDS).partial().strict();
// The Care updates access: checked again against fixed patterns by `updateSite` (a refusal there is a 400 with its sentence), because these reach a remote shell.
const careWord = (label: string) => z.string(`${label} must be text.`).transform((s) => s.trim()).pipe(z.string().max(300, `${label} is too long.`)).transform((s) => s || null);
const CARE_FIELDS = {
  wpSshAlias: careWord("The SSH alias").nullable(),
  wpPath: careWord("The WordPress folder").nullable(),
  carePaths: z.array(z.string("Each page must be text.").max(300, "A page path is too long."), "Pages to check must be a list.").max(50, "Pick one to five pages to check."),
};
const PatchSiteBody = z.object({ ...FIELDS, ...CARE_FIELDS }).partial().strict().refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });

const vaultName = z.string("The item name must be text.")
  .superRefine((s, ctx) => { const p = vaultNameProblem(s); if (p) ctx.addIssue({ code: "custom", message: p }); }).transform(cleanVaultName);
const accessNote = z.string("The note must be text.").transform((s) => cleanText(s, s.length))
  .superRefine((s, ctx) => { const p = noteProblem(s); if (p) ctx.addIssue({ code: "custom", message: p }); }).transform((s) => s || null);
const AccessBody = z.object({
  status: z.enum(["needed", "requested", "received", "verified", "not_applicable"], "That is not one of the access statuses.").optional(),
  vaultItem: vaultName.nullable().optional(),
  note: accessNote.nullable().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });

const STATUS_WORDS: Record<AccessStatus, string> = { needed: "needed", requested: "requested", received: "received", verified: "verified", not_applicable: "not applicable" };

/** Only the keys the body actually carried, so a field left out is left alone. */
const given = <T extends Record<string, unknown>>(b: T): Partial<SiteFields> => Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as Partial<SiteFields>;

/** What each site field is called in the activity line. Only these words are ever logged, never a value. */
const FIELD_WORDS: Record<keyof SiteFields, string> = {
  url: "address", domain: "domain", cms: "platform", hostProvider: "host", registrar: "registrar", dnsProvider: "DNS provider", adminUrl: "admin address",
  hostingTier: "hosting tier", accessMethod: "access method", notes: "notes", wpSshAlias: "SSH alias", wpPath: "WordPress folder", carePaths: "pages to check",
};

/** The clients, by name; `?test=1` adds the rehearsal ones. */
clientRoutes.get("/clients", async (c) => c.json({ clients: await listClients(c.env.DB, { includeTest: c.req.query("test") === "1" }) }));

/** The whole client record. This is the one place a vault item name or an access note is ever sent. */
clientRoutes.get("/clients/:id", async (c) => {
  const client = await getClientRecord(c.env.DB, c.req.param("id"), new Date());
  return client ? c.json({ client }) : c.json(NOT_FOUND, 404);
});

const GRADE_NOTE_MAX = 300;
const GradeBody = z.object({
  grade: z.enum(["A", "B", "C"], "The grade is A, B or C, or null for none.").nullable(),
  note: z.string("The note must be text.").transform((s) => cleanText(s, s.length)).pipe(z.string().max(GRADE_NOTE_MAX, `The note is at most ${GRADE_NOTE_MAX} characters.`)).optional(),
}).strict();

/**
 * Sets the owner's grade for the client (A, B or C with an optional note of at most 300 characters), or clears it with `null` (which clears the note too). Answers the grade view. The grade
 * is the owner's word: nothing the rules suggest later changes it. A test client can be graded too. A body that is not a grade is 422; an id that is not a client is 404.
 */
clientRoutes.put("/clients/:id/grade", async (c) => {
  const parsed = GradeBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 422);
  const businessId = c.req.param("id");
  if (!(await isClient(c.env.DB, businessId))) return c.json(NOT_FOUND, 404);
  const { grade, note = "" } = parsed.data;
  const before = (await getGrades(c.env.DB, [businessId])).get(businessId);
  const now = new Date();
  await setGrade(c.env.DB, businessId, grade, grade === null ? "" : note, now.toISOString());
  // One plain line, never the note: a grade that changes says so, a note edited on its own says that, and a save that changes nothing logs nothing.
  const line = grade === null ? (before?.grade ? `Grade cleared (was ${before.grade})` : null)
    : before?.grade !== grade ? `Grade set to ${grade}${before?.grade ? ` (was ${before.grade})` : ""}`
    : before.note !== note ? "Grade note updated" : null;
  if (line) await logActivity(c.env.DB, businessId, "grade_set", line);
  return c.json(await gradeViewFor(c.env.DB, businessId, now));
});

/** Adds a site by hand (six `needed` access items come with it). A domain the client already has on a live site is 409. */
clientRoutes.post("/clients/:id/sites", async (c) => {
  const body = await bodyOf(c, SiteBody);
  if (body instanceof Response) return body;
  const businessId = c.req.param("id");
  if (!(await isClient(c.env.DB, businessId))) return c.json(NOT_FOUND, 404);
  const { site } = await createSite(c.env.DB, { businessId, test: await isTestClient(c.env.DB, businessId), ...given(body) });
  await logActivity(c.env.DB, businessId, "site_added", `Site added: ${site.domain ?? "no domain yet"}`);
  return c.json({ site, access: await listAccess(c.env.DB, site.id) }, 201);
});

/** The live site, or null: an archived site is gone as far as the owner's screens go. With `clientId` it must belong to that client. */
async function liveSite(c: Ctx, siteId: string, clientId?: string): Promise<Site | null> {
  const site = await getSite(c.env.DB, siteId);
  return site && !site.archivedAt && (clientId === undefined || site.businessId === clientId) ? site : null;
}

async function patchSite(c: Ctx, clientId?: string): Promise<Response> {
  const body = await bodyOf(c, PatchSiteBody);
  if (body instanceof Response) return body;
  const site = await liveSite(c, c.req.param("siteId") ?? c.req.param("id")!, clientId);
  if (!site) return c.json(NOT_FOUND, 404);
  const patch = given(body);
  const updated = await updateSite(c.env.DB, site.id, patch, new Date().toISOString());
  // What changed is read off the saved site: a new address that works out a new domain names "domain" too, and a value saved as it already was names nothing.
  const changed = (Object.keys(FIELD_WORDS) as (keyof SiteFields)[]).filter((k) => (patch[k] !== undefined || (k === "domain" && patch.url !== undefined)) && (updated ?? site)[k] !== site[k]);
  if (changed.length) await logActivity(c.env.DB, site.businessId, "site_changed", `Site updated: ${changed.map((k) => FIELD_WORDS[k]).join(", ")}`);
  return c.json({ site: updated });
}

async function removeSite(c: Ctx, clientId?: string): Promise<Response> {
  const site = await liveSite(c, c.req.param("siteId") ?? c.req.param("id")!, clientId);
  if (!site || !(await archiveSite(c.env.DB, site.id, new Date().toISOString()))) return c.json(NOT_FOUND, 404);
  await logActivity(c.env.DB, site.businessId, "site_changed", "Site archived");
  return c.body(null, 204);
}

async function putAccess(c: Ctx, clientId?: string): Promise<Response> {
  const body = await bodyOf(c, AccessBody);
  if (body instanceof Response) return body;
  const key = c.req.param("key") as AccessKey;
  const site = await liveSite(c, c.req.param("siteId") ?? c.req.param("id")!, clientId);
  if (!site || !ACCESS_KEYS.includes(key)) return c.json(NOT_FOUND, 404);
  const item = await setAccess(c.env.DB, site.id, key, body, new Date().toISOString());
  if (!item) return c.json(NOT_FOUND, 404);
  // The access is in (or does not apply), so the client's matching question is settled too: it must not keep the onboarding open and pause the work. It never fails the request.
  if (body.status === "received" || body.status === "verified" || body.status === "not_applicable") {
    try {
      await settleAccessItem(c.env.DB, site.businessId, key, body.status === "not_applicable" ? "not_applicable" : "accepted", new Date().toISOString());
    } catch (e) {
      console.error("clients: access question not settled", (e instanceof Error ? e.message : "unknown error").replace(/\s+/g, " ").trim().slice(0, 200));
    }
  }
  // The line says what happened to the status and nothing else: the item name and the note stay on the record.
  await logActivity(c.env.DB, site.businessId, "access_changed", `${ACCESS_LABELS[key].label}: ${body.status ? STATUS_WORDS[body.status] : "details updated"}`);
  return c.json({ item });
}

// The id-less site routes cannot carry a client id by design; the /clients/:id/sites/:siteId forms enforce that the site belongs to that client.
clientRoutes.patch("/sites/:id", (c) => patchSite(c));
clientRoutes.delete("/sites/:id", (c) => removeSite(c));
clientRoutes.put("/sites/:id/access/:key", (c) => putAccess(c));
clientRoutes.patch("/clients/:id/sites/:siteId", (c) => patchSite(c, c.req.param("id")));
clientRoutes.delete("/clients/:id/sites/:siteId", (c) => removeSite(c, c.req.param("id")));
clientRoutes.put("/clients/:id/sites/:siteId/access/:key", (c) => putAccess(c, c.req.param("id")));
