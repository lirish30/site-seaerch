import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { createDeal } from "../src/worker/db/deals";
import {
  closeOnboarding, createOnboarding, getOnboarding, listItems, markWelcomeSent, setItemStatus, settleAccessItem, submitQuestionnaire, type ItemStatus,
} from "../src/worker/db/onboardings";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { dueDatesFor, stageOf } from "../src/worker/onboarding/schedule";
import { sweepOnboardings } from "../src/worker/onboarding/sweep";
import { itemsFor } from "../src/worker/onboarding/templates";
import { readyToSend } from "./fixtures/documents";
import { seedClient } from "./fixtures/clients";

const DAY = 86_400_000;
const WELCOME = new Date("2027-01-04T17:00:00.000Z");
const ACCESS = ["hosting", "dns", "registrar", "admin", "gbp", "analytics"] as const;

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
const put = (siteId: string, key: string, body: unknown) =>
  SELF.fetch(`https://x/api/sites/${siteId}/access/${key}`, { method: "PUT", body: JSON.stringify(body), headers: { cookie, "content-type": "application/json" } });

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.batch(["onboarding_nudges", "onboarding_files", "onboarding_answers", "onboarding_items", "onboardings", "approvals"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

/**
 * A build client: the welcome went out, the questionnaire is in, every content item is answered, and the access questions in `answered` were answered by the client
 * (the rest are still waiting). Returns ids and the item rows by key.
 */
async function client(o: { answered?: readonly string[]; test?: boolean } = {}) {
  const s = await seedClient({ test: o.test });
  const { onboarding } = await createOnboarding(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, kind: "build", test: o.test ?? false, items: itemsFor(["starter_site", "care"]),
  });
  await markWelcomeSent(env.DB, onboarding.id, { sentAt: WELCOME.toISOString(), ...dueDatesFor(WELCOME) });
  await submitQuestionnaire(env.DB, onboarding.id, WELCOME.toISOString());
  for (const i of await listItems(env.DB, onboarding.id)) {
    const isAccess = i.key.startsWith("access_");
    if (!isAccess || (o.answered ?? []).includes(i.key.slice(7))) {
      await setItemStatus(env.DB, i.id, "received");
      if (isAccess) await env.DB.prepare(`UPDATE onboarding_items SET text_value = ? WHERE id = ?`).bind(`client says ${i.key}`, i.id).run();
    }
  }
  return { ...s, onboardingId: onboarding.id };
}
const statusOf = async (onboardingId: string, key: string) => (await listItems(env.DB, onboardingId)).find((i) => i.key === `access_${key}`)!;
const record = async (siteId: string, key: string, status: string) => expect((await put(siteId, key, { status })).status).toBe(200);

describe("recording access settles the matching client question", () => {
  it("received on all six items completes the onboarding of a build client with two unanswered questions, and a 14-day silence logs no clause", async () => {
    await readyToSend();
    const a = await client({ answered: ["hosting", "dns", "registrar", "admin"] });
    const control = await client({ answered: ["hosting", "dns", "registrar", "admin"] });
    expect((await statusOf(a.onboardingId, "gbp")).status).toBe("waiting");
    expect((await statusOf(a.onboardingId, "analytics")).status).toBe("waiting");

    for (const k of ACCESS) await record(a.site!.id, k, "received");

    expect((await statusOf(a.onboardingId, "gbp")).status).toBe("accepted");
    expect((await statusOf(a.onboardingId, "analytics")).status).toBe("accepted");
    const done = (await getOnboarding(env.DB, a.onboardingId))!;
    expect(stageOf(done, await listItems(env.DB, a.onboardingId), new Date(WELCOME.getTime() + 14 * DAY))).toBe("complete");

    await sweepOnboardings(env as Env, new Date(WELCOME.getTime() + 15 * DAY));
    const waiting = async (id: string) => (await listActivity(env.DB, id, 200)).filter((x) => x.kind === "onboarding_waiting");
    expect(await waiting(a.businessId)).toEqual([]);
    // The same client without the recorded access does go quiet.
    expect(await waiting(control.businessId)).toHaveLength(1);
  });

  it("verified settles to accepted and not_applicable settles to not_applicable", async () => {
    const a = await client();
    await record(a.site!.id, "hosting", "verified");
    await record(a.site!.id, "dns", "not_applicable");
    expect((await statusOf(a.onboardingId, "hosting")).status).toBe("accepted");
    expect((await statusOf(a.onboardingId, "dns")).status).toBe("not_applicable");
    expect((await statusOf(a.onboardingId, "registrar")).status).toBe("waiting");
  });

  it("needed and requested, and a note or vault name with no status, settle nothing", async () => {
    const a = await client();
    await record(a.site!.id, "hosting", "requested");
    await record(a.site!.id, "dns", "needed");
    expect((await put(a.site!.id, "registrar", { note: "asked Dana", vaultItem: "Acme GoDaddy" })).status).toBe(200);
    for (const k of ["hosting", "dns", "registrar"]) expect((await statusOf(a.onboardingId, k)).status, k).toBe("waiting");
  });

  it("a client's own answer stands, and so does an item the owner already accepted or marked not applicable", async () => {
    const a = await client({ answered: ["hosting"] });
    const dns = await statusOf(a.onboardingId, "dns");
    await setItemStatus(env.DB, dns.id, "accepted");
    const reg = await statusOf(a.onboardingId, "registrar");
    await setItemStatus(env.DB, reg.id, "not_applicable");
    const before = await statusOf(a.onboardingId, "hosting");

    await record(a.site!.id, "hosting", "verified");
    await record(a.site!.id, "dns", "not_applicable");
    await record(a.site!.id, "registrar", "received");

    const after = await statusOf(a.onboardingId, "hosting");
    expect(after).toMatchObject({ status: "received", textValue: "client says access_hosting", updatedAt: before.updatedAt });
    expect((await statusOf(a.onboardingId, "dns")).status).toBe("accepted");
    expect((await statusOf(a.onboardingId, "registrar")).status).toBe("not_applicable");
  });

  it("does not touch a test onboarding, a closed one, another client's, or the client's last activity", async () => {
    const a = await client();
    const rehearsal = await client({ test: true });
    // Same business as `a`, but a rehearsal onboarding for it (test = 1) and a closed real one.
    const items = itemsFor(["care"]);
    await env.DB.prepare(`UPDATE deals SET stage = 'lost' WHERE business_id = ?`).bind(a.businessId).run();
    const d2 = await createDeal(env.DB, { businessId: a.businessId, source: "manual" });
    const { onboarding: test2 } = await createOnboarding(env.DB, { businessId: a.businessId, dealId: d2.id, documentId: a.documentId, kind: "light", test: true, items });
    await env.DB.prepare(`UPDATE deals SET stage = 'lost' WHERE business_id = ?`).bind(a.businessId).run();
    const d3 = await createDeal(env.DB, { businessId: a.businessId, source: "manual" });
    const { onboarding: closed } = await createOnboarding(env.DB, { businessId: a.businessId, dealId: d3.id, documentId: a.documentId, kind: "light", test: false, items });
    await closeOnboarding(env.DB, closed.id, "2027-01-05T00:00:00.000Z");
    const lastBefore = (await getOnboarding(env.DB, a.onboardingId))!.lastClientActivityAt;
    expect(lastBefore).not.toBeNull();

    await record(a.site!.id, "gbp", "received");

    expect((await statusOf(a.onboardingId, "gbp")).status).toBe("accepted");
    expect((await statusOf(test2.id, "gbp")).status).toBe("waiting");
    expect((await statusOf(closed.id, "gbp")).status).toBe("waiting");
    expect((await statusOf(rehearsal.onboardingId, "gbp")).status).toBe("waiting");
    expect((await getOnboarding(env.DB, a.onboardingId))!.lastClientActivityAt).toBe(lastBefore);
  });

  it("moving the checklist back to requested leaves the settled question settled", async () => {
    const a = await client();
    await record(a.site!.id, "analytics", "received");
    expect((await statusOf(a.onboardingId, "analytics")).status).toBe("accepted");
    await record(a.site!.id, "analytics", "requested");
    await record(a.site!.id, "analytics", "needed");
    expect((await statusOf(a.onboardingId, "analytics")).status).toBe("accepted");
  });

  it("settleAccessItem is one guarded update: it reports how many it changed and never touches a non-waiting item", async () => {
    const a = await client({ answered: ["dns"] });
    const now = "2027-01-06T00:00:00.000Z";
    expect(await settleAccessItem(env.DB, a.businessId, "dns", "accepted", now)).toBe(0);
    expect(await settleAccessItem(env.DB, a.businessId, "hosting", "accepted", now)).toBe(1);
    expect(await settleAccessItem(env.DB, a.businessId, "hosting", "accepted", now)).toBe(0);
    expect((await statusOf(a.onboardingId, "hosting")).updatedAt).toBe(now);
    const statuses: ItemStatus[] = (await listItems(env.DB, a.onboardingId)).filter((i) => !["access_hosting"].includes(i.key)).map((i) => i.status);
    expect(statuses).not.toContain("accepted");
  });

  it("a failure to settle logs one plain line with no input and the request still succeeds", async () => {
    const a = await client();
    await env.DB.prepare(`CREATE TRIGGER settle_break BEFORE UPDATE ON onboarding_items BEGIN SELECT RAISE(ABORT, 'items are broken'); END`).run();
    try {
      const res = await put(a.site!.id, "hosting", { status: "received", vaultItem: "Acme GoDaddy", note: "secret-ish note" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { item: { status: string } }).item.status).toBe("received");
    } finally { await env.DB.prepare(`DROP TRIGGER IF EXISTS settle_break`).run(); }
    const mine = errors.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith("clients: access question not settled"));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toHaveLength(2);
    expect(typeof mine[0][1]).toBe("string");
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/GoDaddy|secret-ish|hosting/);
    expect((await statusOf(a.onboardingId, "hosting")).status).toBe("waiting");
  });
});
