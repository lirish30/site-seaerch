import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedBusiness } from "./fixtures/cro";
import { listActivity } from "../src/worker/db/activity";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
const call = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" } });

describe("/api/deals", () => {
  it("requires sign-in", async () => {
    expect((await call("GET", "/api/deals", undefined, false)).status).toBe(401);
    expect((await call("POST", "/api/deals/x/move", { to: "lost", lostReason: "x" }, false)).status).toBe(401);
  });

  it("starts a deal from a lead, once, and logs it", async () => {
    const b = await seedBusiness();
    const res = await call("POST", `/api/leads/${b.id}/deal`, { skipCall: true });
    expect(res.status).toBe(201);
    const deal = await res.json<any>();
    expect(deal).toMatchObject({ businessId: b.id, stage: "discovery_done", source: "manual", skipCall: true });
    const again = await call("POST", `/api/leads/${b.id}/deal`, {});
    expect(again.status).toBe(200);
    expect((await again.json<any>()).id).toBe(deal.id);
    expect((await listActivity(env.DB, b.id)).filter((a) => a.kind === "deal_created")).toHaveLength(1);
    expect((await call("POST", "/api/leads/nope/deal", {})).status).toBe(404);
    expect((await call("POST", `/api/leads/${b.id}/deal`, { skipCall: "yes" })).status).toBe(400);
  });

  it("lists deals and reads one", async () => {
    const b = await seedBusiness({ name: "Birch Bakery" });
    const deal = await (await call("POST", `/api/leads/${b.id}/deal`, {})).json<any>();
    const list = await (await call("GET", "/api/deals")).json<any[]>();
    expect(list.find((d) => d.id === deal.id)).toMatchObject({ businessName: "Birch Bakery", stage: "booked" });
    expect(await (await call("GET", `/api/deals/${deal.id}`)).json()).toMatchObject({ id: deal.id, businessId: b.id });
  });

  it("moves a deal forward and logs it; lost needs a reason", async () => {
    const b = await seedBusiness();
    const deal = await (await call("POST", `/api/leads/${b.id}/deal`, {})).json<any>();
    const moved = await call("POST", `/api/deals/${deal.id}/move`, { to: "recommended" });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ stage: "recommended" });
    expect((await listActivity(env.DB, b.id)).find((a) => a.kind === "deal_moved")!.detail).toContain("recommended");
    expect((await call("POST", `/api/deals/${deal.id}/move`, { to: "lost" })).status).toBe(400);
    const lost = await call("POST", `/api/deals/${deal.id}/move`, { to: "lost", lostReason: "went with a cousin" });
    expect(lost.status).toBe(200);
    expect(await lost.json()).toMatchObject({ stage: "lost", lostReason: "went with a cousin" });
  });

  it("move to an invalid stage is a 409", async () => {
    const b = await seedBusiness();
    const deal = await (await call("POST", `/api/leads/${b.id}/deal`, {})).json<any>();
    await call("POST", `/api/deals/${deal.id}/move`, { to: "recommended" });
    expect((await call("POST", `/api/deals/${deal.id}/move`, { to: "booked" })).status).toBe(409);
    expect((await call("POST", `/api/deals/${deal.id}/move`, { to: "nonsense" })).status).toBe(400);
  });

  it("unknown deal is a 404", async () => {
    expect((await call("GET", "/api/deals/nope")).status).toBe(404);
    expect((await call("POST", "/api/deals/nope/move", { to: "recommended" })).status).toBe(404);
  });
});
