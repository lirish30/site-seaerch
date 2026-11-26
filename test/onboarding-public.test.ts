import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/worker/index";
import { listActivity } from "../src/worker/db/activity";
import { createDraft } from "../src/worker/db/documents";
import {
  addFile, closeOnboarding, createOnboarding, getAnswers, getOnboarding, listItems, markWelcomeSent, saveAnswers, setItemStatus, setOwnerFields, setRevoked, submitQuestionnaire,
  type NewItem,
} from "../src/worker/db/onboardings";
import { QUESTIONS } from "../src/worker/onboarding/templates";
import { saveClientAnswers, saveClientItemText, submitClientQuestionnaire } from "../src/worker/onboarding/public";
import { proposal, seedDeal } from "./fixtures/documents";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type E = typeof env;
const DAY = 86_400_000;

const ITEMS: NewItem[] = [
  { key: "logo", label: "Logo files", instructions: "Upload your logo", kind: "files", phase: 1 },
  { key: "about", label: "About text", instructions: "Tell us about you", kind: "text", phase: 1 },
  { key: "faq", label: "Common questions", instructions: "List them", kind: "text", phase: 2 },
];

/** The Worker as a client's browser reaches it: no cookie. */
const call = (path: string, init: RequestInit = {}, e: Partial<E> = {}) => worker.fetch(new Request(`https://x/api${path}`, init), { ...env, ...e } as E, ctx);
const json = (method: string, path: string, body: unknown, e: Partial<E> = {}) =>
  call(path, { method, headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }, e);
const get = (token: string, e: Partial<E> = {}) => call(`/public/o/${token}`, {}, e);
const put = (token: string, answers: unknown) => json("PUT", `/public/o/${token}/answers`, { answers });
const submit = (token: string) => json("POST", `/public/o/${token}/submit`, {});
const putText = (token: string, itemId: string, text: unknown) => json("PUT", `/public/o/${token}/items/${itemId}/text`, { text });

/** All required questions of a build onboarding, answered. */
const FULL: Record<string, string> = {
  business: "We fix pipes for homeowners.", top_services: "Drain cleaning, water heaters, repipes.", service_area: "Tacoma and Gig Harbor",
  different: "We answer the phone.", sites_you_like: "example.com for its clear layout.", voice_words: "plain, friendly, careful",
  brand_assets: "A logo only", who_updates: "I will", contact_times: "Weekdays after 3",
  ideal_customer: "Homeowners with older houses.", visitor_actions: "Call us first, then request a quote.", pages_wanted: "Home, About, Drains, Water heaters, Contact", competitor_sites: "example.com is clear, but its quote form is long.", look_and_feel: "Clean and simple, warm and local.", public_details: "Ace Plumbing, 12 Main St, 555-0100, hello@ace.test, Mon to Fri 8 to 5",
};

/** A lead with a deal, a draft document (the onboarding hangs off all three) and an onboarding; the welcome is sent `welcomeAgoDays` ago when given. */
async function seed(o: { kind?: "build" | "light"; items?: NewItem[]; welcomeAgoDays?: number | null; test?: boolean } = {}) {
  const s = await seedDeal();
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
  const { onboarding } = await createOnboarding(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: o.kind ?? "build", test: o.test ?? false, items: o.items ?? ITEMS,
  });
  const ago = o.welcomeAgoDays === undefined ? 1 : o.welcomeAgoDays;
  if (ago !== null) {
    const sentAt = new Date(Date.now() - ago * DAY).toISOString();
    await markWelcomeSent(env.DB, onboarding.id, { sentAt, questionnaireDueAt: sentAt, phaseDue: { 1: sentAt, 2: sentAt } });
  }
  return { ...s, documentId: doc.id, id: onboarding.id, token: onboarding.token };
}

const rows = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind);
const item = async (id: string, key: string) => (await listItems(env.DB, id)).find((i) => i.key === key)!;

/** A database that fails the test the moment anything touches it. */
const poisoned = (touched: string[]): D1Database =>
  new Proxy({} as D1Database, { get: (_t, k) => { touched.push(String(k)); throw new Error(`the database was touched (${String(k)})`); } });

describe("the page", () => {
  it("an unknown, malformed or revoked token is the same 404", async () => {
    const a = await seed();
    await setRevoked(env.DB, a.id, true, new Date().toISOString());
    const answers = [
      await get(a.token), // revoked
      await get("B".repeat(43)), // unknown
      await get("short"), // malformed
      await get(`${"B".repeat(42)}!`), // malformed, right length
      await put(a.token, { business: "x" }),
      await submit(a.token),
      await putText(a.token, "x", "hi"),
    ];
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    for (const r of answers) expect(await r.json()).toEqual({ error: "not found" });
  });

  it("a malformed token never reaches the database", async () => {
    const touched: string[] = [];
    const e = { DB: poisoned(touched) } as Partial<E>;
    for (const t of ["short", "A".repeat(44), `${"A".repeat(42)}.`]) {
      expect((await get(t, e)).status).toBe(404);
      expect((await json("PUT", `/public/o/${t}/answers`, { answers: {} }, e)).status).toBe(404);
      expect((await json("POST", `/public/o/${t}/submit`, {}, e)).status).toBe(404);
      expect((await json("PUT", `/public/o/${t}/items/x/text`, { text: "" }, e)).status).toBe(404);
    }
    expect(touched).toEqual([]);
  });

  it("the page never includes the token's other onboardings or the owner's notes", async () => {
    const a = await seed();
    const b = await seed();
    await env.DB.prepare(`UPDATE businesses SET name = 'Other Co Secret' WHERE id = ?`).bind(b.businessId).run();
    await env.DB.prepare(`UPDATE deals SET notes = ? WHERE id = ?`).bind(JSON.stringify({ note: "owner-only-note: they haggle" }), a.dealId).run();
    await setOwnerFields(env.DB, a.id, { welcomeVideoUrl: "https://video.test/welcome", kickoffAt: "2027-01-05T18:00:00.000Z" });
    const res = await get(a.token);
    expect(res.status).toBe(200);
    const page = await res.json<any>();
    expect(Object.keys(page).sort()).toEqual(["businessName", "closed", "contactFirstName", "items", "kickoffAt", "progress", "questionnaire", "stage", "timezone", "welcomeVideoUrl"]);
    expect(page).toMatchObject({
      businessName: "Ace Plumbing", contactFirstName: "Pat", kickoffAt: "2027-01-05T18:00:00.000Z", welcomeVideoUrl: "https://video.test/welcome", closed: false, stage: "questionnaire",
    });
    expect(typeof page.timezone).toBe("string");
    expect(Object.keys(page.questionnaire).sort()).toEqual(["answers", "dueAt", "questions", "submittedAt"]);
    expect(page.questionnaire.questions.map((q: { id: string }) => q.id)).toEqual(QUESTIONS.map((q) => q.id));
    expect(Object.keys(page.items[0]).sort()).toEqual(["dueAt", "files", "id", "instructions", "key", "kind", "label", "phase", "status", "textValue"]);
    const text = JSON.stringify(page);
    for (const secret of [a.token, b.token, b.id, b.businessId, a.businessId, a.dealId, a.documentId, a.id, "Other Co Secret", "owner-only-note", "pat@ace.test"]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("a light onboarding asks only its own questions and has no items", async () => {
    const a = await seed({ kind: "light", items: [] });
    const page = await (await get(a.token)).json<any>();
    expect(page.questionnaire.questions.map((q: { id: string }) => q.id)).toEqual(["business", "top_services", "service_area", "different", "sites_you_like", "voice_words", "how_found"]);
    expect(page.items).toEqual([]);
  });

  it("shows the answers, text, files and progress as they stand", async () => {
    const a = await seed();
    await saveAnswers(env.DB, a.id, { business: "Pipes" }, new Date().toISOString());
    const about = await item(a.id, "about");
    const logo = await item(a.id, "logo");
    await env.DB.prepare(`UPDATE onboarding_items SET text_value = 'hello', status = 'received' WHERE id = ?`).bind(about.id).run();
    await addFile(env.DB, { id: "f1", itemId: logo.id, r2Key: "secret/r2/key", fileName: "logo.svg", contentType: "image/svg+xml", sizeBytes: 1234, now: new Date().toISOString() });
    const page = await (await get(a.token)).json<any>();
    expect(page.questionnaire.answers).toEqual({ business: "Pipes" });
    expect(page.items.map((i: { key: string }) => i.key)).toEqual(["logo", "about", "faq"]);
    expect(page.items[0]).toMatchObject({ key: "logo", status: "received", textValue: null, files: [{ id: "f1", fileName: "logo.svg", sizeBytes: 1234 }] });
    expect(page.items[1]).toMatchObject({ key: "about", status: "received", textValue: "hello", files: [] });
    expect(JSON.stringify(page)).not.toContain("secret/r2/key");
    // the questionnaire counts as one step, and each item that is no longer waiting as one
    expect(page.progress).toEqual({ done: 2, total: 4 });
  });

  it("a closed onboarding still reads, with closed: true", async () => {
    const a = await seed();
    await closeOnboarding(env.DB, a.id, new Date().toISOString());
    const res = await get(a.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ closed: true, stage: "complete" });
  });

  it("reading records nothing: no activity, no client-activity stamp", async () => {
    const a = await seed();
    const before = (await getOnboarding(env.DB, a.id))!;
    await get(a.token);
    await get(a.token);
    const after = (await getOnboarding(env.DB, a.id))!;
    expect(after.lastClientActivityAt).toBe(before.lastClientActivityAt);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect((await listActivity(env.DB, a.businessId)).filter((x) => x.kind.startsWith("onboarding_"))).toEqual([]);
  });
});

describe("answers", () => {
  it("answers autosave and read back", async () => {
    const a = await seed();
    const res = await put(a.token, { business: "  We fix pipes.  ", service_area: "Tacoma" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await getAnswers(env.DB, a.id)).toEqual({ business: "We fix pipes.", service_area: "Tacoma" });
    // a later save replaces the earlier text and keeps the rest
    await put(a.token, { business: "Pipes and drains." });
    expect((await (await get(a.token)).json<any>()).questionnaire.answers).toEqual({ business: "Pipes and drains.", service_area: "Tacoma" });
    expect((await getOnboarding(env.DB, a.id))!.lastClientActivityAt).not.toBeNull();
  });

  it("unknown question ids are dropped", async () => {
    const a = await seed();
    const raw = '{"answers":{"business":"x","nope":"y","__proto__":"z","constructor":"c","brand_assets":"No, I have neither"}}';
    expect((await json("PUT", `/public/o/${a.token}/answers`, raw)).status).toBe(200);
    expect(await getAnswers(env.DB, a.id)).toEqual({ business: "x", brand_assets: "No, I have neither" });
    // a question the kind does not ask is unknown too
    const l = await seed({ kind: "light", items: [] });
    expect((await put(l.token, { business: "x", brand_assets: "No, I have neither" })).status).toBe(200);
    expect(await getAnswers(env.DB, l.id)).toEqual({ business: "x" });
  });

  it("an answer with <script> is stored as text and the API returns it unchanged for escaping at render", async () => {
    const a = await seed();
    const xss = `<script>alert(1)</script> & "quotes"`;
    expect((await put(a.token, { business: xss })).status).toBe(200);
    expect(await getAnswers(env.DB, a.id)).toEqual({ business: xss });
    const res = await get(a.token);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json<any>()).questionnaire.answers.business).toBe(xss);
  });

  it("control and bidi characters are removed on the way in", async () => {
    const a = await seed();
    await put(a.token, { business: "a\u0000b‮c​d\r\ne" });
    expect(await getAnswers(env.DB, a.id)).toEqual({ business: "abcd\ne" });
  });

  it("5 KB in a short answer is refused", async () => {
    const a = await seed();
    const big = "x".repeat(5000);
    const res = await put(a.token, { service_area: big, business: "fine" });
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body).toEqual({ error: "invalid body", fields: ["service_area"] });
    expect(JSON.stringify(body)).not.toContain("xxxx");
    // nothing from the refused request was written, not even the good answer
    expect(await getAnswers(env.DB, a.id)).toEqual({});
  });

  it("a choice that is not one of the choices is refused by id", async () => {
    const a = await seed();
    const res = await put(a.token, { brand_assets: "<b>maybe</b>" });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "invalid body", fields: ["brand_assets"] });
    expect(body).not.toContain("maybe");
  });

  it("a password-looking answer is a 422 naming the question id and not echoing the text", async () => {
    const a = await seed();
    const res = await put(a.token, { domain_owner: "GoDaddy, password: hunter2hunter2", business: "fine" });
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "invalid body", fields: ["domain_owner"] });
    expect(body).not.toContain("hunter2");
    expect(await getAnswers(env.DB, a.id)).toEqual({});
  });

  it("a body that is not the expected shape is a 400, and a body that is too large a 413", async () => {
    const a = await seed();
    for (const bad of [{ answers: ["x"] }, { answers: { business: 5 } }, { answers: "x" }, {}, { answers: { business: "x" }, extra: 1 }, [], "null"]) {
      const r = await json("PUT", `/public/o/${a.token}/answers`, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await json("PUT", `/public/o/${a.token}/answers`, "not json")).status).toBe(400);
    expect((await put(a.token, { business: "x".repeat(200_000) })).status).toBe(413);
    expect(await getAnswers(env.DB, a.id)).toEqual({});
  });

  it("writes after close are 409", async () => {
    const a = await seed();
    const it = await item(a.id, "about");
    await closeOnboarding(env.DB, a.id, new Date().toISOString());
    const answers = await put(a.token, { business: "late" });
    expect(answers.status).toBe(409);
    expect((await submit(a.token)).status).toBe(409);
    expect((await putText(a.token, it.id, "late")).status).toBe(409);
    expect(await getAnswers(env.DB, a.id)).toEqual({});
    expect((await item(a.id, "about")).textValue).toBeNull();
  });

  it("once the questionnaire is submitted its answers are locked (409), while items still take text", async () => {
    const a = await seed();
    await saveAnswers(env.DB, a.id, FULL, new Date().toISOString());
    expect((await submit(a.token)).status).toBe(200);
    const locked = await put(a.token, { business: "changed my mind" });
    expect(locked.status).toBe(409);
    expect((await getAnswers(env.DB, a.id)).business).toBe(FULL.business);
    const about = await item(a.id, "about");
    expect((await putText(a.token, about.id, "still sending")).status).toBe(200);
  });
});

describe("submit", () => {
  it("with a required answer missing is a 400 listing ids", async () => {
    const a = await seed();
    await saveAnswers(env.DB, a.id, { business: "x" }, new Date().toISOString());
    const res = await submit(a.token);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; fields: string[] }>();
    expect(body.error).toBe("invalid body");
    expect(body.fields).toEqual(["top_services", "service_area", "different", "sites_you_like", "voice_words", "ideal_customer", "visitor_actions", "pages_wanted", "who_updates", "competitor_sites", "look_and_feel", "brand_assets", "public_details", "contact_times"]);
    expect((await getOnboarding(env.DB, a.id))!.questionnaireSubmittedAt).toBeNull();
    expect(await rows(a.businessId, "onboarding_submitted")).toEqual([]);
  });

  it("submits once, logs once, and moves the stage on", async () => {
    const a = await seed();
    await saveAnswers(env.DB, a.id, FULL, new Date().toISOString());
    const res = await submit(a.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const o = (await getOnboarding(env.DB, a.id))!;
    expect(o.questionnaireSubmittedAt).not.toBeNull();
    expect(await rows(a.businessId, "onboarding_submitted")).toHaveLength(1);
    const page = await (await get(a.token)).json<any>();
    expect(page).toMatchObject({ stage: "collecting", questionnaire: { submittedAt: o.questionnaireSubmittedAt } });
  });

  it("submit twice is already, not an error", async () => {
    const a = await seed();
    await saveAnswers(env.DB, a.id, FULL, new Date().toISOString());
    expect((await submit(a.token)).status).toBe(200);
    const first = (await getOnboarding(env.DB, a.id))!.questionnaireSubmittedAt;
    const again = await submit(a.token);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, already: true });
    expect((await getOnboarding(env.DB, a.id))!.questionnaireSubmittedAt).toBe(first);
    expect(await rows(a.businessId, "onboarding_submitted")).toHaveLength(1);
  });

  it("a light onboarding needs only the questions it asks", async () => {
    const a = await seed({ kind: "light", items: [] });
    await saveAnswers(env.DB, a.id, { business: "a", top_services: "b", service_area: "c", different: "d", sites_you_like: "e", voice_words: "f" }, new Date().toISOString());
    expect((await submit(a.token)).status).toBe(200);
  });
});

describe("item text", () => {
  it("saves the text, marks the item received, touches activity and logs once per item per day", async () => {
    const a = await seed();
    const about = await item(a.id, "about");
    const res = await putText(a.token, about.id, "  We started in 1998.  ");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await item(a.id, "about")).toMatchObject({ textValue: "We started in 1998.", status: "received" });
    expect((await putText(a.token, about.id, "We started in 1999.")).status).toBe(200);
    const faq = await item(a.id, "faq");
    await putText(a.token, faq.id, "Q: cost? A: depends.");
    const logged = (await rows(a.businessId, "onboarding_received")).map((r) => r.detail);
    expect(logged).toHaveLength(2);
    expect(logged.join("\n")).toContain("About text");
    expect(logged.join("\n")).toContain("Common questions");
    expect(logged.join("\n")).not.toContain("1998");
    // the same item on another day logs again
    const tomorrow = new Date(Date.now() + DAY);
    expect(await saveClientItemText(env as unknown as import("../src/worker/env").Env, a.token, about.id, "Third", tomorrow)).toEqual({ ok: true });
    expect(await rows(a.businessId, "onboarding_received")).toHaveLength(3);
  });

  it("emptying the text puts the item back to waiting", async () => {
    const a = await seed();
    const about = await item(a.id, "about");
    await putText(a.token, about.id, "hello");
    expect((await putText(a.token, about.id, "   ")).status).toBe(200);
    expect(await item(a.id, "about")).toMatchObject({ textValue: "", status: "waiting" });
  });

  it("text on an accepted or not-needed item is a 409 that changes nothing; Ask again reopens it", async () => {
    const a = await seed();
    const about = await item(a.id, "about");
    const faq = await item(a.id, "faq");
    await putText(a.token, about.id, "first");
    await setItemStatus(env.DB, about.id, "accepted");
    await setItemStatus(env.DB, faq.id, "not_applicable");
    const lastBefore = (await getOnboarding(env.DB, a.id))!.lastClientActivityAt;
    const received = (await rows(a.businessId, "onboarding_received")).length;
    for (const id of [about.id, faq.id]) {
      const res = await putText(a.token, id, "SECRET-ISH TEXT");
      expect(res.status).toBe(409);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: "this item is already settled" });
      expect(body).not.toContain("SECRET-ISH");
    }
    expect(await item(a.id, "about")).toMatchObject({ textValue: "first", status: "accepted" });
    expect(await item(a.id, "faq")).toMatchObject({ textValue: null, status: "not_applicable" });
    expect((await getOnboarding(env.DB, a.id))!.lastClientActivityAt).toBe(lastBefore);
    expect(await rows(a.businessId, "onboarding_received")).toHaveLength(received);
    // the owner's "Ask again" puts it back to waiting, and the client can write again
    await setItemStatus(env.DB, about.id, "waiting");
    expect((await putText(a.token, about.id, "second")).status).toBe(200);
    expect(await item(a.id, "about")).toMatchObject({ textValue: "second", status: "received" });
  });

  it("an item id from another onboarding is a 404", async () => {
    const a = await seed();
    const b = await seed();
    const theirs = await item(b.id, "about");
    const res = await putText(a.token, theirs.id, "mine now?");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect((await item(b.id, "about")).textValue).toBeNull();
    expect((await putText(a.token, "no-such-item", "x")).status).toBe(404);
  });

  it("text on a files item is a 400", async () => {
    const a = await seed();
    const logo = await item(a.id, "logo");
    const res = await putText(a.token, logo.id, "here is my logo");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid body" });
    expect((await item(a.id, "logo")).textValue).toBeNull();
  });

  it("more than 5000 characters is refused, text that is not text is a 400", async () => {
    const a = await seed();
    const about = await item(a.id, "about");
    const over = await putText(a.token, about.id, "y".repeat(5001));
    expect(over.status).toBe(400);
    expect(await over.text()).not.toContain("yyyy");
    expect((await putText(a.token, about.id, "y".repeat(5000))).status).toBe(200);
    for (const bad of [5, null, ["x"], undefined]) expect((await putText(a.token, about.id, bad)).status).toBe(400);
    expect((await json("PUT", `/public/o/${a.token}/items/${about.id}/text`, { text: "x", extra: 1 })).status).toBe(400);
  });

  it("a password-looking text is a 422 naming the item and not echoing the text", async () => {
    const a = await seed();
    const about = await item(a.id, "about");
    const res = await putText(a.token, about.id, "my login\npassword: hunter2hunter2");
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "invalid body", fields: [about.id] });
    expect(body).not.toContain("hunter2");
    expect((await item(a.id, "about")).textValue).toBeNull();
  });
});

describe("client activity", () => {
  it("a write after 14 days silence logs onboarding_resumed once and the stage leaves waiting_on_client", async () => {
    const a = await seed({ welcomeAgoDays: 20 });
    const before = await (await get(a.token)).json<any>();
    expect(before.stage).toBe("waiting_on_client");
    // reading does not wake it
    expect(await rows(a.businessId, "onboarding_resumed")).toEqual([]);
    expect((await put(a.token, { business: "back again" })).status).toBe(200);
    expect(await rows(a.businessId, "onboarding_resumed")).toHaveLength(1);
    expect((await put(a.token, { service_area: "Tacoma" })).status).toBe(200);
    const about = await item(a.id, "about");
    await putText(a.token, about.id, "more");
    expect(await rows(a.businessId, "onboarding_resumed")).toHaveLength(1);
    expect((await (await get(a.token)).json<any>()).stage).toBe("questionnaire");
  });

  it("every kind of write counts, and a write inside the window logs no resume", async () => {
    const a = await seed({ welcomeAgoDays: 3 });
    await put(a.token, { business: "x" });
    expect(await rows(a.businessId, "onboarding_resumed")).toEqual([]);
    const b = await seed({ welcomeAgoDays: 20 });
    await putText(b.token, (await item(b.id, "about")).id, "hi");
    expect(await rows(b.businessId, "onboarding_resumed")).toHaveLength(1);
    const c = await seed({ welcomeAgoDays: 20 });
    await saveAnswers(env.DB, c.id, FULL, new Date(Date.now() - 20 * DAY).toISOString());
    await submit(c.token);
    expect(await rows(c.businessId, "onboarding_resumed")).toHaveLength(1);
  });

  it("an answers write with nothing this form asks does not count as the client being here", async () => {
    const a = await seed({ welcomeAgoDays: 20 });
    const welcomeAt = (await getOnboarding(env.DB, a.id))!.welcomeSentAt;
    for (const answers of [{}, { not_a_question: "hello", another: "x" }]) {
      const res = await put(a.token, answers);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(await rows(a.businessId, "onboarding_resumed")).toEqual([]);
    expect((await getOnboarding(env.DB, a.id))!.lastClientActivityAt).toBe(welcomeAt);
    expect((await (await get(a.token)).json<any>()).stage).toBe("waiting_on_client");
    expect(await getAnswers(env.DB, a.id)).toEqual({});
  });

  it("a refused write does not count as the client being here", async () => {
    const a = await seed({ welcomeAgoDays: 20 });
    expect((await put(a.token, { domain_owner: "password: abcdefgh" })).status).toBe(422);
    expect((await put(a.token, { service_area: "z".repeat(400) })).status).toBe(400);
    expect((await json("PUT", `/public/o/${a.token}/answers`, "nope")).status).toBe(400);
    expect(await rows(a.businessId, "onboarding_resumed")).toEqual([]);
    expect((await getOnboarding(env.DB, a.id))!.lastClientActivityAt).toBe((await getOnboarding(env.DB, a.id))!.welcomeSentAt);
  });

  it("works through the functions with an injected clock", async () => {
    const a = await seed({ welcomeAgoDays: 0 });
    const e = env as unknown as import("../src/worker/env").Env;
    const later = new Date(Date.now() + 15 * DAY);
    expect(await saveClientAnswers(e, a.token, { business: "hello" }, later)).toEqual({ ok: true });
    expect(await rows(a.businessId, "onboarding_resumed")).toHaveLength(1);
    expect((await getOnboarding(env.DB, a.id))!.lastClientActivityAt).toBe(later.toISOString());
    expect(await saveClientAnswers(e, "nope", {}, later)).toMatchObject({ ok: false, status: 404 });
    expect(await saveClientAnswers(e, a.token, { business: 3 as unknown as string }, later)).toMatchObject({ ok: false, status: 400 });
    expect(await saveClientItemText(e, a.token, "none", "x", later)).toMatchObject({ ok: false, status: 404 });
    await saveAnswers(env.DB, a.id, FULL, later.toISOString());
    expect(await submitClientQuestionnaire(e, a.token, later)).toEqual({ ok: true });
    expect(await submitClientQuestionnaire(e, a.token, later)).toEqual({ ok: true, already: true });
    expect((await getOnboarding(env.DB, a.id))!.questionnaireSubmittedAt).toBe(later.toISOString());
    await submitQuestionnaire(env.DB, a.id, later.toISOString());
  });
});

describe("the routes", () => {
  it("responses carry no-store and noindex", async () => {
    const a = await seed();
    const about = await item(a.id, "about");
    const answers = [
      await get(a.token),
      await put(a.token, { business: "x" }),
      await submit(a.token), // 400: required answers missing
      await putText(a.token, about.id, "x"),
      await get("B".repeat(43)),
      await get("short"),
      await json("PUT", `/public/o/${a.token}/answers`, "nope"),
    ];
    expect(answers.map((r) => r.status)).toEqual([200, 200, 400, 200, 404, 404, 400]);
    for (const r of answers) {
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("no session cookie is needed for these routes, but other /api routes still want one", async () => {
    const a = await seed();
    const about = await item(a.id, "about");
    expect((await get(a.token)).status).toBe(200);
    expect((await put(a.token, { business: "x" })).status).toBe(200);
    expect((await putText(a.token, about.id, "x")).status).toBe(200);
    expect((await submit(a.token)).status).toBe(400); // reached the handler, not the session check
    // an existing authed route is not opened by any of this
    expect((await call("/leads")).status).toBe(401);
    expect((await call("/settings")).status).toBe(401);
  });

  it("only the right method on the right path is public: neighbours stay behind the session", async () => {
    const a = await seed();
    const t = a.token;
    for (const [method, path] of [
      ["POST", `/public/o/${t}`], ["PUT", `/public/o/${t}`], ["DELETE", `/public/o/${t}`],
      ["GET", `/public/o/${t}/answers`], ["POST", `/public/o/${t}/answers`], ["GET", `/public/o/${t}/submit`], ["PUT", `/public/o/${t}/submit`],
      ["GET", `/public/o/${t}/items/x/text`], ["POST", `/public/o/${t}/items/x/text`], ["PUT", `/public/o/${t}/items/x`], ["PUT", `/public/o/${t}/items//text`],
      ["PUT", `/public/o/${t}/items/x/text/y`], ["GET", `/public/o/${t}/other`], ["PUT", `/public/o/${t}/answers/`], ["GET", "/public/o"], ["GET", "/public/o/"],
      ["GET", `/public/o/${t}/files`], ["PUT", `/public/o/${t}/items/x/files`], ["GET", `/public/o/${t}/items/x/files`], ["POST", `/public/o/${t}/files/y`], ["PUT", `/public/o/${t}/files/y`],
      ["POST", `/public/o/${t}/items/x/files/y`], ["DELETE", `/public/o/${t}/items/x/files`],
    ] as const) {
      const r = await call(path, { method, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });

  it("the file routes (built in a later task) are exempt from the session check and answer 404 until then", async () => {
    const a = await seed();
    const up = await call(`/public/o/${a.token}/items/x/files`, { method: "POST", body: "x" });
    const del = await call(`/public/o/${a.token}/files/y`, { method: "DELETE" });
    expect([up.status, del.status]).toEqual([404, 404]);
    expect(up.headers.get("cache-control")).toBe("no-store");
  });

  it("the limiter is keyed by link and client address, and a malformed link is not counted", async () => {
    const a = await seed();
    const keys: string[] = [];
    const mk = (success: boolean) => ({ limit: async (o: { key: string }) => { keys.push(o.key); return { success }; } }) as unknown as RateLimit;
    const open = await get(a.token, { CLIENT_LIMITER: mk(true) });
    expect(open.status).toBe(200);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^${a.token}:`));
    const blocked = { CLIENT_LIMITER: mk(false) };
    const about = await item(a.id, "about");
    const answers = [
      await get(a.token, blocked),
      await call(`/public/o/${a.token}/answers`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }, blocked),
      await call(`/public/o/${a.token}/submit`, { method: "POST", body: "{}" }, blocked),
      await call(`/public/o/${a.token}/items/${about.id}/text`, { method: "PUT", body: "{}" }, blocked),
    ];
    expect(answers.map((r) => r.status)).toEqual([429, 429, 429, 429]);
    const n = keys.length;
    expect((await get("short", blocked)).status).toBe(404);
    expect(keys).toHaveLength(n);
  });
});
