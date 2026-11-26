import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { listActivity } from "../src/worker/db/activity";
import { createDraft, getDocument, signDocument } from "../src/worker/db/documents";
import { getInvoiceForDocument } from "../src/worker/db/invoices";
import { getOnboardingForDeal, listItems } from "../src/worker/db/onboardings";
import { setStripeFetchForTests } from "../src/worker/documents/deposit";
import { setPdfRendererForTests } from "../src/worker/documents/signed";
import { getMailDeps, setMailDeps } from "../src/worker/mail/deps";
import type { ProposalContent } from "../src/worker/documents/proposal";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { E, deliver, signedDeal } from "./fixtures/close";
import { OWNER_EMAIL, clientSig, proposal, readyToSend, seedDeal, sendDraft, stubPdfRenderer } from "./fixtures/documents";
import { invoiceEvent } from "./fixtures/stripe";
import { resetProjectWork } from "./fixtures/projects";

// The onboarding after the close, through the entry points the app really uses: the Stripe webhook, the approvals route, the client's page and uploads, the
// owner's routes, Today and the daily cron, with the world replaced by fakes (Stripe, the mail transport, the PDF browser) and the clock (a fixed calendar).
const BASE = "https://clients.hellositeline.test";
const CLIENT_MAIL = "pat@acme.test";
const ctx = () => createExecutionContext();
/** Wed 1 December 2026, 09:00 in Los Angeles: the day the proposals are sent. Every later moment of the story is set from here. */
const SENT = "2026-12-01T17:00:00.000Z";
const at = (iso: string) => vi.setSystemTime(new Date(iso));

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
let cookie = "";
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  at(SENT);
  // Storage is shared by the tests of a file, and the daily sweep reads every open onboarding: start each test from none.
  await resetProjectWork(); // the payment now starts projects, and a project points at its onboarding
  await env.DB.batch(["onboarding_nudges", "onboarding_files", "onboarding_answers", "onboarding_items", "onboardings", "approvals"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  mail = await readyToSend();
  setMailDeps({ ...getMailDeps(), now: () => new Date() }); // the mail transport's clock is the test's clock
  stubPdfRenderer();
  const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
  cookie = login.headers.get("set-cookie")!.split(";")[0];
});
afterEach(() => {
  vi.useRealTimers();
  errors.mockRestore();
  setMailDeps(null); setPdfRendererForTests(null); setStripeFetchForTests(null);
});

/** The owner's browser: the session cookie. */
const owner = (method: string, path: string, body?: unknown) =>
  worker.fetch(new Request(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), E, ctx());
/** The client's browser: no cookie, only the link. */
const client = (token: string, method: string, path = "", body?: unknown) =>
  worker.fetch(new Request(`https://x/api/public/o/${token}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), E, ctx());

const activity = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId, 300)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const nudges = async (dealId: string) =>
  (await env.DB.prepare(`SELECT status, json_extract(payload, '$.nudgeKey') AS key FROM approvals WHERE kind = 'onboarding.nudge' AND record_id = ? ORDER BY created_at, id`).bind(dealId).all<{ status: string; key: string }>()).results;
const welcomes = async (dealId: string) =>
  (await env.DB.prepare(`SELECT id, status FROM approvals WHERE kind = 'onboarding.welcome' AND record_id = ?`).bind(dealId).all<{ id: string; status: string }>()).results;
const approveOver = async (id: string) => {
  const r = await owner("POST", `/approvals/${id}/approve`, {});
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true });
};
/** Pays the deal's deposit: the signed event Stripe would send. */
const pay = async (docId: string) => {
  const event = invoiceEvent("invoice.paid", (await getInvoiceForDocument(env.DB, docId))!);
  expect(await deliver(event)).toBe(200);
  return event;
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const upload = (token: string, itemId: string, bytes: Uint8Array, name: string, type: string) => {
  const form = new FormData();
  form.set("file", new File([bytes as BlobPart], name, { type }));
  return worker.fetch(new Request(`https://x/api/public/o/${token}/items/${itemId}/files`, { method: "POST", body: form }), E, ctx());
};

/** The six questions every client answers, then the rest of the required ones for a site build. */
const FIRST = { business: "We fix pipes for homes in town.", top_services: "Drains, water heaters, repipes.", service_area: "Springfield and the county" };
const REST = { different: "We show up when we say.", sites_you_like: "Example one, example two, example three", voice_words: "plain, friendly, fast", brand_assets: "A logo only", who_updates: "I would like you to do it", contact_times: "Weekdays after four, text",
  ideal_customer: "Homeowners with older houses.", visitor_actions: "Call us first, then request a quote.", pages_wanted: "Home, About, Drains, Water heaters, Contact", competitor_sites: "example.com is clear, but its quote form is long.", look_and_feel: "Clean and simple, warm and local.", public_details: "Ace Plumbing, 12 Main St, 555-0100, hello@ace.test, Mon to Fri 8 to 5" };

describe("onboarding, end to end", () => {
  it("a paid Starter proposal runs from welcome to collected items, a Friday update and a client who goes quiet and comes back", async () => {
    const a = await signedDeal({ name: "Ace Plumbing" });
    const b = await signedDeal({ name: "Bay Roofing" });
    mail.sent.length = 0;

    // ---- Payment: the webhook starts the onboarding and asks Logan to approve the welcome. Nothing is mailed yet.
    at("2026-12-02T18:00:00.000Z"); // Wed 10:00 in Los Angeles
    const event = await pay(a.docId);
    const o = (await getOnboardingForDeal(env.DB, a.dealId))!;
    expect(o).toMatchObject({ businessId: a.businessId, dealId: a.dealId, documentId: a.docId, kind: "build", test: false, welcomeSentAt: null, lastClientActivityAt: null });
    const [welcome, ...extra] = await welcomes(a.dealId);
    expect(extra).toEqual([]);
    expect(welcome.status).toBe("pending");
    expect(mail.sent).toEqual([]);

    // ---- The same event again starts nothing new.
    expect(await deliver(event)).toBe(200);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM onboardings WHERE deal_id = ?`).bind(a.dealId).first<{ n: number }>())!.n).toBe(1);
    expect(await welcomes(a.dealId)).toHaveLength(1);
    expect(mail.sent).toEqual([]);

    // ---- Logan approves the welcome through the approvals route: exactly one mail, to the contact, with the client's link.
    await approveOver(welcome.id);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(CLIENT_MAIL);
    expect(mail.sent[0].text).toContain(`${BASE}/o/${o.token}`);
    expect((await getOnboardingForDeal(env.DB, a.dealId))!.welcomeSentAt).toBe("2026-12-02T18:00:00.000Z");
    expect(await activity(a.businessId, "onboarding_welcome")).toHaveLength(1);

    // ---- The client opens the page on Thursday, saves some answers, and cannot submit with required ones missing.
    at("2026-12-03T18:00:00.000Z"); // Thu 10:00 in Los Angeles
    const opened = await client(o.token, "GET");
    expect(opened.status).toBe(200);
    const view = await opened.json() as { stage: string; businessName: string; items: { id: string; key: string; phase: number; status: string; files: unknown[] }[]; questionnaire: { questions: { id: string; required: boolean }[]; submittedAt: string | null } };
    expect(view).toMatchObject({ stage: "questionnaire", businessName: "Ace Plumbing" });
    expect(view.items.map((i) => i.key)).toEqual(["logo_files", "brand_text", "homepage_text", "homepage_photos", "service_page_text", "service_photos", "access_hosting", "access_dns", "access_registrar", "access_admin", "access_gbp", "access_analytics", "about_text", "team_photos", "reviews_text", "extra_pages_text", "faq_text", "social_links_text"]);
    expect(view.items.filter((i) => i.phase === 1)).toHaveLength(12);
    const itemId = (key: string) => view.items.find((i) => i.key === key)!.id;

    expect((await client(o.token, "PUT", "/answers", { answers: FIRST })).status).toBe(200);
    const early = await client(o.token, "POST", "/submit");
    expect(early.status).toBe(400);
    expect(await early.json()).toEqual({ error: "invalid body", fields: ["different", "sites_you_like", "voice_words", "ideal_customer", "visitor_actions", "pages_wanted", "who_updates", "competitor_sites", "look_and_feel", "brand_assets", "public_details", "contact_times"] });
    expect((await getOnboardingForDeal(env.DB, a.dealId))!.questionnaireSubmittedAt).toBeNull();

    expect((await client(o.token, "PUT", "/answers", { answers: REST })).status).toBe(200);
    const submitted = await client(o.token, "POST", "/submit");
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual({ ok: true });
    expect(await activity(a.businessId, "onboarding_submitted")).toHaveLength(1);

    // ---- A phase-1 text item and a phase-1 photo item (a real multipart upload into R2).
    expect((await client(o.token, "PUT", `/items/${itemId("homepage_text")}/text`, { text: "Fast, honest plumbing since 1998." })).status).toBe(200);
    const sent = await upload(o.token, itemId("logo_files"), PNG, "logo.png", "image/png");
    expect(sent.status).toBe(201);
    const { file } = await sent.json() as { file: { id: string; fileName: string; sizeBytes: number } };
    expect(file).toMatchObject({ fileName: "logo.png", sizeBytes: PNG.byteLength });
    const after = (await (await client(o.token, "GET")).json()) as { stage: string; progress: { done: number; total: number }; items: { key: string; status: string; textValue: string | null; files: { id: string }[] }[] };
    expect(after.stage).toBe("collecting");
    expect(after.items.find((i) => i.key === "homepage_text")).toMatchObject({ status: "received", textValue: "Fast, honest plumbing since 1998." });
    expect(after.items.find((i) => i.key === "logo_files")).toMatchObject({ status: "received", files: [{ id: file.id }] });
    expect(after.progress).toEqual({ done: 3, total: 19 });
    expect(await activity(a.businessId, "onboarding_received")).toHaveLength(2);

    // ---- The file is in R2 and downloads for the owner only as an attachment that no browser will run.
    const stored = await env.RAW.get((await env.DB.prepare(`SELECT r2_key FROM onboarding_files WHERE id = ?`).bind(file.id).first<{ r2_key: string }>())!.r2_key);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PNG);
    const down = await owner("GET", `/onboarding-files/${file.id}`);
    expect(down.status).toBe(200);
    expect(down.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''logo.png");
    expect(down.headers.get("x-content-type-options")).toBe("nosniff");
    expect(down.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(PNG);
    expect((await worker.fetch(new Request(`https://x/api/onboarding-files/${file.id}`), E, ctx())).status).toBe(401);

    // ---- Today asks Logan to review the two things the client sent; he accepts them through the owner routes and the item goes away.
    const today = async () => ((await (await owner("GET", "/today")).json()) as { items: { kind: string; businessId: string; reason: string }[] }).items.filter((i) => i.kind === "onboarding_attention" && i.businessId === a.businessId);
    expect(await today()).toEqual([expect.objectContaining({ reason: "2 items from Ace Plumbing to review" })]);
    const state = async () => (await (await owner("GET", `/deals/${a.dealId}/onboarding`)).json()) as { stage: string; link: string; items: { id: string; key: string; status: string }[]; welcomeApproval: { status: string } };
    expect((await state()).link).toBe(`${BASE}/o/${o.token}`);
    for (const key of ["homepage_text", "logo_files"]) {
      const r = await owner("PATCH", `/onboarding-items/${itemId(key)}`, { status: "accepted" });
      expect(r.status).toBe(200);
    }
    expect((await state()).items.filter((i) => i.status === "accepted").map((i) => i.key)).toEqual(["logo_files", "homepage_text"]);
    expect(await today()).toEqual([]);

    // ---- Friday 09:00 in Los Angeles: items are still waiting, so the daily cron queues one Friday update for approval (the client wrote yesterday: no reminder). Nothing is mailed.
    at("2026-12-04T17:00:00.000Z");
    mail.sent.length = 0;
    await runScheduled(E, DAILY_CRON, new Date());
    expect(await nudges(a.dealId)).toEqual([{ status: "pending", key: "friday:2026-12-04" }]);
    await runScheduled(E, DAILY_CRON, new Date());
    expect(await nudges(a.dealId)).toEqual([{ status: "pending", key: "friday:2026-12-04" }]);
    expect(mail.sent).toEqual([]);

    // ---- A second client pays on Monday and then goes silent for 14 days.
    at("2026-12-07T18:00:00.000Z");
    await pay(b.docId);
    const ob = (await getOnboardingForDeal(env.DB, b.dealId))!;
    await approveOver((await welcomes(b.dealId))[0].id);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].text).toContain(`${BASE}/o/${ob.token}`);
    const stateOf = async () => (await (await owner("GET", `/deals/${b.dealId}/onboarding`)).json()) as { stage: string; silentDays: number };
    expect(await stateOf()).toMatchObject({ stage: "questionnaire" });

    at("2026-12-21T18:00:00.000Z");
    expect(await stateOf()).toMatchObject({ stage: "waiting_on_client", silentDays: 14 });
    await runScheduled(E, DAILY_CRON, new Date());
    await runScheduled(E, DAILY_CRON, new Date());
    const waiting = await activity(b.businessId, "onboarding_waiting");
    expect(waiting).toEqual(["no reply for 14 days (last heard from the client 2026-12-07): the back-of-queue clause applies"]);

    // ---- The client writes: the silence is over, and the return is logged once.
    expect((await client(ob.token, "PUT", "/answers", { answers: { business: "Roofs, gutters and skylights." } })).status).toBe(200);
    expect((await stateOf()).stage).not.toBe("waiting_on_client");
    expect(await stateOf()).toMatchObject({ stage: "questionnaire", silentDays: 0 });
    expect(await activity(b.businessId, "onboarding_resumed")).toEqual(["Client is back after 14 days of silence (2026-12-21)"]);
    expect((await client(ob.token, "PUT", "/answers", { answers: { service_area: "Springfield" } })).status).toBe(200);
    expect(await activity(b.businessId, "onboarding_resumed")).toHaveLength(1);
    expect(await activity(b.businessId, "onboarding_waiting")).toHaveLength(1);

    // The welcome link of the first client is untouched by any of it, and nothing was ever mailed without an approval.
    expect(mail.sent.every((m) => m.to !== CLIENT_MAIL || m.text.includes(`/o/${ob.token}`))).toBe(true);
    expect((await listItems(env.DB, o.id)).filter((i) => i.status === "accepted")).toHaveLength(2);
    expect((await getDocument(env.DB, a.docId))!.paidAt).toBeTruthy();
  });
});

describe("onboarding, the test start and the link", () => {
  /** A deal whose only proposal is a signed TEST copy, addressed to the real prospect. */
  async function testDeal() {
    const s = await seedDeal();
    const base = proposal();
    const pkg = (key: ProposalContent["packages"][number]["key"], name: string) => ({ key, version: 1, name, priceLine: "$1,000", includes: [] });
    const content: ProposalContent = { ...base, packages: [pkg("starter_site", "Starter Site"), pkg("care", "Care")] };
    const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content, test: true });
    const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(await signDocument(env.DB, doc.id, clientSig(hash), "2026-12-02T09:00:00.000Z")).toBe("signed");
    return s;
  }

  async function startTest() {
    const s = await testDeal();
    const started = await owner("POST", `/deals/${s.dealId}/onboarding/test`);
    expect(started.status).toBe(201);
    const state = await started.json() as { onboarding: { id: string; test: boolean }; link: string; welcomeApproval: { id: string; status: string } };
    expect(state.onboarding.test).toBe(true);
    expect(state.link).toMatch(new RegExp(`^${BASE}/o/[A-Za-z0-9_-]+$`));
    return { ...s, state, token: state.link.slice(`${BASE}/o/`.length) };
  }

  it("the manual test start mails only the owner's own address", async () => {
    const t = await startTest();
    expect(mail.sent).toEqual([]);
    await approveOver(t.state.welcomeApproval.id);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(OWNER_EMAIL);
    expect(mail.sent[0].subject).toMatch(/^\[Test\] /);
    expect(mail.sent[0].text).toContain(t.state.link);
    expect(mail.sent.some((m) => m.to === "pat@ace.test")).toBe(false);
  });

  it("a revoked link is a 404 for the client", async () => {
    const t = await startTest();
    expect((await client(t.token, "GET")).status).toBe(200);
    const revoked = await owner("POST", `/onboardings/${t.state.onboarding.id}/link/revoke`);
    expect(revoked.status).toBe(200);
    const gone = await client(t.token, "GET");
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "not found" });
    expect((await client(t.token, "PUT", "/answers", { answers: { business: "x" } })).status).toBe(404);
    expect((await client(t.token, "POST", "/submit")).status).toBe(404);
  });
});
