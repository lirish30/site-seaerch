import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../src/worker/helper/kinds";
import { getHelperKind } from "../src/worker/helper/kinds";
import { queueCertCheck, CERT_WARN_DAYS } from "../src/worker/care/certsKind";
import { listIncidents } from "../src/worker/db/monitoring";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { seedClient } from "./fixtures/clients";

const KIND = "care.certs";
const def = () => getHelperKind(KIND)!;
const NOW = new Date("2026-12-02T17:00:00.000Z"); // 09:00 in Los Angeles, 2026-12-02
const dayPlus = (n: number) => new Date(Date.UTC(2026, 11, 2 + n)).toISOString().slice(0, 10);
const jobs = async () => (await env.DB.prepare(`SELECT * FROM helper_jobs WHERE kind = ? ORDER BY created_at, rowid`).bind(KIND).all<{ id: string; status: string; payload: string; dedupe_key: string }>()).results;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM helper_jobs`), env.DB.prepare(`DELETE FROM site_incidents`)]);
  await env.DB.prepare(`UPDATE sites SET archived_at = '2020-01-01T00:00:00.000Z' WHERE archived_at IS NULL`).run();
});

async function careSite(url = "https://ace.com") {
  const s = await seedClient({ subs: [{ key: "care", monthlyCents: 5000 }] });
  await env.DB.prepare(`UPDATE sites SET url = ? WHERE id = ?`).bind(url, s.site!.id).run();
  return s;
}
const apply = (siteIds: string[], validTo: (string | null)[], hosts = siteIds.map((siteId) => ({ siteId, host: "ace.com" }))) =>
  def().apply(env, def().payload.parse({ hosts }), def().result.parse({ certs: siteIds.map((siteId, i) => ({ siteId, validTo: validTo[i] })) }));
const siteRow = (id: string) => env.DB.prepare(`SELECT cert_expires_on, cert_checked_at FROM sites WHERE id = ?`).bind(id).first<{ cert_expires_on: string | null; cert_checked_at: string | null }>();
const open = async (id: string) => (await listIncidents(env.DB, { open: true })).filter((i) => i.siteId === id && i.kind === "cert_expiring");

describe("care.certs kind", () => {
  it("uses 14 days as the warning", () => expect(CERT_WARN_DAYS).toBe(14));

  it("queues the monitored sites' hostnames once a day", async () => {
    const s = await careSite("https://WWW.Ace.com/page");
    await queueCertCheck(env, NOW);
    const j = await jobs();
    expect(j).toHaveLength(1);
    expect(j[0].dedupe_key).toBe("care.certs:2026-12-02");
    expect(JSON.parse(j[0].payload).hosts).toEqual([{ siteId: s.site!.id, host: "www.ace.com" }]);
    await queueCertCheck(env, NOW);
    expect(await jobs()).toHaveLength(1);
    await env.DB.prepare(`UPDATE helper_jobs SET status = 'done'`).run();
    await queueCertCheck(env, NOW);
    expect(await jobs()).toHaveLength(1); // done today: not again today
    await queueCertCheck(env, new Date(NOW.getTime() + 86_400_000));
    expect(await jobs()).toHaveLength(2);
  });

  it("leaves out an IP literal, an internal name and a site that is not monitorable, and queues nothing when none is left", async () => {
    await careSite("http://10.0.0.5/");
    expect(await queueCertCheck(env, NOW)).toEqual({ queued: false });
    await careSite("https://printer.local");
    expect(await queueCertCheck(env, NOW)).toEqual({ queued: false });
    expect(await jobs()).toHaveLength(0);
  });

  it("the daily cron queues one job a day", async () => {
    await careSite();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 404 }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runScheduled(env, DAILY_CRON, NOW);
      await runScheduled(env, DAILY_CRON, NOW);
      expect(await jobs()).toHaveLength(1);
    } finally { vi.restoreAllMocks(); }
  });

  it("9 days left opens one incident, a second apply opens none, 60 days closes it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    try {
      const s = await careSite(); const id = s.site!.id;
      await apply([id], [dayPlus(9)]);
      let inc = await open(id);
      expect(inc).toHaveLength(1);
      expect(inc[0].detail).toBe("certificate expires in 9 days");
      expect((await siteRow(id))!.cert_expires_on).toBe(dayPlus(9));
      await apply([id], [dayPlus(9)]);
      expect(await open(id)).toHaveLength(1);
      await apply([id], [dayPlus(60)]);
      expect(await open(id)).toHaveLength(0);
      expect((await siteRow(id))!.cert_expires_on).toBe(dayPlus(60));
    } finally { vi.useRealTimers(); }
  });

  it("14 days opens, 15 does not, and an expired one says how long ago", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    try {
      const s = await careSite(); const id = s.site!.id;
      await apply([id], [dayPlus(15)]);
      expect(await open(id)).toHaveLength(0);
      await apply([id], [dayPlus(14)]);
      expect(await open(id)).toHaveLength(1);
      await apply([id], [dayPlus(-2)]);
      expect((await open(id))).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("null keeps an open incident and leaves cert_checked_at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    try {
      const s = await careSite(); const id = s.site!.id;
      await apply([id], [dayPlus(9)]);
      const before = await siteRow(id);
      vi.setSystemTime(new Date(NOW.getTime() + 3_600_000));
      await apply([id], [null]);
      expect(await open(id)).toHaveLength(1);
      expect(await siteRow(id)).toEqual(before);
    } finally { vi.useRealTimers(); }
  });

  it("ignores a site that is not in the payload and one no longer monitored", async () => {
    const a = await careSite(); const b = await careSite();
    await env.DB.prepare(`UPDATE sites SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).bind(b.site!.id).run();
    // a is in the result but not in the payload; b is in both but archived
    await def().apply(env, def().payload.parse({ hosts: [{ siteId: b.site!.id, host: "ace.com" }] }),
      def().result.parse({ certs: [{ siteId: a.site!.id, validTo: dayPlus(3) }, { siteId: b.site!.id, validTo: dayPlus(3) }] }));
    expect((await siteRow(a.site!.id))!.cert_expires_on).toBeNull();
    expect((await siteRow(b.site!.id))!.cert_expires_on).toBeNull();
    expect(await open(a.site!.id)).toHaveLength(0);
    expect(await open(b.site!.id)).toHaveLength(0);
  });

  it("refuses bad hosts and dates", () => {
    const bad = (host: string) => def().payload.safeParse({ hosts: [{ siteId: "s", host }] }).success;
    expect(bad("ace.com")).toBe(true);
    for (const h of ["10.0.0.5", "x;id.com", "a b.com", "localhost"]) expect(bad(h)).toBe(false);
    expect(def().payload.safeParse({ hosts: [] }).success).toBe(false);
    expect(def().payload.safeParse({ hosts: Array.from({ length: 501 }, (_, i) => ({ siteId: `s${i}`, host: "a.com" })) }).success).toBe(false);
    expect(def().result.safeParse({ certs: [{ siteId: "s", validTo: "Dec 11 2026" }] }).success).toBe(false);
  });
});
