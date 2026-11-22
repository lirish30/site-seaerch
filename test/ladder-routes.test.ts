import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { insertLadderRows, listLadder, setLadderStatus, type LadderStep } from "../src/worker/db/ladder";
import type { Env } from "../src/worker/env";
import { sweepLadder } from "../src/worker/ladder/sweep";
import { readyToSend } from "./fixtures/documents";
import { seedClient } from "./fixtures/clients";
import { ok } from "./fixtures/mcp";
import { resetProjectWork } from "./fixtures/projects";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.batch(["ladder_steps", "billing_holds", "invoice_nudges", "invoices", "subscriptions", "activity"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`DELETE FROM approvals WHERE kind = 'ladder.mail'`).run();
  await resetProjectWork();
  await readyToSend();
});
const call = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x${path}`, { method, headers: { ...(auth ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

async function seed(step: LadderStep = "thank_you", dueOn = "2026-11-20") {
  const s = await seedClient();
  await insertLadderRows(env.DB, [{ businessId: s.businessId, projectId: s.project!.id, step, dueOn }], "2026-11-01T00:00:00.000Z");
  return { ...s, ladderId: (await listLadder(env.DB, s.businessId))[0].id };
}

describe("ladder routes", () => {
  it("done and skip need a session and refuse a row already done", async () => {
    const s = await seed();
    for (const path of [`/api/ladder/${s.ladderId}/done`, `/api/ladder/${s.ladderId}/skip`]) expect((await call("POST", path, {}, false)).status).toBe(401);
    expect((await call("GET", `/api/clients/${s.businessId}/ladder`, undefined, false)).status).toBe(401);
    expect((await call("PUT", `/api/ladder/${s.ladderId}/link`, { link: null }, false)).status).toBe(401);

    const done = await call("POST", `/api/ladder/${s.ladderId}/done`);
    expect(done.status).toBe(200);
    expect(((await done.json()) as any).row).toMatchObject({ id: s.ladderId, status: "done" });
    expect((await listLadder(env.DB, s.businessId))[0].doneAt).not.toBeNull();
    for (const path of [`/api/ladder/${s.ladderId}/done`, `/api/ladder/${s.ladderId}/skip`]) {
      const again = await call("POST", path, {});
      expect(again.status).toBe(409);
      expect(((await again.json()) as any).error).toContain("already done");
    }
    expect((await call("POST", "/api/ladder/nope/done")).status).toBe(404);
  });

  it("skip keeps the note it is given, at most 300 characters, and a skipped row is refused again", async () => {
    const s = await seed("case_study");
    expect((await call("POST", `/api/ladder/${s.ladderId}/skip`, { note: "x".repeat(301) })).status).toBe(400);
    const r = await call("POST", `/api/ladder/${s.ladderId}/skip`, { note: "  Client asked us not to  " });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).row).toMatchObject({ status: "skipped", note: "Client asked us not to" });
    expect((await call("POST", `/api/ladder/${s.ladderId}/done`)).status).toBe(409);
  });

  it("closing a drafted step turns its mail down, so approving it later sends nothing", async () => {
    const s = await seed("check_in", "2026-11-22");
    expect((await sweepLadder(env as Env, new Date("2026-11-22T18:00:00.000Z"))).drafted).toBe(1);
    const approvalId = (await listLadder(env.DB, s.businessId))[0].approvalId!;
    expect((await call("POST", `/api/ladder/${s.ladderId}/skip`, {})).status).toBe(200);
    expect(await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(approvalId).first()).toEqual({ status: "rejected" });
    const mail = await readyToSend();
    expect(await approve(env as Env, approvalId)).toMatchObject({ ok: false, status: 409 });
    expect(mail.sent).toHaveLength(0);
  });

  it("link refuses http and over 300 characters, takes https, and clears with null", async () => {
    const s = await seed("review_request", "2026-11-22");
    const put = (link: unknown) => call("PUT", `/api/ladder/${s.ladderId}/link`, { link });
    expect((await put("http://g.page/r/abc")).status).toBe(400);
    expect((await put("ftp://g.page/r/abc")).status).toBe(400);
    expect((await put("g.page/r/abc")).status).toBe(400);
    expect((await put(`https://g.page/${"a".repeat(300)}`)).status).toBe(400);
    expect((await put(5)).status).toBe(400);
    const exactly = `https://g.page/${"a".repeat(300 - "https://g.page/".length)}`;
    expect(exactly).toHaveLength(300);
    expect((await put(exactly)).status).toBe(200);
    expect((await listLadder(env.DB, s.businessId))[0].link).toBe(exactly);
    const cleared = await put(null);
    expect(((await cleared.json()) as any).row.link).toBeNull();
    expect((await call("PUT", `/api/ladder/nope/link`, { link: null })).status).toBe(404);
  });

  it("a link set on a review request that was held back for want of one puts it back in line; a drafted or done step's link cannot change", async () => {
    const s = await seed("review_request", "2026-11-22");
    expect((await sweepLadder(env as Env, new Date("2026-11-22T18:00:00.000Z"))).due).toBe(1);
    expect((await listLadder(env.DB, s.businessId))[0]).toMatchObject({ status: "due", note: "add the Google review link" });
    const r = await call("PUT", `/api/ladder/${s.ladderId}/link`, { link: "https://g.page/r/abc" });
    expect(((await r.json()) as any).row).toMatchObject({ status: "waiting", note: "", link: "https://g.page/r/abc" });
    expect((await sweepLadder(env as Env, new Date("2026-11-22T18:00:00.000Z"))).drafted).toBe(1);
    expect((await call("PUT", `/api/ladder/${s.ladderId}/link`, { link: "https://g.page/r/other" })).status).toBe(409);
  });

  it("the client read shows the rows: the route, the owner's record and the get_client tool", async () => {
    const s = await seed("thank_you", "2026-12-22");
    await setLadderStatus(env.DB, s.ladderId, "due", { note: "Thank-you is ready" });
    const route = await call("GET", `/api/clients/${s.businessId}/ladder`);
    expect(route.status).toBe(200);
    expect(((await route.json()) as any).rows).toEqual([expect.objectContaining({ id: s.ladderId, businessId: s.businessId, step: "thank_you", dueOn: "2026-12-22", status: "due", note: "Thank-you is ready" })]);
    expect((await call("GET", `/api/clients/nope/ladder`)).status).toBe(404);

    const record = ((await (await call("GET", `/api/clients/${s.businessId}`)).json()) as any).client;
    expect(record.ladder.map((r: any) => [r.step, r.dueOn, r.status])).toEqual([["thank_you", "2026-12-22", "due"]]);

    const tool = await ok<any>("get_client", { id: s.businessId });
    expect(tool.ladder).toEqual([expect.objectContaining({ id: s.ladderId, step: "thank_you", dueOn: "2026-12-22", status: "due", note: "Thank-you is ready" })]);
    expect(Object.keys(tool.ladder[0]).sort()).toEqual(["doneAt", "dueOn", "id", "note", "status", "step"]);
  });

  it("ladder_due appears on Today for a due step, below billing, with the thank-you words or the note, and a rehearsal client never shows", async () => {
    const s = await seed("thank_you", "2026-11-20");
    const t = await seed("review_request", "2026-11-22");
    const rehearsal = await seedClient({ test: true });
    await insertLadderRows(env.DB, [{ businessId: rehearsal.businessId, projectId: rehearsal.project!.id, step: "thank_you", dueOn: "2026-11-20" }], "2026-11-01T00:00:00.000Z");
    const today = async () => ((await (await call("GET", "/api/today")).json()) as any).items.filter((i: any) => i.kind === "ladder_due");
    expect(await today()).toEqual([]); // waiting steps are not on Today yet
    await env.DB.prepare(`UPDATE ladder_steps SET status = 'due' WHERE business_id IN (?, ?)`).bind(s.businessId, rehearsal.businessId).run();
    await setLadderStatus(env.DB, (await listLadder(env.DB, t.businessId))[0].id, "due", { note: "add the Google review link" });
    const items = await today();
    expect(items).toHaveLength(2);
    expect(items.find((i: any) => i.businessId === s.businessId)).toMatchObject({ id: `ladder_due:${s.businessId}`, businessName: "Ace Plumbing", reason: "Thank-you package is due for Ace Plumbing", priority: 56, due: null });
    expect(items.find((i: any) => i.businessId === t.businessId)).toMatchObject({ reason: "add the Google review link" });
    expect(items.some((i: any) => i.businessId === rehearsal.businessId)).toBe(false);

    const done = await call("POST", `/api/today/ladder_due/${s.businessId}/done`);
    expect(done.status).toBe(200);
    expect((await today()).map((i: any) => i.businessId)).toEqual([t.businessId]);
  });
});
