import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { Business, Search, Suppression } from "../types";
import { businessDomain, domainOf, findBusinessCandidates, getBusiness, loadMatchPool, siteDomain, upsertBusiness } from "../db/businesses";
import { createImportSearch, finishImportSearch } from "../db/searches";
import { logActivity } from "../db/activity";
import { isSuppressed } from "../db/suppression";
import { matchBusiness, type ImportRow, type MatchKind } from "../import/match";
import { normalizeName } from "../import/names";
import { CsvFormatError, ImportLimitError, MAX_IMPORT_ROWS, parseCsv, type ParsedRow } from "../import/parse";
import { bad } from "./suppressions";

export const importRoutes = new Hono<{ Bindings: Env }>();

const Source = z.string({ error: "say where these leads came from, for example Referral" }).trim()
  .min(1, "say where these leads came from, for example Referral").max(80, "the source is too long (80 characters at most)");
const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

const PreviewBody = z.object({
  text: z.string().optional(), url: z.string().trim().max(500).optional(), name: z.string().trim().max(200).optional(), source: Source,
});

const RowIn = z.object({
  name: z.string({ error: "each row needs a name" }).trim().min(1, "each row needs a name").max(200, "a business name is too long (200 characters at most)"),
  url: opt(500), address: opt(300), phone: opt(60), category: opt(120),
});
const CommitBody = z.object({
  source: Source,
  rows: z.array(z.object({
    row: RowIn, action: z.enum(["create", "link", "skip"], { error: "action must be create, link or skip" }), businessId: z.string().trim().min(1).max(100).optional(),
  }).refine((r) => r.action !== "link" || !!r.businessId, { message: "link needs the business to link to" }))
    .min(1, "there are no rows to import").max(MAX_IMPORT_ROWS, `import at most ${MAX_IMPORT_ROWS} rows at a time`),
});

const REASON_TEXT: Record<string, string> = { client: "an existing client", opt_out: "opted out", competitor: "a competitor", active_deal: "an active deal", other: "other" };
const suppressedReason = (s: Suppression) => `On your suppression list: ${REASON_TEXT[s.reason] ?? s.reason}.`;

/** What is wrong with a row's website, or null when it is fine (or absent). Social pages pass: they are stored but never matched on. */
function urlProblem(url: string | null): string | null {
  if (!url) return null;
  const d = domainOf(url.trim());
  return d && d.includes(".") && !/\s/.test(url.trim()) ? null : "The website does not look like a web address.";
}
const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

const slim = (b: Business) => ({ id: b.id, name: b.name, domain: b.domain, website_url: b.website_url, address: b.address, lead_status: b.lead_status, archived_at: b.archived_at });

/** A single URL becomes one row named after its domain unless a name was given. A social page cannot name the business, so it needs one. */
function singleRow(url: string, name: string | undefined, source: string): ParsedRow & { nameDerived?: boolean } {
  const derived = !name;
  const row: ImportRow = { name: name || siteDomain(url) || "", url, address: null, phone: null, category: null, source };
  return row.name ? { line: 1, row, ...(derived ? { nameDerived: true } : {}) } : { line: 1, row, error: "Add a business name: that address is a social or listing page, which does not say which business it is." };
}

importRoutes.post("/preview", async (c) => {
  const p = PreviewBody.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: bad(p.error) }, 400);
  const { text, url, name, source } = p.data;
  let parsed: (ParsedRow & { nameDerived?: boolean })[];
  try {
    if (text?.trim()) parsed = parseCsv(text, source);
    else if (url) parsed = [singleRow(url, name, source)];
    else return c.json({ error: "paste a website address or a CSV file" }, 400);
  } catch (e) {
    if (e instanceof CsvFormatError || e instanceof ImportLimitError) return c.json({ error: e.message }, 400);
    throw e;
  }

  const pool = await loadMatchPool(c.env.DB);
  const firstSeen = new Map<string, number>(); // duplicate key -> index of the first row that used it
  const rows: unknown[] = [];
  for (const [index, pr] of parsed.entries()) {
    const out = { index, line: pr.line, row: pr.row, nameDerived: pr.nameDerived, candidates: [] as ReturnType<typeof slim>[] };
    const done = (kind: MatchKind | "duplicate_in_file" | "suppressed" | "invalid", reason?: string, candidates: Business[] = []) =>
      rows.push({ ...out, kind, reason, candidates: candidates.map(slim) });
    const problem = pr.error ?? urlProblem(pr.row.url);
    if (problem) { done("invalid", problem); continue; }
    const hit = await isSuppressed(c.env.DB, { websiteUrl: pr.row.url });
    if (hit) { done("suppressed", suppressedReason(hit)); continue; }
    const key = siteDomain(pr.row.url) ? `d:${siteDomain(pr.row.url)}` : `n:${normalizeName(pr.row.name)}|${normalizeName(pr.row.address)}`;
    const earlier = firstSeen.get(key);
    if (earlier !== undefined) { done("duplicate_in_file", `Same ${key.startsWith("d:") ? "website" : "name and address"} as row ${earlier + 1}.`); continue; }
    firstSeen.set(key, index);
    const m = matchBusiness(pr.row, pool);
    done(m.kind, m.kind === "new" ? undefined : m.kind === "exact" ? "Already in your leads." : "Might already be in your leads. Choose what to do.", m.candidates);
  }
  return c.json({ rows });
});

/** Starts the quick audit of an imported lead. A repeat (same business) is treated as already started. Throws if the workflow cannot start. */
async function startQuickAudit(binding: Pick<Workflow, "create" | "get">, businessId: string) {
  const id = `import-${businessId}`;
  try {
    await binding.create({ id, params: { businessId, searchId: null, forceDraft: false, stage: "quick" } });
  } catch (e) {
    if (await binding.get(id).catch(() => null)) return;
    throw e;
  }
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

importRoutes.post("/commit", async (c) => {
  const p = CommitBody.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: bad(p.error) }, 400);
  const { source, rows } = p.data;
  const db = c.env.DB;

  const pool = await loadMatchPool(db); // grows as rows are created, so a repeat later in the same request sees the first one
  let container: Search | null = null;
  const created: { index: number; business: Business }[] = [];
  const leads: { index: number; id: string; name: string; outcome: "created" | "linked" | "existing" }[] = [];
  const refused: { index: number; name: string; reason: string }[] = [];
  const failures: { index: number; name: string; error: string; kind: "row" | "audit" }[] = [];
  let skipped = 0, linked = 0, alreadyExisted = 0;

  for (const [index, item] of rows.entries()) {
    if (item.action === "skip") { skipped++; continue; }
    const row: ImportRow = { ...item.row, source };
    try {
      // The client's idea of a row's state is not trusted: suppression and domain clashes are decided here, now.
      const hit = await isSuppressed(db, { websiteUrl: row.url });
      if (hit) { refused.push({ index, name: row.name, reason: suppressedReason(hit) }); continue; }

      if (item.action === "link") {
        const target = await getBusiness(db, item.businessId!);
        if (!target) { failures.push({ index, name: row.name, error: "That lead no longer exists.", kind: "row" }); continue; }
        await logActivity(db, target.id, "import", `Also imported from ${source}`);
        linked++; leads.push({ index, id: target.id, name: target.name, outcome: "linked" });
        continue;
      }

      const problem = urlProblem(row.url);
      if (problem) { failures.push({ index, name: row.name, error: problem, kind: "row" }); continue; }
      const domain = siteDomain(row.url);
      // upsertBusiness merges by domain and rewrites the existing name, so a domain that is already stored must never reach it.
      const clash = domain ? (await findBusinessCandidates(db, row, pool)).find((b) => businessDomain(b) === domain) : undefined;
      if (clash) {
        await logActivity(db, clash.id, "import", `Also imported from ${source}`);
        alreadyExisted++; leads.push({ index, id: clash.id, name: clash.name, outcome: "existing" });
        continue;
      }
      container ??= await createImportSearch(db, source);
      const b = await upsertBusiness(db, {
        placeId: null, name: row.name, category: row.category ?? null, address: row.address ?? null, phone: row.phone ?? null,
        websiteUrl: row.url ? withScheme(row.url.trim()) : null, mapsUrl: null, rating: null, reviewCount: null,
      }, container.id);
      pool.push(b);
      await logActivity(db, b.id, "import", `Imported from ${source}`);
      created.push({ index, business: b }); leads.push({ index, id: b.id, name: b.name, outcome: "created" });
    } catch (e) {
      failures.push({ index, name: row.name, error: errText(e), kind: "row" });
    }
  }

  if (container) await finishImportSearch(db, container.id, created.length);

  // After every lead is written, so one workflow failing to start cannot lose leads that already exist. The lead stays
  // in All leads without an audit; its page can run one.
  let auditsQueued = 0;
  for (const { index, business } of created) {
    try { await startQuickAudit(c.env.LEAD_WORKFLOW, business.id); auditsQueued++; }
    catch (e) { failures.push({ index, name: business.name, error: `The lead was created, but its quick scan could not be started: ${errText(e)}`, kind: "audit" }); }
  }

  return c.json({ created: created.length, linked, alreadyExisted, skipped, auditsQueued, refused, failures, leads, searchId: container?.id ?? null });
});
