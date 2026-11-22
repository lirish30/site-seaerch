import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setGrade } from "../src/worker/db/grade";
import { ensureSeedSops } from "../src/worker/db/sops";
import { insertTasks } from "../src/worker/db/tasks";
import { dayKey } from "../src/worker/booking/slots";
import { periodKey } from "../src/worker/sop/cadence";
import { seedClient } from "./fixtures/clients";
import { actionCount, mcp, ok } from "./fixtures/mcp";
import { newTask, resetProjectWork } from "./fixtures/projects";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch(["billing_holds", "invoice_nudges", "invoices", "subscriptions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await resetProjectWork();
  await ensureSeedSops(env.DB);
  await env.DB.prepare(`UPDATE sop_templates SET active = 1`).run();
});
const get = (path: string, auth = true) => SELF.fetch(`https://x${path}`, { headers: auth ? { cookie } : {} });

/** A client with Pat Jones's address and phone on file, graded A, with this week's weekly update (the route and the tool read the real clock). */
async function seedWeekly(name: string) {
  const s = await seedClient();
  await env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind(name, s.businessId).run();
  await setGrade(env.DB, s.businessId, "A", "", new Date().toISOString());
  const week = periodKey("weekly", new Date(), "America/Los_Angeles");
  await insertTasks(env.DB, [newTask(s.project!.id, s.businessId, { isStep: false, cadenceKey: "CARE-1", periodKey: week, dueOn: dayKey(Date.now(), "America/Los_Angeles"), estMinutes: 37, checklist: [{ text: "a", done: true }, { text: "b", done: false }] })]);
  return { ...s, week };
}

describe("batches routes", () => {
  it("GET needs a session", async () => {
    expect((await get("/api/batches", false)).status).toBe(401);
    const r = await get("/api/batches");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ groups: [] });
    const s = await seedWeekly("Ace Plumbing");
    const body = await (await get("/api/batches")).json<any>();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({ templateKey: "CARE-1", period: s.week, open: 1, done: 0, estMinutes: 37 });
    expect(body.groups[0].tasks[0]).toMatchObject({ client: "Ace Plumbing", grade: "A", checklistDone: 1, checklistTotal: 2, held: false });
  });

  it("MCP list_batches returns the groups and no email address or token", async () => {
    const s = await seedWeekly("Ace Plumbing");
    const names = (await mcp("tools/list", {})).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_batches");
    expect(names).toHaveLength(33);
    const before = await actionCount("list_batches");
    const text = JSON.stringify(await ok("list_batches", {}));
    const answer = JSON.parse(text) as { groups: { templateKey: string; period: string; tasks: Record<string, unknown>[] }[] };
    expect(answer.groups).toHaveLength(1);
    expect(answer.groups[0]).toMatchObject({ templateKey: "CARE-1", period: s.week });
    expect(Object.keys(answer.groups[0].tasks[0]).sort()).toEqual(["checklistDone", "checklistTotal", "client", "clientId", "dueOn", "estMinutes", "grade", "held", "status", "taskId"]);
    expect(answer.groups[0].tasks[0]).toMatchObject({ client: "Ace Plumbing", clientId: s.businessId, grade: "A", held: false });
    for (const secret of ["pat@ace.test", "208-555-0100", "@", "token", "http"]) expect(text, secret).not.toContain(secret);
    expect(await actionCount("list_batches")).toBe(before + 1);
  });
});
