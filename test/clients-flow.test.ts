import { createExecutionContext, env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import type { OutboundMessage } from "../src/worker/mail/types";
import { listActivity } from "../src/worker/db/activity";
import { getOnboardingForDeal, listItems } from "../src/worker/db/onboardings";
import { getInvoiceForDocument } from "../src/worker/db/invoices";
import { listProjects } from "../src/worker/db/projects";
import { listAccess, listSites } from "../src/worker/db/sites";
import { getSubscription, listSubscriptions } from "../src/worker/db/subscriptions";
import { setStripeFetchForTests } from "../src/worker/documents/deposit";
import { setPdfRendererForTests } from "../src/worker/documents/signed";
import { getMailDeps, setMailDeps } from "../src/worker/mail/deps";
import type { Option } from "../src/worker/sales/options";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { E, deliver, signedDeal } from "./fixtures/close";
import { PROPOSAL_OPTIONS, readyToSend, stubPdfRenderer } from "./fixtures/documents";
import { seedBusiness } from "./fixtures/cro";
import { resetProjectWork } from "./fixtures/projects";
import { invoiceEvent, stripeApi } from "./fixtures/stripe";

// Clients and sites, end to end, through the entry points the app really uses: the signed Stripe webhook, the owner's routes under /api, the client's public onboarding page, Today, the
// MCP tool and the daily cron, with the world replaced by fakes (Stripe, the mail transport, the PDF browser) and the clock (a fixed calendar in Los Angeles). One story, told in order.
const BASE = "https://clients.hellositeline.test";
const CLIENT_MAIL = "pat@acme.test";
const ctx = () => createExecutionContext();
const SENT = "2026-12-01T17:00:00.000Z"; // Tue 1 Dec 09:00 in Los Angeles: the day the proposal is sent
const at = (iso: string) => vi.setSystemTime(new Date(iso));

/** Growth with Care and the client-hosted surcharge: Logan manages a site that stays on the client's own hosting. */
const HOSTED_OPTIONS: Option[] = [
  ...PROPOSAL_OPTIONS.filter((o) => o.id !== "c"),
  { id: "c", label: "Growth, client hosted", tagline: "A bigger site on your own hosting", items: [{ key: "growth_site" }, { key: "care" }, { key: "client_hosted_surcharge" }], recommended: false },
];

// What only the owner may ever see: the NAME of a password manager item and a note. Both carry a marker no other text in the story contains.
const VAULT = { hosting: "Quokka host entry", dns: "Quokka DNS entry", registrar: "Quokka registrar entry", admin: "Quokka admin entry" } as const;
const NOTES = { hosting: "Wombat note: the owner is Dana's brother", dns: "Wombat note: same account as hosting", registrar: "Wombat note: renews every March", admin: "Wombat note: editor role only" } as const;
const SECRET_MARKER = /quokka|wombat/i;

let mail: Awaited<ReturnType<typeof readyToSend>>;
/** Every message the fake transport saw, in order: `drain` moves what it has seen so far here and clears it, so a step can look at only its own mail. */
const seen: OutboundMessage[] = [];
const drain = () => { seen.push(...mail.sent); mail.sent.length = 0; };
let errors: ReturnType<typeof vi.spyOn>;
let cookie = "";
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  at(SENT);
  await resetProjectWork();
  await env.DB.batch(["onboarding_nudges", "onboarding_files", "onboarding_answers", "onboarding_items", "onboardings", "approvals", "billing_holds", "invoice_nudges"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  // The sweeps read every open invoice and subscription, and the tests of a file share storage: leftovers from other files' tests are put out of the way.
  await env.DB.batch([
    env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE status IN ('open', 'failed')`),
    env.DB.prepare(`UPDATE subscriptions SET status = 'cancelled' WHERE status IN ('planned', 'proposed', 'link_sent', 'active', 'past_due')`),
  ]);
  mail = await readyToSend();
  seen.length = 0;
  setMailDeps({ ...getMailDeps(), now: () => new Date() }); // the mail transport's clock is the test's clock
  stubPdfRenderer();
  cookie = "";
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMailDeps(null); setPdfRendererForTests(null); setStripeFetchForTests(null);
});

/** The owner's browser: the session cookie (a session lasts 30 days; this story lasts a few weeks). */
async function signIn() {
  const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
}
const owner = async (method: string, path: string, body?: unknown) => {
  if (!cookie) await signIn();
  return worker.fetch(new Request(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), E, ctx());
};
const ok = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
  const r = await owner(method, path, body);
  expect(r.status, `${method} ${path} ${r.status}`).toBe(status);
  return (await r.json()) as T;
};
/** The client's browser: no cookie, only the link. `o` is the onboarding page, `s` the Care payment page. */
const clientCall = (kind: "o" | "s", token: string, method: string, path = "", body?: unknown) =>
  worker.fetch(new Request(`https://x/api/public/${kind}/${token}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), E, ctx());

let rpcId = 0;
async function mcp(name: string, args: unknown) {
  const r = await SELF.fetch("https://x/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer test-mcp-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await r.text();
  return JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) as { result: { isError?: boolean; content: { text: string }[] } };
}

interface AccessView { key: string; status: string; vaultItem: string | null; note: string | null; requestedAt: string | null; receivedAt: string | null; clientAnswer: string | null }
interface RecordView {
  business: { id: string; name: string; leadStatus: string };
  sites: { site: { id: string; domain: string | null; hostingTier: string; accessMethod: string; seedKey: string | null; test: boolean }; access: AccessView[]; flags: { code: string; text: string }[] }[];
  mrrCents: number; careLabel: string | null; subscriptions: { packageKey: string; status: string }[];
}
interface ListedClient { id: string; name: string; careLabel: string | null; mrrCents: number; siteCount: number; accessMissing: number }
const record = async (id: string) => (await ok<{ client: RecordView }>("GET", `/clients/${id}`)).client;
const clients = async () => (await ok<{ clients: ListedClient[] }>("GET", "/clients")).clients;
const todayAccess = async (businessId: string) =>
  ((await ok<{ items: { kind: string; businessId: string; reason: string }[] }>("GET", "/today")).items).filter((i) => i.kind === "access_missing" && i.businessId === businessId);
const activity = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId, 400)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const approvals = (kind: string, o: { status?: string } = {}) => env.DB.prepare(
  `SELECT id, status, title, preview, payload FROM approvals WHERE kind = ? ${o.status ? "AND status = ?" : ""} ORDER BY created_at, id`,
).bind(kind, ...(o.status ? [o.status] : [])).all<{ id: string; status: string; title: string; preview: string; payload: string }>().then((r) => r.results);
const approveOver = async (id: string) => {
  const r = await owner("POST", `/approvals/${id}/approve`, {});
  expect({ status: r.status, body: await r.json() }).toEqual({ status: 200, body: { ok: true } });
};
const linkIn = (text: string, kind: "o" | "s"): string => new RegExp(`${BASE.replace(/\./g, "\\.")}/${kind}/([A-Za-z0-9_-]+)`).exec(text)![1];
const cron = async (iso: string) => { at(iso); await runScheduled(E, DAILY_CRON, new Date()); };

interface PublicItem { id: string; key: string; kind: string; status: string; textValue: string | null }
const publicPage = async (token: string) => { const r = await clientCall("o", token, "GET"); expect(r.status).toBe(200); return { text: await r.text() }; };

/** Finishes the project's steps through POST /tasks/:id/complete in step order, the way Logan would work down the list. */
async function walk(projectId: string) {
  const view = async () => ok<{ project: { status: string }; tasks: { id: string; isStep: boolean; position: number; status: string; stepKey: string | null; requires: string[] }[] }>("GET", `/projects/${projectId}`);
  const steps = (await view()).tasks.filter((t) => t.isStep).sort((a, b) => a.position - b.position);
  const closed = new Set(steps.filter((t) => t.status === "done" || t.status === "skipped").map((t) => t.stepKey));
  for (const t of steps) {
    if (closed.has(t.stepKey) || t.requires.some((r) => !closed.has(r))) continue;
    const r = await owner("POST", `/tasks/${t.id}/complete`);
    expect(r.status, `complete ${t.stepKey}`).toBe(200);
    closed.add(t.stepKey);
  }
  expect((await view()).project.status).toBe("done");
}

describe("clients and sites, end to end", () => {
  it("a paid Growth + Care + client-hosted proposal makes one client, one site and six access items that Logan works through; the secrets stay on the owner's record", async () => {
    const a = await signedDeal({ name: "Ace Plumbing", optionId: "c", options: HOSTED_OPTIONS });
    drain();
    const stripe = stripeApi({ session: (id) => ({ id, status: "complete", payment_status: "paid", subscription: "sub_ace_care", customer: "cus_ace" }) });
    setStripeFetchForTests(stripe.f);

    // ---- Wed 2 Dec: the deposit is paid by webhook. One primary site exists, hosted by the client (the surcharge was signed), with six `needed` access items; the onboarding asks the client six questions.
    at("2026-12-02T18:00:00.000Z");
    expect(await deliver(invoiceEvent("invoice.paid", (await getInvoiceForDocument(env.DB, a.docId))!))).toBe(200);
    const [site, ...otherSites] = await listSites(env.DB, { businessId: a.businessId });
    expect(otherSites).toEqual([]);
    expect(site).toMatchObject({ seedKey: "primary", domain: "ace.com", hostingTier: "client_hosted", accessMethod: "unknown", test: false, archivedAt: null });
    expect((await listAccess(env.DB, site.id)).map((i) => [i.key, i.status, i.vaultItem, i.note])).toEqual(
      ["hosting", "dns", "registrar", "admin", "gbp", "analytics"].map((k) => [k, "needed", null, null]),
    );
    expect(await activity(a.businessId, "site_added")).toEqual(["Site record made for ace.com"]);
    const onboarding = (await getOnboardingForDeal(env.DB, a.dealId))!;
    const accessItems = (await listItems(env.DB, onboarding.id)).filter((i) => i.key.startsWith("access_"));
    expect(accessItems.map((i) => [i.key, i.kind, i.status])).toEqual(["hosting", "dns", "registrar", "admin", "gbp", "analytics"].map((k) => [`access_${k}`, "text", "waiting"]));
    const projects = await listProjects(env.DB, { businessId: a.businessId });
    expect(projects.map((p) => [p.templateKey, p.status])).toEqual([["BUILD", "active"]]);
    const build = projects[0];
    // The client list has the client, with nothing billing yet and six items still to get.
    expect((await clients()).filter((c) => c.id === a.businessId)).toEqual([expect.objectContaining({ name: "Ace Plumbing", careLabel: null, mrrCents: 0, siteCount: 1, accessMissing: 6 })]);

    // ---- The welcome is approved and mailed; the client opens the page and answers two access questions in their own words. A password-looking answer is refused with the neutral sentence.
    const [welcome] = await approvals("onboarding.welcome", { status: "pending" });
    await approveOver(welcome.id);
    expect(mail.sent.map((m) => m.to)).toEqual([CLIENT_MAIL]);
    const token = linkIn(mail.sent[0].text, "o");
    expect(token).toBe(onboarding.token);
    at("2026-12-03T18:00:00.000Z");
    const opened = (await (await clientCall("o", token, "GET")).json()) as { items: PublicItem[] };
    const itemOf = (key: string) => opened.items.find((i) => i.key === key)!;
    expect(opened.items.filter((i) => i.key.startsWith("access_")).map((i) => i.key)).toEqual(accessItems.map((i) => i.key));
    const hostingAnswer = "GoDaddy. Yes, I can add Logan, invite goes to ops@ace.test";
    expect((await clientCall("o", token, "PUT", `/items/${itemOf("access_hosting").id}/text`, { text: hostingAnswer })).status).toBe(200);
    expect((await clientCall("o", token, "PUT", `/items/${itemOf("access_dns").id}/text`, { text: "Same as hosting, I think" })).status).toBe(200);
    const refusedAnswer = await clientCall("o", token, "PUT", `/items/${itemOf("access_admin").id}/text`, { text: "password: hunter2" });
    expect(refusedAnswer.status).toBe(422);
    expect(JSON.stringify(await refusedAnswer.json())).not.toContain("hunter2");
    // Logan sees the client's words as quoted text on the checklist, and the items are still `needed`: what a client wrote is a hint, never a status.
    const afterAnswers = (await record(a.businessId)).sites[0].access;
    expect(afterAnswers.map((i) => [i.key, i.status, i.clientAnswer])).toEqual([
      ["hosting", "needed", hostingAnswer], ["dns", "needed", "Same as hosting, I think"], ["registrar", "needed", null], ["admin", "needed", null], ["gbp", "needed", null], ["analytics", "needed", null],
    ]);
    expect(JSON.stringify(await env.DB.prepare(`SELECT text_value FROM onboarding_items`).all())).not.toContain("hunter2");

    // ---- Today: no row while the project is under three days old; the Friday update is queued and left for later.
    at("2026-12-04T17:00:00.000Z");
    await runScheduled(E, DAILY_CRON, new Date());
    const [friday, ...moreFriday] = await approvals("onboarding.nudge", { status: "pending" });
    expect(moreFriday).toEqual([]);
    expect(await todayAccess(a.businessId)).toEqual([]);
    at("2026-12-05T17:59:00.000Z"); // a minute short of three days
    expect(await todayAccess(a.businessId)).toEqual([]);
    // Day 4: the row appears, names every missing item by its fixed label, and carries nothing the client or Logan typed.
    at("2026-12-06T18:00:00.000Z");
    const [row, ...rows] = await todayAccess(a.businessId);
    expect(rows).toEqual([]);
    expect(row.reason).toBe("Access still missing: Hosting, DNS, Registrar, Site admin, Google Business Profile, Analytics");
    expect(row.reason).not.toContain("GoDaddy");

    // ---- Mon 7 Dec: Logan works the checklist. Asking changes the status and stamps the first ask; the row stays.
    at("2026-12-07T18:00:00.000Z");
    const sid = (await record(a.businessId)).sites[0].site.id;
    const put = (key: string, body: unknown, status = 200) => ok<{ item: AccessView }>("PUT", `/sites/${sid}/access/${key}`, body, status);
    const asked = (await put("hosting", { status: "requested" })).item;
    expect(asked).toMatchObject({ status: "requested", requestedAt: "2026-12-07T18:00:00.000Z", receivedAt: null });
    expect((await todayAccess(a.businessId))[0].reason).toContain("Hosting");
    // A secret-looking name is refused with a plain sentence that never repeats it, and the stored row does not change.
    const stored = async () => JSON.stringify((await record(a.businessId)).sites[0].access);
    const beforeRefusals = await stored();
    for (const bad of ["password: hunter2", "Xk9#mP2$vL7@qR4!", "Acme-Plumbing-Cloudflare-DNS", "https://admin:pw@host.test/login", "sk_live_abcdef1234567890"]) {
      const refused = await owner("PUT", `/sites/${sid}/access/hosting`, { status: "received", vaultItem: bad });
      expect(refused.status, bad).toBe(400);
      const text = await refused.text();
      for (const piece of ["hunter2", "Xk9", "Acme-Plumbing", "admin:pw", "abcdef1234567890"]) expect(text, bad).not.toContain(piece);
      expect(await stored(), bad).toBe(beforeRefusals);
    }
    expect((await owner("PUT", `/sites/${sid}/access/hosting`, { note: "api_key: abcdef" })).status).toBe(400);
    expect(await stored()).toBe(beforeRefusals);
    // Four items received with a vault name and a note; Google Business Profile and Analytics are not applicable (the client has none). The row narrows, then clears.
    for (const key of ["hosting", "dns", "registrar", "admin"] as const) {
      const item = (await put(key, { status: "received", vaultItem: VAULT[key], note: NOTES[key] })).item;
      expect(item).toMatchObject({ status: "received", vaultItem: VAULT[key], note: NOTES[key], receivedAt: "2026-12-07T18:00:00.000Z" });
    }
    expect((await put("gbp", { status: "not_applicable" })).item.status).toBe("not_applicable");
    expect((await todayAccess(a.businessId)).map((r) => r.reason)).toEqual(["Access still missing: Analytics"]);
    expect((await put("analytics", { status: "not_applicable", note: "Wombat note: no analytics set up" })).item.status).toBe("not_applicable");
    expect(await todayAccess(a.businessId)).toEqual([]);
    expect((await clients()).find((c) => c.id === a.businessId)).toMatchObject({ accessMissing: 0, siteCount: 1 });
    expect((await record(a.businessId)).sites[0].flags).toEqual([]); // Care is not billing yet, so the client-hosted rule has nothing to say
    // The timeline says what happened to each status and nothing else.
    expect(await activity(a.businessId, "access_changed")).toEqual(expect.arrayContaining(["Hosting: requested", "Hosting: received", "DNS: received", "Registrar: received", "Site admin: received", "Google Business Profile: not applicable", "Analytics: not applicable"]));
    // The Friday update that was waiting is approved now (items are still outstanding for the client): one mail, with the client's link, and none of Logan's details.
    drain();
    await approveOver(friday.id);
    expect(mail.sent.map((m) => m.to)).toEqual([CLIENT_MAIL]);
    expect(mail.sent[0].text).toContain(`${BASE}/o/${token}`);

    // ---- Wed 9 Dec: the site launches. The Care subscription is proposed, approved, opened by the client and paid at Checkout; the client now shows Care and its monthly.
    at("2026-12-09T18:00:00.000Z");
    await walk(build.id);
    const [careSub] = (await listSubscriptions(env.DB, { businessId: a.businessId })).filter((s) => s.packageKey === "care");
    expect(careSub).toMatchObject({ status: "proposed", monthlyCents: 12900 });
    const [subStart] = await approvals("subscription.start", { status: "pending" });
    drain();
    await approveOver(subStart.id);
    const careToken = linkIn(mail.sent[0].text, "s");
    expect(await (await clientCall("s", careToken, "POST", "/checkout")).json()).toMatchObject({ url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//) });
    const session = (await getSubscription(env.DB, careSub.id))!.stripeCheckoutSessionId!;
    expect(await deliver({ id: "evt_ace_checkout", type: "checkout.session.completed", data: { object: { id: session, mode: "subscription", status: "complete", payment_status: "paid", client_reference_id: careSub.id, subscription: "sub_ace_care", customer: "cus_ace", livemode: false } } })).toBe(200);
    expect(await getSubscription(env.DB, careSub.id)).toMatchObject({ status: "active" });
    expect((await clients()).find((c) => c.id === a.businessId)).toMatchObject({ careLabel: "Care $129/mo", mrrCents: 12900, siteCount: 1, accessMissing: 0 });
    const careRecord = await record(a.businessId);
    expect(careRecord).toMatchObject({ careLabel: "Care $129/mo", mrrCents: 12900 });
    expect(JSON.stringify(careRecord.subscriptions)).not.toContain(careToken); // the client's payment link token is never on the owner's record
    // Care on a client-hosted site needs a way in: the flag shows until the access method is set.
    expect(careRecord.sites[0].site).toMatchObject({ hostingTier: "client_hosted", accessMethod: "unknown" });
    expect(careRecord.sites[0].flags.map((f) => f.code)).toEqual(["client_hosted_no_access"]);
    await ok("PATCH", `/sites/${sid}`, { accessMethod: "mainwp" });
    expect((await record(a.businessId)).sites[0].flags).toEqual([]);
    expect(await activity(a.businessId, "site_changed")).toEqual(["Site updated: access method"]);
    expect(await todayAccess(a.businessId)).toEqual([]);

    // ---- Fri 11 Dec: another Friday update, approved and mailed.
    await cron("2026-12-11T17:00:00.000Z");
    const [friday2] = await approvals("onboarding.nudge", { status: "pending" });
    expect(friday2).toBeTruthy();
    await approveOver(friday2.id);

    // ---- The vault names and the notes are on the owner's record and nowhere the client, Claude or the timeline can read them.
    const owners = JSON.stringify(await record(a.businessId));
    expect(owners).toContain(VAULT.hosting);
    expect(owners).toContain(NOTES.admin); // the control: the owner's own record does carry them
    const clientPage = (await publicPage(token)).text;
    expect(clientPage).toContain("access_hosting"); // the page is the real one, with the six questions
    expect(clientPage).not.toMatch(SECRET_MARKER);
    drain();
    const toClient = seen.filter((m) => m.to === CLIENT_MAIL);
    expect(toClient.filter((m) => m.text.includes(`${BASE}/o/${token}`))).toHaveLength(3); // the welcome and the two Friday updates
    expect(toClient.filter((m) => m.text.includes(`${BASE}/s/${careToken}`))).toHaveLength(1);
    for (const m of seen) expect(JSON.stringify(m), m.subject).not.toMatch(SECRET_MARKER);
    const allApprovals = (await env.DB.prepare(`SELECT kind, title, preview, payload FROM approvals`).all()).results;
    expect(allApprovals.length).toBeGreaterThan(3);
    expect(JSON.stringify(allApprovals)).not.toMatch(SECRET_MARKER);
    const lead = await mcp("get_lead", { id: a.businessId });
    expect(lead.result.isError).toBeUndefined();
    expect(lead.result.content[0].text).toContain("Ace Plumbing");
    expect(lead.result.content[0].text).not.toMatch(SECRET_MARKER);
    expect(JSON.stringify(await listActivity(env.DB, a.businessId, 500))).not.toMatch(SECRET_MARKER);
    expect(JSON.stringify(await clients())).not.toMatch(SECRET_MARKER); // the list is names and counts only
    expect(JSON.stringify(await ok("GET", "/today"))).not.toMatch(SECRET_MARKER);
    expect(JSON.stringify(await ok("GET", `/leads/${a.businessId}`))).not.toMatch(SECRET_MARKER);

    // ---- A lead with a site record is archived, never deleted.
    const del = await owner("DELETE", `/leads/${a.businessId}`);
    expect(del.status).toBe(409);
    expect(await env.DB.prepare(`SELECT id FROM businesses WHERE id = ?`).bind(a.businessId).first()).not.toBeNull();

    // ---- Sun 20 Dec: Logan puts the access method back and one item back to needed; both flags show and Today names the item. Archiving the site takes it all away.
    at("2026-12-20T18:00:00.000Z");
    await ok("PATCH", `/sites/${sid}`, { accessMethod: "none" });
    await put("admin", { status: "needed" });
    const flagged = await record(a.businessId);
    expect(flagged.sites[0].flags.map((f) => f.code)).toEqual(["access_missing", "client_hosted_no_access"]);
    expect((await todayAccess(a.businessId)).map((r) => r.reason)).toEqual(["Access still missing: Site admin"]);
    expect(await ok("GET", "/billing/summary")).toMatchObject({ heldClients: 0 });
    const gone = await owner("DELETE", `/sites/${sid}`);
    expect(gone.status).toBe(204);
    expect((await record(a.businessId)).sites).toEqual([]);
    expect(await todayAccess(a.businessId)).toEqual([]);
    expect((await clients()).find((c) => c.id === a.businessId)).toMatchObject({ siteCount: 0, accessMissing: 0, careLabel: "Care $129/mo" });
    expect((await owner("DELETE", `/sites/${sid}`)).status).toBe(404); // an archived site is gone as far as the owner's screens go
    expect((await owner("PUT", `/sites/${sid}/access/admin`, { status: "received" })).status).toBe(404);
    expect((await activity(a.businessId, "site_changed")).reverse()).toEqual(["Site updated: access method", "Site updated: access method", "Site archived"]); // newest first
    // The history stays: the archived site and its items are still stored, and the lead still cannot be deleted.
    expect((await listSites(env.DB, { businessId: a.businessId, includeArchived: true })).map((s) => s.archivedAt !== null)).toEqual([true]);
    expect((await owner("DELETE", `/leads/${a.businessId}`)).status).toBe(409);

    // ---- A client that only has a hand-made site (no project, no onboarding): the site record alone keeps the lead from being deleted.
    const dune = await seedBusiness({ name: "Dune Dental", websiteUrl: null });
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(dune.id).run();
    const made = await ok<{ site: { id: string; domain: string | null }; access: { status: string }[] }>("POST", `/clients/${dune.id}/sites`, { url: "https://dune.test/" }, 201);
    expect(made.site.domain).toBe("dune.test");
    expect(made.access.map((i) => i.status)).toEqual(Array(6).fill("needed"));
    const duneDelete = await owner("DELETE", `/leads/${dune.id}`);
    expect(duneDelete.status).toBe(409);
    expect(((await duneDelete.json()) as { error: string }).error).toMatch(/site record/);
    expect((await owner("DELETE", `/clients/${dune.id}/sites/${made.site.id}`)).status).toBe(204);
    expect((await owner("DELETE", `/leads/${dune.id}`)).status).toBe(409); // an archived site still counts
    expect(await todayAccess(dune.id)).toEqual([]); // no project, so no clock for the row

    // Nothing in the whole story logged an unexpected error.
    expect(errors.mock.calls.map((x: unknown[]) => x.map(String).join(" ").slice(0, 200))).toEqual([]);
  }, 60_000);
});
