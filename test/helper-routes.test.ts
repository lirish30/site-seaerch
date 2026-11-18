import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createDevice, revokeDevice } from "../src/worker/helper/auth";
import { MAX_OUTPUT_BYTES } from "../src/worker/routes/helper";
import { enqueueHelperJob, getHelperJob } from "../src/worker/helper/jobs";
import { registerHelperTestKinds, resetHelperKindLog, unregisterHelperTestKinds, helperKindLog } from "./helper-kinds";

let cookie = "";
let token = "";
let deviceId = "";
let ip = "";
let ipCount = 0;

const helper = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token: t = token, ...rest } = init;
  return SELF.fetch(`https://x/helper${path}`, { ...rest, headers: { "cf-connecting-ip": ip, ...(t ? { authorization: `Bearer ${t}` } : {}), ...(rest.body && typeof rest.body === "string" ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) } });
};
const post = (path: string, body: unknown = {}, o: { token?: string | null } = {}) => helper(path, { method: "POST", body: JSON.stringify(body), ...o });
const admin = (path: string, init: RequestInit = {}) => SELF.fetch(`https://x/api/helper${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const deviceRow = async (id: string) => (await env.DB.prepare(`SELECT * FROM helper_devices WHERE id = ?`).bind(id).first<Record<string, any>>())!;

beforeAll(async () => {
  registerHelperTestKinds();
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
afterAll(unregisterHelperTestKinds);
beforeEach(async () => {
  ip = `203.0.113.${++ipCount}`; // each test has its own client address, so the bad-token throttle is never shared
  await env.RAW.delete(["in/test.bin", "out/test.bin", "video/other/audio/x.wav", "settings/secret.bin"]);
  resetHelperKindLog();
  await env.DB.batch(["helper_jobs", "helper_devices", "agent_actions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const d = await createDevice(env.DB, "Studio Mac");
  token = d.token; deviceId = d.device.id;
});

/** A job of the test kind that the helper has claimed over HTTP. */
async function claimed() {
  const { id } = await enqueueHelperJob(env.DB, "test.helper", { n: 1 }, { videoId: "v1" });
  const r = await post("/jobs/claim");
  const body = (await r.json()) as { job?: { id: string; kind: string; inputs: string[]; outputs: string[] } };
  expect(body.job?.id).toBe(id);
  return body.job!;
}

describe("helper authentication", () => {
  it("no token gets 401", async () => {
    for (const path of ["/hello", "/jobs/claim", "/jobs/x/complete", "/jobs/x/fail"]) expect((await post(path, {}, { token: null })).status).toBe(401);
    expect((await helper("/jobs/x/input?key=a", { token: null })).status).toBe(401);
    expect((await helper("/jobs/x/output?key=a", { method: "PUT", body: "x", token: null })).status).toBe(401);
  });

  it("a wrong or malformed token gets 401", async () => {
    expect((await post("/hello", {}, { token: "hlp_" + "A".repeat(43) })).status).toBe(401);
    expect((await post("/hello", {}, { token: "not-a-token" })).status).toBe(401);
    expect((await helper("/hello", { method: "POST", headers: { authorization: "Basic abc" } })).status).toBe(401);
    // The MCP bearer is not a helper token.
    expect((await post("/hello", {}, { token: "test-mcp-token" })).status).toBe(401);
  });

  it("throttles repeated bad tokens per IP with 429, and a valid token does not spend the budget", async () => {
    for (let i = 0; i < 30; i++) expect((await post("/hello")).status).toBe(200);
    let limited = false;
    for (let i = 0; i < 30 && !limited; i++) limited = (await post("/hello", {}, { token: "hlp_" + "B".repeat(43) })).status === 429;
    expect(limited).toBe(true);
  });

  it("revoked token gets 401", async () => {
    expect((await post("/hello")).status).toBe(200);
    await revokeDevice(env.DB, deviceId);
    expect((await post("/hello")).status).toBe(401);
    expect((await post("/jobs/claim")).status).toBe(401);
  });

  it("helper routes never accept the login cookie", async () => {
    for (const path of ["/hello", "/jobs/claim"]) {
      const r = await SELF.fetch(`https://x/helper${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
      expect(r.status).toBe(401);
    }
    // And a helper token is no way into the app.
    const r = await SELF.fetch("https://x/api/helper/devices", { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(401);
  });

  it("hello updates last_seen_at and says what the helper needs to know", async () => {
    await env.DB.prepare(`UPDATE helper_devices SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).bind(deviceId).run();
    const before = Date.now();
    const r = await post("/hello");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { serverTime: string; minHelperVersion: string };
    expect(Date.parse(body.serverTime)).toBeGreaterThanOrEqual(before - 1000);
    expect(body.minHelperVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Date.parse((await deviceRow(deviceId)).last_seen_at)).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("helper jobs over HTTP", () => {
  it("claim hands out a job with its inputs and outputs, or an empty object", async () => {
    expect(await (await post("/jobs/claim")).json()).toEqual({});
    const job = await claimed();
    expect(job).toMatchObject({ kind: "test.helper", inputs: ["in/test.bin"], outputs: ["out/test.bin"] });
    expect(await (await post("/jobs/claim")).json()).toEqual({});
  });

  it("claim only hands out kinds the helper asked for and the server knows", async () => {
    await enqueueHelperJob(env.DB, "test.helper", { n: 1 });
    expect(await (await post("/jobs/claim", { kinds: ["voice.segment"] })).json()).toEqual({});
    expect(await (await post("/jobs/claim", { kinds: [] })).json()).toEqual({});
    expect((await post("/jobs/claim", { kinds: "nope" })).status).toBe(400);
    expect(((await (await post("/jobs/claim", { kinds: ["test.helper"] })).json()) as { job: unknown }).job).toBeTruthy();
  });

  it("claim is logged as the helper", async () => {
    await claimed();
    const a = await env.DB.prepare(`SELECT actor, tool FROM agent_actions`).all<{ actor: string; tool: string }>();
    expect(a.results).toEqual([{ actor: "helper", tool: "helper.claim" }]);
  });

  it("input outside the job's list is refused", async () => {
    const job = await claimed();
    await env.RAW.put("in/test.bin", new Uint8Array([1, 2, 3]));
    await env.RAW.put("settings/secret.bin", new Uint8Array([9]));
    const ok = await helper(`/jobs/${job.id}/input?key=${encodeURIComponent("in/test.bin")}`);
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await helper(`/jobs/${job.id}/input?key=${encodeURIComponent("settings/secret.bin")}`)).status).toBe(403);
    expect((await helper(`/jobs/${job.id}/input?key=${encodeURIComponent("in/../settings/secret.bin")}`)).status).toBe(403);
    expect((await helper(`/jobs/${job.id}/input`)).status).toBe(400);
  });

  it("an input in the list that is not in storage is a 404", async () => {
    const job = await claimed();
    expect((await helper(`/jobs/${job.id}/input?key=${encodeURIComponent("in/test.bin")}`)).status).toBe(404);
  });

  it("output outside the job's list is refused", async () => {
    const job = await claimed();
    const put = (key: string) => helper(`/jobs/${job.id}/output?key=${encodeURIComponent(key)}`, { method: "PUT", body: new Uint8Array([5, 5]), headers: { "content-type": "application/octet-stream" } });
    expect((await put("video/other/audio/x.wav")).status).toBe(403);
    expect(await env.RAW.get("video/other/audio/x.wav")).toBeNull();
    const ok = await put("out/test.bin");
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await (await env.RAW.get("out/test.bin"))!.arrayBuffer())).toEqual(new Uint8Array([5, 5]));
  });

  it("a device that does not hold the claim can neither read nor write", async () => {
    const job = await claimed();
    const other = await createDevice(env.DB, "Other Mac");
    expect((await helper(`/jobs/${job.id}/input?key=in/test.bin`, { token: other.token })).status).toBe(403);
    expect((await helper(`/jobs/${job.id}/output?key=out/test.bin`, { method: "PUT", body: "x", token: other.token })).status).toBe(403);
    expect((await post(`/jobs/${job.id}/complete`, { result: { ok: true } }, { token: other.token })).status).toBe(403);
    expect((await post(`/jobs/${job.id}/fail`, { error: "x" }, { token: other.token })).status).toBe(403);
    expect((await helper(`/jobs/nope/input?key=in/test.bin`)).status).toBe(404);
  });

  it("upload over 80 MB is refused", async () => {
    const job = await claimed();
    expect(MAX_OUTPUT_BYTES).toBe(80 * 1024 * 1024);
    const r = await helper(`/jobs/${job.id}/output?key=out/test.bin`, { method: "PUT", body: new Uint8Array(MAX_OUTPUT_BYTES + 1), headers: { "content-type": "application/octet-stream" } });
    expect(r.status).toBe(413);
    expect(await env.RAW.get("out/test.bin")).toBeNull();
  });

  it("complete applies the result once and a second completion is a 409", async () => {
    const job = await claimed();
    const r = await post(`/jobs/${job.id}/complete`, { result: { ok: true } });
    expect(r.status).toBe(200);
    expect(helperKindLog.applied).toHaveLength(1);
    expect((await post(`/jobs/${job.id}/complete`, { result: { ok: true } })).status).toBe(409);
    expect(helperKindLog.applied).toHaveLength(1);
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("done");
  });

  it("an invalid result is a 422 that says why, and the job stays claimed", async () => {
    const job = await claimed();
    const r = await post(`/jobs/${job.id}/complete`, { result: { ok: "no" } });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toMatch(/invalid result/);
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("claimed");
    expect((await post(`/jobs/${job.id}/complete`, {})).status).toBe(422);
  });

  it("fail ends the job with the helper's reason", async () => {
    const job = await claimed();
    expect((await post(`/jobs/${job.id}/fail`, { error: "no GPU" })).status).toBe(200);
    expect(await getHelperJob(env.DB, job.id)).toMatchObject({ status: "failed", error: "no GPU" });
    expect((await post(`/jobs/${job.id}/fail`, { error: "again" })).status).toBe(409);
    expect((await post(`/jobs/${job.id}/fail`, {})).status).toBe(400);
  });
});

describe("helper admin routes", () => {
  it("need the login cookie", async () => {
    expect((await SELF.fetch("https://x/api/helper/status")).status).toBe(401);
    expect((await SELF.fetch("https://x/api/helper/devices")).status).toBe(401);
    expect((await SELF.fetch("https://x/api/helper/devices", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("device creation returns the token once and never again", async () => {
    const r = await admin("/devices", { method: "POST", body: JSON.stringify({ name: "  Laptop  " }) });
    expect(r.status).toBe(201);
    const made = (await r.json()) as { token: string; device: { id: string; name: string } };
    expect(made.token).toMatch(/^hlp_[A-Za-z0-9_-]{43}$/);
    expect(made.device.name).toBe("Laptop");
    // Only a hash is stored.
    const row = await deviceRow(made.device.id);
    expect(row.token_hash).not.toContain(made.token);
    expect(JSON.stringify(row)).not.toContain(made.token);
    // The token works...
    expect((await post("/hello", {}, { token: made.token })).status).toBe(200);
    // ...and is not in the list, nor its hash.
    const list = await (await admin("/devices")).text();
    expect(list).toContain("Laptop");
    expect(list).not.toContain(made.token);
    expect(list).not.toContain(row.token_hash);
    expect(list).not.toContain("token");
  });

  it("device creation needs a name", async () => {
    expect((await admin("/devices", { method: "POST", body: JSON.stringify({ name: "  " }) })).status).toBe(400);
    expect((await admin("/devices", { method: "POST", body: "{}" })).status).toBe(400);
  });

  it("deleting a device revokes its token", async () => {
    expect((await post("/hello")).status).toBe(200);
    expect((await admin(`/devices/${deviceId}`, { method: "DELETE" })).status).toBe(200);
    expect((await post("/hello")).status).toBe(401);
    expect((await deviceRow(deviceId)).revoked_at).toBeTruthy();
    expect((await admin(`/devices/${deviceId}`, { method: "DELETE" })).status).toBe(404);
    const list = (await (await admin("/devices")).json()) as { devices: { id: string }[] };
    expect(list.devices.some((d) => d.id === deviceId)).toBe(false);
  });

  it("status says whether the helper is online and what is waiting", async () => {
    await enqueueHelperJob(env.DB, "test.helper", { n: 1 });
    expect(await (await admin("/status")).json()).toMatchObject({ online: false, pending: { "test.helper": 1 } });
    await post("/hello");
    expect(await (await admin("/status")).json()).toMatchObject({ online: true });
  });
});
