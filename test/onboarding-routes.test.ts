import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { listActivity } from "../src/worker/db/activity";
import { createDraft, getDocument, setPaid, signDocument } from "../src/worker/db/documents";
import {
  addFile, closeOnboarding, createOnboarding, getOnboarding, getOnboardingForDeal, listItems, markWelcomeSent, saveItemText, setItemStatus, type NewItem,
} from "../src/worker/db/onboardings";
import { createWelcomeApproval } from "../src/worker/approvals/onboardingWelcome";
import type { ProposalContent } from "../src/worker/documents/proposal";
import { setMailDeps } from "../src/worker/mail/deps";
import { clientSig, proposal, readyToSend, seedDeal, sendDraft } from "./fixtures/documents";

const BASE = "https://clients.hellositeline.test";
const FAR = "2099-01-01T00:00:00.000Z";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type E = typeof env;

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

/** The owner's browser: the session cookie. */
const owner = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" } });
/** The owner's browser against a Worker with other bindings (an unset CLIENT_LINK_BASE, say). */
const ownerWith = (e: Partial<E>, method: string, path: string, body?: unknown) =>
  worker.fetch(new Request(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), { ...env, ...e } as E, ctx);
/** The client's browser: no cookie. */
const client = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://x/api/public/o/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
const page = async (token: string) => client("GET", token);

const ITEMS: NewItem[] = [
  { key: "logo", label: "Logo files", instructions: "Upload your logo", kind: "files", phase: 1 },
  { key: "about", label: "About text", instructions: "Tell us about you", kind: "text", phase: 1 },
  { key: "faq", label: "Common questions", instructions: "List them", kind: "text", phase: 2 },
];

/** A lead, its deal, a draft document and an onboarding (the welcome sent a day ago unless `welcomeSent` is false). */
async function seed(o: { welcomeSent?: boolean; test?: boolean } = {}) {
  const s = await seedDeal();
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
  const { onboarding } = await createOnboarding(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "build", test: o.test ?? false, items: ITEMS });
  if (o.welcomeSent !== false) {
    const at = new Date(Date.now() - 86_400_000).toISOString();
    await markWelcomeSent(env.DB, onboarding.id, { sentAt: at, questionnaireDueAt: at, phaseDue: { 1: at, 2: at } });
  }
  return { ...s, documentId: doc.id, id: onboarding.id, token: onboarding.token };
}
const item = async (id: string, key: string) => (await listItems(env.DB, id)).find((i) => i.key === key)!;

const pkg = (key: ProposalContent["packages"][number]["key"], name: string): ProposalContent["packages"][number] => ({ key, version: 1, name, priceLine: "$1,000", includes: [] });
/** A deal with a signed proposal (and no onboarding yet): paid, not paid, or a test copy. */
async function signedDeal(o: { paid?: boolean; test?: boolean; contactEmail?: string } = {}) {
  const s = await seedDeal();
  const base = proposal();
  const content: ProposalContent = { ...base, packages: [pkg("starter_site", "Starter Site"), pkg("care", "Care")], header: { ...base.header, contactEmail: o.contactEmail ?? base.header.contactEmail } };
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content, test: o.test });
  const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: FAR });
  expect(await signDocument(env.DB, doc.id, clientSig(hash), "2026-12-02T09:00:00.000Z")).toBe("signed");
  if (o.paid) await setPaid(env.DB, doc.id, "2026-12-03T09:00:00.000Z");
  return { ...s, doc: (await getDocument(env.DB, doc.id))! };
}

describe("owner onboarding routes", () => {
  it("all routes are 401 without a session", async () => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/deals/x/onboarding"], ["POST", "/deals/x/onboarding/start"], ["POST", "/deals/x/onboarding/test"],
      ["POST", "/onboardings/x/welcome"], ["PATCH", "/onboardings/x", { kickoffAt: null }], ["POST", "/onboardings/x/items", { label: "a", instructions: "b", kind: "text", phase: 1 }],
      ["PATCH", "/onboarding-items/x", { status: "accepted" }], ["GET", "/onboarding-files/x"],
      ["POST", "/onboardings/x/link/revoke"], ["POST", "/onboardings/x/link/new"], ["POST", "/onboardings/x/close"],
    ];
    for (const [m, p, b] of calls) expect((await owner(m, p, b, false)).status, `${m} ${p}`).toBe(401);
  });

  describe("GET /deals/:id/onboarding", () => {
    it("returns null onboarding for a deal that has none", async () => {
      const s = await seedDeal();
      const res = await owner("GET", `/deals/${s.dealId}/onboarding`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        onboarding: null, stage: null, items: [], answers: {}, questions: [], link: null, welcomeApproval: null, silentDays: 0, canStart: false, canStartTest: false,
      });
      expect((await owner("GET", "/deals/nope/onboarding")).status).toBe(404);
    });

    it("says whether a real or a test onboarding can be started", async () => {
      const unpaid = await signedDeal();
      expect(await (await owner("GET", `/deals/${unpaid.dealId}/onboarding`)).json()).toMatchObject({ onboarding: null, canStart: false, canStartTest: true });
      const paid = await signedDeal({ paid: true });
      expect(await (await owner("GET", `/deals/${paid.dealId}/onboarding`)).json()).toMatchObject({ canStart: true, canStartTest: true });
      const test = await signedDeal({ paid: true, test: true });
      expect(await (await owner("GET", `/deals/${test.dealId}/onboarding`)).json()).toMatchObject({ canStart: false, canStartTest: true });
    });

    it("returns the state: stage, items with their files, answers, questions, the link, the welcome approval and the silence", async () => {
      const s = await seed();
      await env.DB.prepare(`INSERT INTO onboarding_answers (onboarding_id, question_id, answer, updated_at) VALUES (?, 'business', 'We fix pipes <b>fast</b>', ?)`).bind(s.id, new Date().toISOString()).run();
      const logo = await item(s.id, "logo");
      await env.RAW.put("onboarding/x/logo-1", new Uint8Array([1]));
      await addFile(env.DB, { id: "f1", itemId: logo.id, r2Key: "onboarding/x/logo-1", fileName: "logo.png", contentType: "image/png", sizeBytes: 1, now: new Date().toISOString() });
      const a = await createWelcomeApproval(env, (await getOnboarding(env.DB, s.id))!);

      const body = await (await owner("GET", `/deals/${s.dealId}/onboarding`)).json<any>();
      expect(body.onboarding).toMatchObject({ id: s.id, dealId: s.dealId, kind: "build", test: false });
      expect(body.stage).toBe("questionnaire");
      expect(body.silentDays).toBe(1);
      expect(body.link).toBe(`${BASE}/o/${s.token}`);
      expect(body.answers).toEqual({ business: "We fix pipes <b>fast</b>" });
      expect(body.questions.length).toBeGreaterThan(5);
      expect(body.welcomeApproval).toEqual({ id: a.id, status: "pending" });
      expect(body.items.map((i: any) => i.key)).toEqual(["logo", "about", "faq"]);
      expect(body.items[0].files).toEqual([{ id: "f1", itemId: logo.id, fileName: "logo.png", contentType: "image/png", sizeBytes: 1, uploadedAt: expect.any(String) }]);
      expect(body.items[1].files).toEqual([]);
      // The object key and the bare token are not sent: the link is the one way in.
      expect(JSON.stringify(body)).not.toContain("onboarding/x/logo-1");
      expect(body.onboarding.token).toBeUndefined();
      expect(JSON.stringify(body.onboarding)).not.toContain(s.token);
    });

    it("has no link when the client base is unset or the link is revoked", async () => {
      const s = await seed();
      const noBase = await (await ownerWith({ CLIENT_LINK_BASE: undefined }, "GET", `/deals/${s.dealId}/onboarding`)).json<any>();
      expect(noBase.link).toBeNull();
      await owner("POST", `/onboardings/${s.id}/link/revoke`);
      expect((await (await owner("GET", `/deals/${s.dealId}/onboarding`)).json<any>()).link).toBeNull();
    });
  });

  describe("starting", () => {
    it("test start is 409 with no signed document", async () => {
      const s = await seedDeal();
      const none = await owner("POST", `/deals/${s.dealId}/onboarding/test`);
      expect(none.status).toBe(409);
      expect((await none.json<any>()).error).toMatch(/signed/);
      expect(await getOnboardingForDeal(env.DB, s.dealId)).toBeNull();
      const draftOnly = await seed();
      expect((await owner("POST", `/deals/${draftOnly.dealId}/onboarding/test`)).status).toBe(409); // one already exists
      expect((await owner("POST", "/deals/nope/onboarding/test")).status).toBe(404);
    });

    it("a test start makes a test onboarding and a welcome for the owner only", async () => {
      await readyToSend();
      const s = await signedDeal();
      const res = await owner("POST", `/deals/${s.dealId}/onboarding/test`);
      expect(res.status).toBe(201);
      const body = await res.json<any>();
      expect(body.onboarding).toMatchObject({ test: true, dealId: s.dealId, documentId: s.doc.id });
      expect(body.welcomeApproval.status).toBe("pending");
      expect(body.items.length).toBeGreaterThan(0);
      expect((await owner("POST", `/deals/${s.dealId}/onboarding/test`)).status).toBe(409);
    });

    it("a real start needs a signed, paid, non-test proposal", async () => {
      await readyToSend();
      const unpaid = await signedDeal();
      const r1 = await owner("POST", `/deals/${unpaid.dealId}/onboarding/start`);
      expect(r1.status).toBe(409);
      expect((await r1.json<any>()).error).toMatch(/deposit/i);
      const testDoc = await signedDeal({ paid: true, test: true });
      expect((await owner("POST", `/deals/${testDoc.dealId}/onboarding/start`)).status).toBe(409);
      const none = await seedDeal();
      expect((await owner("POST", `/deals/${none.dealId}/onboarding/start`)).status).toBe(409);
      expect((await owner("POST", "/deals/nope/onboarding/start")).status).toBe(404);
      expect(await getOnboardingForDeal(env.DB, unpaid.dealId)).toBeNull();
    });

    it("a real start makes the onboarding and one welcome, and doing it again changes nothing", async () => {
      await readyToSend();
      const s = await signedDeal({ paid: true });
      const first = await owner("POST", `/deals/${s.dealId}/onboarding/start`);
      expect(first.status).toBe(201);
      const a = await first.json<any>();
      expect(a.onboarding).toMatchObject({ test: false, dealId: s.dealId, documentId: s.doc.id, welcomeSentAt: null });
      expect(a.welcomeApproval.status).toBe("pending");
      const second = await owner("POST", `/deals/${s.dealId}/onboarding/start`);
      expect(second.status).toBe(200);
      const again = await second.json<any>();
      expect(again.onboarding.id).toBe(a.onboarding.id);
      expect(again.welcomeApproval.id).toBe(a.welcomeApproval.id);
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'onboarding.welcome' AND record_id = ?`).bind(s.dealId).first<{ n: number }>();
      expect(n!.n).toBe(1);
    });

    it("a real start says why when the client link base or the contact email is missing", async () => {
      await readyToSend();
      const s = await signedDeal({ paid: true });
      const res = await ownerWith({ CLIENT_LINK_BASE: undefined }, "POST", `/deals/${s.dealId}/onboarding/start`);
      expect(res.status).toBe(409);
      expect((await res.json<any>()).error).toMatch(/CLIENT_LINK_BASE/);
      expect(await getOnboardingForDeal(env.DB, s.dealId)).toBeNull();
      const blank = await signedDeal({ paid: true, contactEmail: " " });
      const res2 = await owner("POST", `/deals/${blank.dealId}/onboarding/start`);
      expect(res2.status).toBe(409);
      expect((await res2.json<any>()).error).toMatch(/contact email/);
    });
  });

  describe("the welcome", () => {
    it("makes a new approval when none is waiting and the welcome is unsent, and not twice", async () => {
      await readyToSend();
      const s = await seed({ welcomeSent: false });
      const first = await owner("POST", `/onboardings/${s.id}/welcome`);
      expect(first.status).toBe(200);
      const a = await first.json<any>();
      expect(a.welcomeApproval.status).toBe("pending");
      const second = await (await owner("POST", `/onboardings/${s.id}/welcome`)).json<any>();
      expect(second.welcomeApproval.id).toBe(a.welcomeApproval.id);
      await env.DB.prepare(`UPDATE approvals SET status = 'rejected' WHERE id = ?`).bind(a.welcomeApproval.id).run();
      const third = await (await owner("POST", `/onboardings/${s.id}/welcome`)).json<any>();
      expect(third.welcomeApproval.id).not.toBe(a.welcomeApproval.id);
      expect(third.welcomeApproval.status).toBe("pending");
    });

    it("is 409 once the welcome is sent, after close, with no client base, and 404 for an unknown onboarding", async () => {
      const sent = await seed();
      expect((await owner("POST", `/onboardings/${sent.id}/welcome`)).status).toBe(409);
      const closed = await seed({ welcomeSent: false });
      await closeOnboarding(env.DB, closed.id, new Date().toISOString());
      expect((await owner("POST", `/onboardings/${closed.id}/welcome`)).status).toBe(409);
      const noBase = await seed({ welcomeSent: false });
      const res = await ownerWith({ CLIENT_LINK_BASE: undefined }, "POST", `/onboardings/${noBase.id}/welcome`);
      expect(res.status).toBe(409);
      expect((await res.json<any>()).error).toMatch(/CLIENT_LINK_BASE/);
      expect((await owner("POST", "/onboardings/nope/welcome")).status).toBe(404);
    });
  });

  describe("PATCH /onboardings/:id", () => {
    const patch = (id: string, body: unknown) => owner("PATCH", `/onboardings/${id}`, body);

    it("video link must be https and carry no credentials", async () => {
      const s = await seed();
      const bad = [
        "http://youtu.be/abc", "ftp://example.com/v", "javascript:alert(1)", "//example.com/v", "not a url", "https://", "https://user@example.com/v", "https://user:pw@example.com/v",
        "https://example.com/v?password=hunter2", "https://example.com/v?token=abc", "https://example.com/v?key=abc", "https://example.com/v?api_key=abc", "https://example.com/v?access_token=abc",
        "https://example.com/v?x=1&PASSWORD=abc", "https://example.com/v#token=abc", "https://example.com/v with space", `https://example.com/${"a".repeat(300)}`,
        "https://example.com/v\u202E", "https://exa\u200Bmple.com/v", 5, true,
      ];
      for (const v of bad) {
        const res = await patch(s.id, { welcomeVideoUrl: v });
        expect(res.status, String(v)).toBe(400);
        expect((await res.json<any>()).fields).toHaveProperty("welcomeVideoUrl");
      }
      expect((await getOnboarding(env.DB, s.id))!.welcomeVideoUrl).toBeNull();

      const ok = await patch(s.id, { welcomeVideoUrl: "  https://www.loom.com/share/abc123?sid=1f2e  " });
      expect(ok.status).toBe(200);
      expect((await ok.json<any>()).onboarding.welcomeVideoUrl).toBe("https://www.loom.com/share/abc123?sid=1f2e");
      expect((await getOnboarding(env.DB, s.id))!.welcomeVideoUrl).toBe("https://www.loom.com/share/abc123?sid=1f2e");
      // Null (and blank) clear it.
      expect((await patch(s.id, { welcomeVideoUrl: null })).status).toBe(200);
      expect((await getOnboarding(env.DB, s.id))!.welcomeVideoUrl).toBeNull();
      await patch(s.id, { welcomeVideoUrl: "https://youtu.be/abc" });
      expect((await patch(s.id, { welcomeVideoUrl: "   " })).status).toBe(200);
      expect((await getOnboarding(env.DB, s.id))!.welcomeVideoUrl).toBeNull();
    });

    it("kickoffAt must be a real time", async () => {
      const s = await seed();
      for (const v of ["tomorrow", "2026-12-10", "2026-12-10 10:00", "2026-02-31T10:00:00Z", "2026-13-01T10:00:00Z", "2026-12-10T25:00:00Z", "2026-12-10T10:00:00", "", 5, true]) {
        const res = await patch(s.id, { kickoffAt: v });
        expect(res.status, String(v)).toBe(400);
        expect((await res.json<any>()).fields).toHaveProperty("kickoffAt");
      }
      expect((await getOnboarding(env.DB, s.id))!.kickoffAt).toBeNull();
      const ok = await patch(s.id, { kickoffAt: "2026-12-10T10:30:00-08:00" });
      expect(ok.status).toBe(200);
      expect((await ok.json<any>()).onboarding.kickoffAt).toBe("2026-12-10T18:30:00.000Z");
      expect((await patch(s.id, { kickoffAt: "2026-12-11T09:00:00.000Z" })).status).toBe(200);
      expect((await getOnboarding(env.DB, s.id))!.kickoffAt).toBe("2026-12-11T09:00:00.000Z");
      expect((await patch(s.id, { kickoffAt: null })).status).toBe(200);
      expect((await getOnboarding(env.DB, s.id))!.kickoffAt).toBeNull();
    });

    it("a field left out is not touched, an empty body or an unknown field is 400, an unknown onboarding is 404", async () => {
      const s = await seed();
      await patch(s.id, { welcomeVideoUrl: "https://youtu.be/abc", kickoffAt: "2026-12-11T09:00:00.000Z" });
      await patch(s.id, { kickoffAt: null });
      expect((await getOnboarding(env.DB, s.id))!.welcomeVideoUrl).toBe("https://youtu.be/abc");
      expect((await patch(s.id, {})).status).toBe(400);
      expect((await patch(s.id, { token: "x" })).status).toBe(400);
      expect((await patch("nope", { kickoffAt: null })).status).toBe(404);
    });

    it("both are refused after close", async () => {
      const s = await seed();
      await closeOnboarding(env.DB, s.id, new Date().toISOString());
      expect((await patch(s.id, { welcomeVideoUrl: "https://youtu.be/abc" })).status).toBe(409);
      expect((await patch(s.id, { kickoffAt: "2026-12-11T09:00:00.000Z" })).status).toBe(409);
      expect((await getOnboarding(env.DB, s.id))!.welcomeVideoUrl).toBeNull();
    });

    it("changing the video after the welcome went out is allowed and sends nothing", async () => {
      const mail = await readyToSend();
      const s = await seed();
      expect((await patch(s.id, { welcomeVideoUrl: "https://youtu.be/abc" })).status).toBe(200);
      expect(mail.sent).toEqual([]);
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE record_id = ?`).bind(s.dealId).first<{ n: number }>();
      expect(n!.n).toBe(0);
    });
  });

  describe("items", () => {
    const setStatus = (id: string, status: unknown) => owner("PATCH", `/onboarding-items/${id}`, { status });

    it("accept moves an item from received to accepted, and Not needed and Ask again move it too", async () => {
      const s = await seed();
      const about = await item(s.id, "about");
      await saveItemText(env.DB, about.id, "We started in 1999.", new Date().toISOString());
      expect((await item(s.id, "about")).status).toBe("received");

      const accepted = await setStatus(about.id, "accepted");
      expect(accepted.status).toBe(200);
      expect((await accepted.json<any>()).item).toMatchObject({ id: about.id, status: "accepted" });
      expect((await item(s.id, "about")).status).toBe("accepted");
      // Nothing the client says on the page moves it back (the owner's word stands) until he asks again.
      expect((await client("PUT", `${s.token}/items/${about.id}/text`, { text: "changed my mind" })).status).toBe(200);
      expect((await item(s.id, "about")).status).toBe("accepted");

      expect((await setStatus(about.id, "waiting")).status).toBe(200);
      expect((await item(s.id, "about")).status).toBe("waiting");
      expect((await setStatus(about.id, "not_applicable")).status).toBe(200);
      expect((await item(s.id, "about")).status).toBe("not_applicable");
    });

    it("Ask again lets the client upload to an accepted item again", async () => {
      const s = await seed();
      const logo = await item(s.id, "logo");
      await setItemStatus(env.DB, logo.id, "accepted");
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      const send = () => {
        const f = new FormData();
        f.set("file", new File([png], "logo.png", { type: "image/png" }));
        return SELF.fetch(`https://x/api/public/o/${s.token}/items/${logo.id}/files`, { method: "POST", body: f });
      };
      expect((await send()).status).toBe(409);
      await setStatus(logo.id, "waiting");
      expect((await send()).status).toBe(201);
      expect((await item(s.id, "logo")).status).toBe("received");
    });

    it("refuses a status the owner does not set, an unknown item, a closed onboarding", async () => {
      const s = await seed();
      const about = await item(s.id, "about");
      for (const v of ["received", "done", "", null, 1]) expect((await setStatus(about.id, v)).status, String(v)).toBe(400);
      expect((await owner("PATCH", `/onboarding-items/${about.id}`, { status: "accepted", extra: 1 })).status).toBe(400);
      expect((await setStatus("nope", "accepted")).status).toBe(404);
      await closeOnboarding(env.DB, s.id, new Date().toISOString());
      expect((await setStatus(about.id, "accepted")).status).toBe(409);
      expect((await item(s.id, "about")).status).toBe("waiting");
    });

    it("a custom item shows on the client page", async () => {
      const s = await seed();
      const res = await owner("POST", `/onboardings/${s.id}/items`, { label: "  Gate code photo ", instructions: "A photo of the gate.", kind: "files", phase: 2, dueAt: "2026-12-20T00:00:00.000Z" });
      expect(res.status).toBe(201);
      const made = (await res.json<any>()).item;
      expect(made).toMatchObject({ label: "Gate code photo", instructions: "A photo of the gate.", kind: "files", phase: 2, custom: true, status: "waiting", dueAt: "2026-12-20T00:00:00.000Z", files: [] });
      expect(made.key).toMatch(/^custom_[0-9a-f]{12}$/);

      const shown = await (await page(s.token)).json<any>();
      expect(shown.items.at(-1)).toMatchObject({ id: made.id, label: "Gate code photo", kind: "files", phase: 2, status: "waiting" });
      expect(shown.progress.total).toBe(5);
    });

    it("two custom items with the same words get different keys", async () => {
      const s = await seed();
      const body = { label: "Same", instructions: "", kind: "text", phase: 1 };
      const a = (await (await owner("POST", `/onboardings/${s.id}/items`, body)).json<any>()).item;
      const b = (await (await owner("POST", `/onboardings/${s.id}/items`, body)).json<any>()).item;
      expect(a.key).not.toBe(b.key);
      expect(b.position).toBeGreaterThan(a.position);
    });

    it("validates a custom item: label 1 to 120, instructions up to 600, kind, phase, due date", async () => {
      const s = await seed();
      const ok = { label: "x", instructions: "y", kind: "text", phase: 1 };
      const bad = [
        { ...ok, label: "" }, { ...ok, label: "   " }, { ...ok, label: "x".repeat(121) }, { ...ok, instructions: "y".repeat(601) }, { ...ok, kind: "video" }, { ...ok, phase: 3 },
        { ...ok, phase: "1" }, { ...ok, dueAt: "soon" }, { ...ok, key: "logo" }, { instructions: "y", kind: "text", phase: 1 },
      ];
      for (const b of bad) expect((await owner("POST", `/onboardings/${s.id}/items`, b)).status, JSON.stringify(b)).toBe(400);
      expect((await owner("POST", `/onboardings/${s.id}/items`, { ...ok, label: "x".repeat(120), instructions: "y".repeat(600) })).status).toBe(201);
      expect((await owner("POST", "/onboardings/nope/items", ok)).status).toBe(404);
      await closeOnboarding(env.DB, s.id, new Date().toISOString());
      expect((await owner("POST", `/onboardings/${s.id}/items`, ok)).status).toBe(409);
    });
  });

  describe("GET /onboarding-files/:id", () => {
    const store = async (s: { id: string }, o: { name: string; type?: string; key?: string; put?: boolean }) => {
      const itemRow = await item(s.id, "logo");
      const key = o.key ?? `onboarding/${s.id}/${itemRow.id}/${crypto.randomUUID()}`;
      if (o.put !== false) await env.RAW.put(key, new TextEncoder().encode("%PDF-1.7 hello"), { httpMetadata: { contentType: "text/html" } });
      const id = crypto.randomUUID();
      await addFile(env.DB, { id, itemId: itemRow.id, r2Key: key, fileName: o.name, contentType: o.type ?? "application/pdf", sizeBytes: 14, now: new Date().toISOString() });
      return id;
    };

    it("a file download is an attachment with nosniff", async () => {
      const s = await seed();
      const id = await store(s, { name: `Résumé "final" (1)'s*.pdf` });
      const res = await owner("GET", `/onboarding-files/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22%20%281%29%27s%2A.pdf");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(await res.text()).toBe("%PDF-1.7 hello");
    });

    it("the stored name is cleaned again on the way out, and the type is the stored one", async () => {
      const s = await seed();
      const id = await store(s, { name: "..\\..\\evil\r\nSet-Cookie: x=1\u202E.png", type: "image/png" });
      const res = await owner("GET", `/onboarding-files/${id}`);
      expect(res.status).toBe(200);
      const disposition = res.headers.get("content-disposition")!;
      expect(disposition).toMatch(/^attachment; filename\*=UTF-8''[A-Za-z0-9%._-]+$/);
      expect(decodeURIComponent(disposition.split("''")[1])).toBe("evil Set-Cookie: x=1.png");
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.has("set-cookie")).toBe(false);
    });

    it("a type that is not a plain media type is served as a download of unknown bytes", async () => {
      const s = await seed();
      const id = await store(s, { name: "a.txt", type: "text/html\r\nx-evil: 1" });
      const res = await owner("GET", `/onboarding-files/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.has("x-evil")).toBe(false);
    });

    it("is 404 for an unknown file and for a row whose object is gone", async () => {
      const s = await seed();
      expect((await owner("GET", "/onboarding-files/nope")).status).toBe(404);
      const gone = await store(s, { name: "a.pdf", put: false });
      expect((await owner("GET", `/onboarding-files/${gone}`)).status).toBe(404);
    });
  });

  describe("the link", () => {
    it("revoke makes the client page 404 and new link makes it live on a different token", async () => {
      const s = await seed();
      expect((await page(s.token)).status).toBe(200);

      const revoked = await owner("POST", `/onboardings/${s.id}/link/revoke`);
      expect(revoked.status).toBe(200);
      expect((await revoked.json<any>()).onboarding.revokedAt).toBeTruthy();
      expect((await page(s.token)).status).toBe(404);
      expect((await client("PUT", `${s.token}/answers`, { answers: { business: "x" } })).status).toBe(404);

      const fresh = await owner("POST", `/onboardings/${s.id}/link/new`);
      expect(fresh.status).toBe(200);
      const body = await fresh.json<any>();
      const o = (await getOnboarding(env.DB, s.id))!;
      expect(o.token).not.toBe(s.token);
      expect(o.revokedAt).toBeNull();
      expect(body.link).toBe(`${BASE}/o/${o.token}`);
      expect(body.onboarding.revokedAt).toBeNull();
      expect(JSON.stringify(body.onboarding)).not.toContain(o.token);
      expect((await page(o.token)).status).toBe(200);
      expect((await page(s.token)).status).toBe(404); // the old link stays dead
    });

    it("a new link is not made when there is no client base to build it on, and the old one keeps working", async () => {
      const s = await seed();
      const res = await ownerWith({ CLIENT_LINK_BASE: undefined }, "POST", `/onboardings/${s.id}/link/new`);
      expect(res.status).toBe(409);
      expect((await getOnboarding(env.DB, s.id))!.token).toBe(s.token);
    });

    it("unknown onboardings are 404", async () => {
      for (const p of ["link/revoke", "link/new", "close"]) expect((await owner("POST", `/onboardings/nope/${p}`)).status, p).toBe(404);
    });
  });

  describe("close", () => {
    it("closing makes client writes 409 and the page read-only", async () => {
      const s = await seed();
      const itemRow = await item(s.id, "about");
      const res = await owner("POST", `/onboardings/${s.id}/close`);
      expect(res.status).toBe(200);
      const closedAt = (await res.json<any>()).onboarding.closedAt;
      expect(closedAt).toBeTruthy();

      expect((await client("PUT", `${s.token}/answers`, { answers: { business: "We fix pipes." } })).status).toBe(409);
      expect((await client("POST", `${s.token}/submit`, {})).status).toBe(409);
      expect((await client("PUT", `${s.token}/items/${itemRow.id}/text`, { text: "late" })).status).toBe(409);
      const shown = await (await page(s.token)).json<any>();
      expect(shown.closed).toBe(true);
      expect(shown.stage).toBe("complete");

      // Closing again keeps the first time.
      expect((await (await owner("POST", `/onboardings/${s.id}/close`)).json<any>()).onboarding.closedAt).toBe(closedAt);
      const note = (await listActivity(env.DB, s.businessId)).filter((a) => a.kind === "note" && /onboarding closed/.test(a.detail ?? ""));
      expect(note).toHaveLength(1);
    });
  });
});
