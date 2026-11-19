import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraft, expireDue, getDocument, recordView, signDocument } from "../src/worker/db/documents";
import { listActivity } from "../src/worker/db/activity";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { clientSig, proposal, seedDeal, sendDraft } from "./fixtures/documents";

// The daily run does other work too (radars, sequences, queues); none of it has anything to do here, so its console output is kept out of the test log.
beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

const EXPIRES = "2026-12-15T17:00:00.000Z";
const AFTER = new Date("2026-12-16T00:00:00.000Z");

/** A proposal that has been sent and expires at `expiresAt`. */
async function sent(expiresAt = EXPIRES) {
  const s = await seedDeal();
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
  const { doc, hash } = await sendDraft(draft.id, draft.content, { expiresAt });
  return { ...s, doc, hash };
}
const voids = async (businessId: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === "proposal_void");

describe("the daily proposal expiry", () => {
  it("the daily run expires a sent document past its expiry and logs it once", async () => {
    const a = await sent();
    const viewed = await sent();
    await recordView(env.DB, viewed.doc.id, { now: "2026-12-02T09:00:00.000Z", userAgent: null });
    await runScheduled(env, DAILY_CRON, AFTER);
    for (const d of [a, viewed]) {
      expect((await getDocument(env.DB, d.doc.id))!.status).toBe("expired");
      const rows = await voids(d.businessId);
      expect(rows).toHaveLength(1);
      expect(rows[0].detail).toBe("SL-ABCDEF v1: expired");
    }
  });

  it("a document expiring exactly now is still open and one a millisecond later is expired", async () => {
    const a = await sent();
    await runScheduled(env, DAILY_CRON, new Date(EXPIRES));
    expect((await getDocument(env.DB, a.doc.id))!.status).toBe("sent");
    expect(await voids(a.businessId)).toEqual([]);
    await runScheduled(env, DAILY_CRON, new Date(Date.parse(EXPIRES) + 1));
    expect((await getDocument(env.DB, a.doc.id))!.status).toBe("expired");
    expect(await voids(a.businessId)).toHaveLength(1);
  });

  it("a signed document is never expired", async () => {
    const a = await sent();
    expect(await signDocument(env.DB, a.doc.id, clientSig(a.hash), "2026-12-02T09:00:00.000Z")).toBe("signed");
    await runScheduled(env, DAILY_CRON, AFTER);
    expect((await getDocument(env.DB, a.doc.id))!.status).toBe("signed");
    expect(await voids(a.businessId)).toEqual([]);
  });

  it("running the sweep twice logs once", async () => {
    const a = await sent();
    await runScheduled(env, DAILY_CRON, AFTER);
    await runScheduled(env, DAILY_CRON, new Date(AFTER.getTime() + 86_400_000));
    expect(await voids(a.businessId)).toHaveLength(1);
  });

  it("expireDue returns the documents it expired and none the second time", async () => {
    const a = await sent();
    const open = await sent("2027-06-01T00:00:00.000Z");
    const got = await expireDue(env.DB, AFTER.toISOString());
    expect(got.map((d) => [d.id, d.businessId, d.status])).toEqual([[a.doc.id, a.businessId, "expired"]]);
    expect((await getDocument(env.DB, open.doc.id))!.status).toBe("sent");
    expect(await expireDue(env.DB, AFTER.toISOString())).toEqual([]);
  });
});
