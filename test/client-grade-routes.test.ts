import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { getGrades } from "../src/worker/db/grade";
import type { GradeView } from "../src/worker/clients/grade";
import { getClientRecord } from "../src/worker/clients/record";
import { clientView } from "../src/worker/mcp/tools/views";
import { seedClient } from "./fixtures/clients";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
const call = (method: string, path: string, body?: unknown, o: { auth?: boolean } = {}) =>
  SELF.fetch(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(o.auth === false ? {} : { cookie }), "content-type": "application/json" } });
const lines = async (businessId: string) => (await listActivity(env.DB, businessId, 200)).filter((a) => a.kind === "grade_set").map((a) => a.detail ?? "");

describe("PUT /api/clients/:id/grade", () => {
  it("needs the owner's session", async () => {
    const s = await seedClient();
    expect((await call("PUT", `/api/clients/${s.businessId}/grade`, { grade: "A" }, { auth: false })).status).toBe(401);
  });

  it("PUT sets the grade and the next GET shows it with a different suggestion untouched", async () => {
    const s = await seedClient(); // no revenue: the rules suggest B
    const res = await call("PUT", `/api/clients/${s.businessId}/grade`, { grade: "A", note: "Refers us to friends." });
    expect(res.status).toBe(200);
    const view = (await res.json()) as GradeView;
    expect(view).toMatchObject({ grade: "A", note: "Refers us to friends.", suggested: "B" });
    expect(view.setAt).not.toBeNull();
    expect(view.reasons.length).toBeGreaterThan(0);

    const rec = (await (await call("GET", `/api/clients/${s.businessId}`)).json()) as { client: { grade: GradeView } };
    expect(rec.client.grade).toMatchObject({ grade: "A", note: "Refers us to friends.", suggested: "B" });
    const list = (await (await call("GET", "/api/clients")).json()) as { clients: { id: string; grade: GradeView }[] };
    expect(list.clients.find((c) => c.id === s.businessId)!.grade).toMatchObject({ grade: "A", suggested: "B" });
    expect(await lines(s.businessId)).toEqual(["Grade set to A"]);

    // A later suggestion never overwrites it: the owner's grade stays, whatever the rules say now.
    await env.DB.prepare(`UPDATE businesses SET client_grade_note = client_grade_note WHERE id = ?`).bind(s.businessId).run();
    expect((await getGrades(env.DB, [s.businessId])).get(s.businessId)!.grade).toBe("A");
  });

  it("PUT with grade D is 422", async () => {
    const s = await seedClient();
    const res = await call("PUT", `/api/clients/${s.businessId}/grade`, { grade: "D" });
    expect(res.status).toBe(422);
    expect((await call("PUT", `/api/clients/${s.businessId}/grade`, {})).status).toBe(422);
    expect((await call("PUT", `/api/clients/${s.businessId}/grade`, { grade: "B", note: "x".repeat(301) })).status).toBe(422);
    expect((await getGrades(env.DB, [s.businessId])).get(s.businessId)!.grade).toBeNull();
    expect(await lines(s.businessId)).toEqual([]);
  });

  it("a note of exactly 300 characters is kept", async () => {
    const s = await seedClient();
    const res = await call("PUT", `/api/clients/${s.businessId}/grade`, { grade: "B", note: "y".repeat(300) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as GradeView).note).toHaveLength(300);
  });

  it("PUT null clears", async () => {
    const s = await seedClient();
    await call("PUT", `/api/clients/${s.businessId}/grade`, { grade: "C", note: "Slow to pay." });
    const res = await call("PUT", `/api/clients/${s.businessId}/grade`, { grade: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ grade: null, note: "", setAt: null, suggested: "B" });
    expect((await getGrades(env.DB, [s.businessId])).get(s.businessId)).toEqual({ grade: null, note: "", setAt: null });
    expect((await lines(s.businessId)).sort()).toEqual(["Grade cleared (was C)", "Grade set to C"]);
  });

  it("PUT on a lead that is not a client is 404", async () => {
    const plain = await seedClient({ won: false, project: false });
    expect((await call("PUT", `/api/clients/${plain.businessId}/grade`, { grade: "A" })).status).toBe(404);
    expect((await call("PUT", "/api/clients/nope/grade", { grade: "A" })).status).toBe(404);
    expect((await getGrades(env.DB, [plain.businessId])).get(plain.businessId)!.grade).toBeNull();
  });

  it("a test client is graded by the same route but never appears in the Clients list", async () => {
    const t = await seedClient({ test: true });
    const res = await call("PUT", `/api/clients/${t.businessId}/grade`, { grade: "C" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as GradeView).grade).toBe("C");
    const ids = ((await (await call("GET", "/api/clients")).json()) as { clients: { id: string }[] }).clients.map((c) => c.id);
    expect(ids).not.toContain(t.businessId);
    const all = ((await (await call("GET", "/api/clients?test=1")).json()) as { clients: { id: string; grade: GradeView }[] }).clients;
    expect(all.find((c) => c.id === t.businessId)!.grade.grade).toBe("C");
  });
});

describe("the grade on the other reads", () => {
  it("the Care board rows carry the grade", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }] });
    await call("PUT", `/api/clients/${s.businessId}/grade`, { grade: "B" });
    const { clients: rows } = (await (await call("GET", "/api/care")).json()) as { clients: { businessId: string; grade: GradeView }[] };
    expect(rows.find((r) => r.businessId === s.businessId)!.grade).toMatchObject({ grade: "B", suggested: "B" });
  });

  it("the MCP client read shows the grade, its note and the suggestion with the reasons", async () => {
    const s = await seedClient();
    await call("PUT", `/api/clients/${s.businessId}/grade`, { grade: "C", note: "Slow to pay." });
    const view = clientView((await getClientRecord(env.DB, s.businessId, new Date()))!);
    expect(view.grade).toMatchObject({ grade: "C", note: "Slow to pay.", suggested: "B" });
    expect(view.grade.reasons.length).toBeGreaterThan(0);
  });
});
