import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ClaimedJob } from "../src/api.ts";
import { careCertsHandler, type CertConnect } from "../src/handlers/careCerts.ts";
import type { JobContext } from "../src/loop.ts";

const ctx = (payload: unknown): JobContext => ({ job: { id: "j1", kind: "care.certs", attempts: 1, payload, inputs: [], outputs: [] } as ClaimedJob, api: {} as never, cfg: {} as never, workDir: "/nope" });

/** A fake socket: `how` decides what the host does once connected to. */
function fake(how: (host: string) => "ok" | "error" | "timeout" | { valid_to?: string }) {
  const hosts: string[] = [];
  const opts: Record<string, unknown>[] = [];
  const connect: CertConnect = (o) => {
    hosts.push(o.host); opts.push(o as never);
    const s = new EventEmitter() as EventEmitter & { getPeerCertificate: () => { valid_to?: string }; destroy: () => void };
    const r = how(o.host);
    s.getPeerCertificate = () => (typeof r === "object" ? r : { valid_to: "Dec 11 23:59:59 2026 GMT" });
    s.destroy = () => {};
    setTimeout(() => {
      if (r === "error") s.emit("error", new Error("ECONNREFUSED"));
      else if (r === "timeout") s.emit("timeout");
      else s.emit("secureConnect");
    }, 0);
    return s as never;
  };
  return { connect, hosts, opts };
}
const run = (connect: CertConnect, hosts: { siteId: string; host: string }[]) => careCertsHandler(connect).run(ctx({ hosts })) as Promise<{ certs: { siteId: string; validTo: string | null }[] }>;

describe("care.certs helper handler", () => {
  it("reads valid_to as a UTC date, with the options the brief names", async () => {
    const f = fake(() => "ok");
    const r = await run(f.connect, [{ siteId: "s1", host: "ace.com" }]);
    expect(r.certs).toEqual([{ siteId: "s1", validTo: "2026-12-11" }]);
    expect(f.opts[0]).toMatchObject({ host: "ace.com", port: 443, servername: "ace.com", rejectUnauthorized: false, timeout: 10_000 });
  });

  it("gives null for an error, a timeout, a missing or an unreadable date", async () => {
    const f = fake((h) => (h === "err.com" ? "error" : h === "slow.com" ? "timeout" : h === "none.com" ? {} : { valid_to: "garbage" }));
    const r = await run(f.connect, ["err.com", "slow.com", "none.com", "bad.com"].map((host, i) => ({ siteId: `s${i}`, host })));
    expect(r.certs.map((c) => c.validTo)).toEqual([null, null, null, null]);
  });

  it("never connects to an IP literal or a .local or .internal name", async () => {
    const f = fake(() => "ok");
    const r = await run(f.connect, [{ siteId: "a", host: "10.0.0.5" }, { siteId: "b", host: "printer.local" }, { siteId: "c", host: "db.internal" }, { siteId: "d", host: "x;id.com" }, { siteId: "e", host: "ok.com" }]);
    expect(f.hosts).toEqual(["ok.com"]);
    expect(r.certs.map((c) => c.validTo)).toEqual([null, null, null, null, "2026-12-11"]);
  });

  it("does at most 5 at a time, in order", async () => {
    let open = 0, peak = 0;
    const connect: CertConnect = (o) => {
      open++; peak = Math.max(peak, open);
      const s = new EventEmitter() as any;
      s.getPeerCertificate = () => ({ valid_to: "Dec 11 23:59:59 2026 GMT" });
      s.destroy = () => {};
      setTimeout(() => { open--; s.emit("secureConnect"); }, 5);
      return s;
    };
    const hosts = Array.from({ length: 12 }, (_, i) => ({ siteId: `s${i}`, host: `h${i}.com` }));
    const r = await run(connect, hosts);
    expect(peak).toBe(5);
    expect(r.certs.map((c) => c.siteId)).toEqual(hosts.map((h) => h.siteId));
  });

  it("gives null for a year outside 1970..9999 instead of a +010000 date (T10)", async () => {
    const f = fake((h) => (h === "far.com" ? { valid_to: "Dec 11 23:59:59 10000 GMT" } : h === "old.com" ? { valid_to: "Dec 11 23:59:59 1969 GMT" } : "ok"));
    const r = await run(f.connect, [{ siteId: "a", host: "far.com" }, { siteId: "b", host: "old.com" }, { siteId: "c", host: "ok.com" }]);
    expect(r.certs.map((c) => c.validTo)).toEqual([null, null, "2026-12-11"]);
  });

  it("refuses a payload without hosts", async () => {
    await expect(careCertsHandler(fake(() => "ok").connect).run(ctx({}))).rejects.toThrow();
  });
});
