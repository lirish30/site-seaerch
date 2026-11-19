import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addSuppression } from "../src/worker/db/suppression";
import { createDeal } from "../src/worker/db/deals";
import { createDraft } from "../src/worker/db/documents";
import {
  closeOnboarding, createOnboarding, listItems, markWelcomeSent, setItemStatus, touchClient, type NewItem,
} from "../src/worker/db/onboardings";
import { dueDatesFor } from "../src/worker/onboarding/schedule";
import { buildToday } from "../src/worker/today";
import { proposal } from "./fixtures/documents";
import { seedBusiness } from "./fixtures/cro";

const NOW = new Date("2026-11-19T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const ITEMS: NewItem[] = [
  { key: "logo", label: "Logo", instructions: "Send your logo", kind: "files", phase: 1 },
  { key: "about", label: "About text", instructions: "Tell us about you", kind: "text", phase: 1 },
];

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

// buildToday reads every lead, so each test starts from an empty set.
beforeEach(async () => {
  for (const t of ["onboarding_nudges", "onboarding_files", "onboarding_answers", "onboarding_items", "onboardings", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

/**
 * A client: a lead with a deal, a document and an onboarding. `welcomeDaysAgo` is when the welcome went out (null: not sent), `created` when the onboarding began,
 * `touched` the client's last word (days ago; the welcome counts as the last word until they write).
 */
async function client(name: string, o: { test?: boolean; welcomeDaysAgo?: number | null; created?: number; touched?: number | null; website?: string | null } = {}) {
  const b = await seedBusiness({ name, websiteUrl: o.website === undefined ? null : o.website });
  const deal = await createDeal(env.DB, { businessId: b.id, source: "manual" });
  const doc = await createDraft(env.DB, { dealId: deal.id, businessId: b.id, optionId: "b", content: proposal() });
  const { onboarding } = await createOnboarding(env.DB, { businessId: b.id, dealId: deal.id, documentId: doc.id, kind: "build", test: o.test ?? false, items: ITEMS });
  const created = ago(o.created ?? 0);
  await env.DB.prepare(`UPDATE onboardings SET created_at = ? WHERE id = ?`).bind(created, onboarding.id).run();
  const welcome = o.welcomeDaysAgo === undefined ? 1 : o.welcomeDaysAgo;
  if (welcome !== null) await markWelcomeSent(env.DB, onboarding.id, { sentAt: ago(welcome), ...dueDatesFor(new Date(ago(welcome))) });
  if (o.touched != null) await touchClient(env.DB, onboarding.id, ago(o.touched));
  return { businessId: b.id, id: onboarding.id };
}
const received = async (onboardingId: string, n = 1) => {
  for (const it of (await listItems(env.DB, onboardingId)).slice(0, n)) await setItemStatus(env.DB, it.id, "received");
};
const act = (businessId: string, kind: string, createdAt: string, detail: string | null = null) => env.DB.prepare(
  `INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), businessId, kind, detail, createdAt).run();
const attention = async () => (await buildToday(env.DB, NOW)).filter((i) => i.kind === "onboarding_attention");

describe("onboarding_attention", () => {
  it("a received item shows a review item", async () => {
    const c = await client("Ace Plumbing", { touched: 1 });
    await received(c.id);
    expect(await attention()).toEqual([{
      id: `onboarding_attention:${c.businessId}`, kind: "onboarding_attention", businessId: c.businessId, businessName: "Ace Plumbing",
      reason: "1 item from Ace Plumbing to review", due: null, priority: 70,
    }]);
  });

  it("counts every received item that is not yet accepted", async () => {
    const c = await client("Ace Plumbing", { touched: 1 });
    await received(c.id, 2);
    expect((await attention())[0].reason).toBe("2 items from Ace Plumbing to review");
    const [first] = await listItems(env.DB, c.id);
    await setItemStatus(env.DB, first.id, "accepted");
    expect((await attention())[0].reason).toBe("1 item from Ace Plumbing to review");
  });

  it("nothing received and nothing wrong shows nothing", async () => {
    await client("Quiet", { touched: 1 });
    expect(await attention()).toEqual([]);
  });

  it("waiting_on_client shows the silence item", async () => {
    const c = await client("Gone Quiet", { welcomeDaysAgo: 15 });
    const [item] = await attention();
    expect(item).toMatchObject({ id: `onboarding_attention:${c.businessId}`, reason: "No reply for 15 days: back of the queue", priority: 70, due: null });
    // The client wrote 3 days ago: the silence is over.
    await touchClient(env.DB, c.id, ago(3));
    expect(await attention()).toEqual([]);
  });

  it("an unsent welcome older than a day shows", async () => {
    const c = await client("Late Welcome", { welcomeDaysAgo: null, created: 2 });
    const [item] = await attention();
    expect(item).toMatchObject({ id: `onboarding_attention:${c.businessId}`, reason: "Welcome email is waiting for you", priority: 70 });
  });

  it("an unsent welcome younger than a day does not", async () => {
    await client("Fresh", { welcomeDaysAgo: null, created: 0.5 });
    expect(await attention()).toEqual([]);
  });

  it("a welcome that went out does not show as waiting", async () => {
    await client("Sent", { welcomeDaysAgo: 1, created: 5, touched: 1 });
    expect(await attention()).toEqual([]);
  });

  it("one item per lead, with the review ahead of the silence", async () => {
    const c = await client("Both", { welcomeDaysAgo: 15 });
    await received(c.id);
    const items = await attention();
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe("1 item from Both to review");
  });

  it("a test or closed onboarding shows nothing", async () => {
    const t = await client("Rehearsal", { test: true, welcomeDaysAgo: 15 });
    await received(t.id);
    const u = await client("Test unsent", { test: true, welcomeDaysAgo: null, created: 3 });
    expect(u.id).toBeTruthy();
    const done = await client("Wrapped Up", { welcomeDaysAgo: 15 });
    await received(done.id);
    await closeOnboarding(env.DB, done.id, ago(1));
    expect(await attention()).toEqual([]);
  });

  it("done hides it for 7 days like the other kinds", async () => {
    const c = await client("Ace Plumbing", { touched: 1 });
    await received(c.id);
    await act(c.businessId, "today_done", ago(3), "onboarding_attention");
    expect(await attention()).toEqual([]);
    await act(c.businessId, "today_done", ago(8), "onboarding_attention"); // an older done does not override the newer one
    expect(await attention()).toEqual([]);
    await env.DB.prepare(`DELETE FROM activity WHERE business_id = ?`).bind(c.businessId).run();
    await act(c.businessId, "today_done", ago(8), "onboarding_attention");
    expect(await attention()).toHaveLength(1);
  });

  it("a snooze hides it until the timestamp, and the done and snooze routes take the kind", async () => {
    const c = await client("Ace Plumbing", { touched: 1 });
    await received(c.id);
    await act(c.businessId, "snoozed", ago(1), `onboarding_attention|${new Date(NOW.getTime() + DAY).toISOString()}`);
    expect(await attention()).toEqual([]);
    await act(c.businessId, "snoozed", ago(0.5), `onboarding_attention|${ago(0.1)}`); // the latest row decides: this one is over
    expect(await attention()).toHaveLength(1);
    const post = (path: string, body: unknown = {}) => SELF.fetch(`https://x/api${path}`, { method: "POST", body: JSON.stringify(body), headers: { cookie, "content-type": "application/json" } });
    expect((await post(`/today/onboarding_attention/${c.businessId}/snooze`, { days: 3 })).status).toBe(200);
    expect((await post(`/today/onboarding_attention/${c.businessId}/done`)).status).toBe(200);
  });

  it("a suppressed lead still shows it (it is a client)", async () => {
    const c = await client("Client Co", { website: "https://client.test", touched: 1 });
    await received(c.id);
    await addSuppression(env.DB, { kind: "domain", value: "client.test", reason: "client" });
    expect((await attention()).map((i) => i.businessId)).toEqual([c.businessId]);
  });

  it("an archived lead shows nothing, as for every other Today kind", async () => {
    const c = await client("Archived", { touched: 1 });
    await received(c.id);
    await env.DB.prepare(`UPDATE businesses SET archived_at = ? WHERE id = ?`).bind(ago(1), c.businessId).run();
    expect(await attention()).toEqual([]);
  });

  it("a won lead is a candidate by its onboarding alone", async () => {
    const c = await client("Won Client", { touched: 1 });
    await received(c.id);
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(c.businessId).run();
    const all = await buildToday(env.DB, NOW);
    expect(all.map((i) => i.kind)).toEqual(["onboarding_attention"]);
  });

  it("ten clients each get their own item", async () => {
    for (let i = 0; i < 10; i++) { const c = await client(`Client ${i}`, { touched: 1 }); await received(c.id); }
    expect(await attention()).toHaveLength(10);
  });
});
