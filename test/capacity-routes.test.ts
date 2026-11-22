import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dayKey } from "../src/worker/booking/slots";
import { createSendApproval } from "../src/worker/approvals/proposalSend";
import { saveSettings } from "../src/worker/db/settings";
import { insertTasks } from "../src/worker/db/tasks";
import { DEFAULT_WORK_CONFIG, parseWorkConfig } from "../src/worker/time/config";
import { draftProposal } from "../src/worker/documents/service";
import { readyToSend, seedProposalDeal } from "./fixtures/documents";
import { newTask, resetProjectWork, seedProject } from "./fixtures/projects";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch(["billing_holds", "invoice_nudges", "invoices", "subscriptions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await resetProjectWork();
  await saveSettings(env.DB, { work_config: "{}" });
});
const get = (path: string, auth = true) => SELF.fetch(`https://x${path}`, { headers: auth ? { cookie } : {} });

/** Books `minutes` of your own work, due that day. */
async function book(minutes: number, dueOn: string) {
  const p = await seedProject();
  await insertTasks(env.DB, [newTask(p.project.id, p.businessId, { owner: "logan", estMinutes: minutes, dueOn })]);
}
/** The local calendar date (the booking zone, Los Angeles by default) `offset` days from now. */
const isoDay = (offset: number) => dayKey(Date.now() + offset * 86_400_000, "America/Los_Angeles");

describe("capacity routes", () => {
  it("GET /api/capacity needs a session", async () => {
    expect((await get("/api/capacity", false)).status).toBe(401);
    const r = await get("/api/capacity");
    expect(r.status).toBe(200);
    const c = await r.json<any>();
    expect(c.weeks).toHaveLength(4);
    expect(c).toMatchObject({ carryOverMinutes: 0, clients: { count: 0, limit: 45 }, state: "ok" });
    expect(c.sentence).toMatch(/^This week is 0 of 20 hours booked; next week 0 of 20\.$/);
  });

  it("/api/today carries capacity", async () => {
    await book(30, isoDay(0));
    const r = await get("/api/today");
    expect(r.status).toBe(200);
    const body = await r.json<any>();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.capacity.weeks).toHaveLength(4);
    expect(body.capacity.clients).toEqual({ count: 1, limit: 45 }); // the one live project booked above
    expect(typeof body.capacity.sentence).toBe("string");
  });

  it("a proposal-send approval preview ends with the warning sentence when next week would be over, and has none otherwise", async () => {
    await readyToSend();
    const s = await seedProposalDeal();
    const doc = await draftProposal(env, s.dealId, { optionId: "b", edits: { scopeNotes: "A new site." }, test: false }, new Date());
    const quiet = await createSendApproval(env, doc);
    expect(quiet.preview).not.toContain("Heads up");
    await env.DB.prepare(`DELETE FROM approvals WHERE id = ?`).bind(quiet.id).run();

    // Fill every one of the four weeks, so this week and next week are over whatever day the test runs.
    for (const offset of [0, 7, 14, 21]) await book(60 * 25, isoDay(offset));
    const loud = await createSendApproval(env, doc);
    expect(loud.preview.trimEnd().split("\n").at(-1)).toMatch(/^Heads up: this week is already 25 of 20 hours booked, and next week would be 25 of 20\.$/);
    expect(loud.preview).toContain("countersigned as");
  });

  it("work_config saved without the new keys still loads the defaults", async () => {
    await saveSettings(env.DB, { work_config: JSON.stringify({ costRateCentsPerHour: 3500, weekStartsOn: 1, timerCapMinutes: 600 }) });
    const raw = (await env.DB.prepare(`SELECT work_config FROM settings`).first<{ work_config: string }>())!.work_config;
    expect(parseWorkConfig(raw)).toEqual({ ...DEFAULT_WORK_CONFIG, costRateCentsPerHour: 3500, timerCapMinutes: 600, weeklyHoursLimit: 20, clientLimit: 45 });
    const c = await (await get("/api/capacity")).json<any>();
    expect(c.clients.limit).toBe(45);
    expect(c.weeks[0].limitMinutes).toBe(1200);
  });
});
