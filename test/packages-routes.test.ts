import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
const call = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" } });

describe("/api/packages", () => {
  it("requires sign-in", async () => {
    expect((await call("GET", "/api/packages", undefined, false)).status).toBe(401);
  });
  it("lists the current catalog and saves a price as the next version", async () => {
    const list = await (await call("GET", "/api/packages")).json<any[]>();
    expect(list).toHaveLength(12);
    const res = await call("PUT", "/api/packages/starter_site", { priceCents: 429700 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: "starter_site", version: 2, priceCents: 429700, fromPrice: true });
    const again = await (await call("GET", "/api/packages")).json<any[]>();
    expect(again.find((p) => p.key === "starter_site").version).toBe(2);
  });
  it("refuses a bad price, an empty patch and an unknown package", async () => {
    expect((await call("PUT", "/api/packages/care", { priceCents: -1 })).status).toBe(400);
    expect((await call("PUT", "/api/packages/care", { priceCents: 129.5 })).status).toBe(400);
    expect((await call("PUT", "/api/packages/care", {})).status).toBe(400);
    expect((await call("PUT", "/api/packages/nope", { priceCents: 100 })).status).toBe(404);
  });
});
