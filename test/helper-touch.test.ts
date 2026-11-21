import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createDevice } from "../src/worker/helper/auth";
import { CLAIM_TTL_MS, claimHelperJob, enqueueHelperJob, getHelperJob, touchHelperJob } from "../src/worker/helper/jobs";
import { registerHelperTestKinds, unregisterHelperTestKinds } from "./helper-kinds";

let token = "";
let deviceId = "";
let ip = "";
let ipCount = 0;

const post = (path: string, tok: string | null = token) =>
  SELF.fetch(`https://x/helper${path}`, { method: "POST", body: "{}", headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(tok ? { authorization: `Bearer ${tok}` } : {}) } });

beforeAll(registerHelperTestKinds);
afterAll(unregisterHelperTestKinds);
beforeEach(async () => {
  ip = `198.51.100.${++ipCount}`;
  await env.DB.batch(["helper_jobs", "helper_devices", "agent_actions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const d = await createDevice(env.DB, "Studio Mac");
  token = d.token; deviceId = d.device.id;
});

async function claimedAt(when: Date) {
  const { id } = await enqueueHelperJob(env.DB, "test.helper", { n: 1 }, { videoId: "v1" });
  await claimHelperJob(env, deviceId, when);
  return id;
}

describe("touchHelperJob", () => {
  it("refreshes the claim of the device that holds it", async () => {
    const id = await claimedAt(new Date("2026-11-21T10:00:00Z"));
    expect(await touchHelperJob(env.DB, id, deviceId, new Date("2026-11-21T10:15:00Z"))).toBe(true);
    expect((await getHelperJob(env.DB, id))!.claimed_at).toBe("2026-11-21T10:15:00.000Z");
  });

  it("keeps a touched job from being handed out after the first claim would have gone stale", async () => {
    const id = await claimedAt(new Date("2026-11-21T10:00:00Z"));
    await touchHelperJob(env.DB, id, deviceId, new Date("2026-11-21T10:19:00Z"));
    const other = await createDevice(env.DB, "Other Mac");
    expect(await claimHelperJob(env, other.device.id, new Date(Date.parse("2026-11-21T10:00:00Z") + CLAIM_TTL_MS + 60_000))).toBeNull();
  });

  it("is false for another device", async () => {
    const id = await claimedAt(new Date("2026-11-21T10:00:00Z"));
    const other = await createDevice(env.DB, "Other Mac");
    expect(await touchHelperJob(env.DB, id, other.device.id, new Date("2026-11-21T10:15:00Z"))).toBe(false);
    expect((await getHelperJob(env.DB, id))!.claimed_at).toBe("2026-11-21T10:00:00.000Z");
  });

  it("is false for a done, a pending and an unknown job", async () => {
    const id = await claimedAt(new Date("2026-11-21T10:00:00Z"));
    await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE id = ?`).bind(id).run();
    expect(await touchHelperJob(env.DB, id, deviceId, new Date())).toBe(false);
    const pending = await enqueueHelperJob(env.DB, "test.helper", { n: 2 });
    expect(await touchHelperJob(env.DB, pending.id, deviceId, new Date())).toBe(false);
    expect(await touchHelperJob(env.DB, "nope", deviceId, new Date())).toBe(false);
  });
});

describe("POST /helper/jobs/:id/touch", () => {
  it("answers 204 for the holder", async () => {
    const id = await claimedAt(new Date());
    const r = await post(`/jobs/${id}/touch`);
    expect(r.status).toBe(204);
  });

  it("answers 409 NOT_YOURS for another device and for a job that is done", async () => {
    const id = await claimedAt(new Date());
    const other = await createDevice(env.DB, "Other Mac");
    const r = await post(`/jobs/${id}/touch`, other.token);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("this job is not claimed by this device");
    await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE id = ?`).bind(id).run();
    expect((await post(`/jobs/${id}/touch`)).status).toBe(409);
  });

  it("needs a device token", async () => {
    const id = await claimedAt(new Date());
    expect((await post(`/jobs/${id}/touch`, null)).status).toBe(401);
  });
});
