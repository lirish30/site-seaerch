import { afterEach, describe, expect, it, vi } from "vitest";
import { ERROR_TEXT, PROBE_TIMEOUT_MS, SLOW_MS, monitorableUrl, probeSite } from "../src/worker/monitoring/probe";

afterEach(() => {
  vi.useRealTimers();
});

describe("monitorableUrl", () => {
  it("accepts ordinary http and https sites", () => {
    expect(monitorableUrl("https://acmeplumbing.com/")).toEqual({ ok: true, url: "https://acmeplumbing.com/" });
    expect(monitorableUrl("http://acmeplumbing.com")).toEqual({ ok: true, url: "http://acmeplumbing.com/" });
    expect(monitorableUrl("https://www.acmeplumbing.com/about?x=1")).toEqual({ ok: true, url: "https://www.acmeplumbing.com/about?x=1" });
  });

  it("turns a bare domain into an https URL", () => {
    expect(monitorableUrl("acmeplumbing.com")).toEqual({ ok: true, url: "https://acmeplumbing.com/" });
    expect(monitorableUrl("  acmeplumbing.com/shop ")).toEqual({ ok: true, url: "https://acmeplumbing.com/shop" });
  });

  it("allows public IP literals and does not over-block nearby ranges", () => {
    expect(monitorableUrl("http://8.8.8.8")).toEqual({ ok: true, url: "http://8.8.8.8/" });
    expect(monitorableUrl("http://172.32.0.1")).toEqual({ ok: true, url: "http://172.32.0.1/" });
    expect(monitorableUrl("http://[2606:4700:4700::1111]")).toEqual({ ok: true, url: "http://[2606:4700:4700::1111]/" });
  });

  const blocked = { ok: false, reason: ERROR_TEXT.blocked };
  it.each([
    "http://localhost",
    "http://localhost:8787/admin",
    "http://LOCALHOST./",
    "http://app.localhost",
    "http://127.0.0.1",
    "http://127.255.0.9",
    "http://0.0.0.0",
    "http://10.0.0.5",
    "http://192.168.1.1",
    "http://172.16.0.1",
    "http://172.31.255.255",
    "http://169.254.169.254",
    "http://100.64.0.1",
    "http://224.0.0.1",
    "http://printer.local",
    "http://db.internal",
    "http://intranet",
    "file:///etc/passwd",
    "ftp://acmeplumbing.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "",
    "   ",
  ])("blocks %j", (raw) => {
    expect(monitorableUrl(raw)).toEqual(blocked);
  });

  it("blocks null and a bare host that is internal", () => {
    expect(monitorableUrl(null)).toEqual(blocked);
    expect(monitorableUrl("localhost:3000")).toEqual(blocked);
    expect(monitorableUrl("printer.local")).toEqual(blocked);
  });

  it.each([
    "http://[::1]",
    "http://[::]",
    "http://[fc00::1]",
    "http://[fd12:3456:789a::1]",
    "http://[fe80::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:10.0.0.5]",
    "http://[::ffff:169.254.169.254]",
    "http://[64:ff9b::7f00:1]",
    "http://[2002:7f00:1::1]",
    "http://[ff02::1]",
  ])("blocks the IPv6 literal %s", (raw) => {
    expect(monitorableUrl(raw)).toEqual(blocked);
  });

  // new URL() rewrites these to dotted form; the guard must see the rewritten host.
  it.each([
    "http://2130706433",
    "http://0x7f.0.0.1",
    "http://0177.0.0.1",
    "http://127.1",
    "http://0xa9fea9fe",
    "http://10.1",
  ])("blocks the numeric IPv4 spelling %s", (raw) => {
    expect(monitorableUrl(raw)).toEqual(blocked);
  });
});

function res(status: number): Response {
  return new Response(null, { status });
}
const clock = (...ticks: number[]) => {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
};

describe("probeSite", () => {
  it.each([200, 401, 403])("treats %i as up", async (status) => {
    const fetchFn = vi.fn(async () => res(status));
    const r = await probeSite("https://acmeplumbing.com/", fetchFn as unknown as typeof fetch, clock(0, 120));
    expect(r).toEqual({ ok: true, status, ms: 120, error: null, slow: false });
  });

  it("follows a redirect to a final 200", async () => {
    const fetchFn = vi.fn(async () => {
      const r = res(200);
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    });
    const r = await probeSite("https://acmeplumbing.com/", fetchFn as unknown as typeof fetch, clock(0, 90));
    expect(r.ok).toBe(true);
    expect((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ redirect: "follow", headers: { "user-agent": "SitelineMonitor/1.0" } });
  });

  it.each([404, 410, 500, 503])("treats %i as down with the status as the error", async (status) => {
    const r = await probeSite("https://acmeplumbing.com/", (async () => res(status)) as unknown as typeof fetch, clock(0, 50));
    expect(r).toMatchObject({ ok: false, status, error: `HTTP ${status}` });
  });

  it("gives the fixed connect text for a throw and never copies the thrown message", async () => {
    const fetchFn = (async () => {
      throw new TypeError("secret internal host db.corp");
    }) as unknown as typeof fetch;
    const r = await probeSite("https://acmeplumbing.com/", fetchFn, clock(0, 30));
    expect(r).toEqual({ ok: false, status: null, ms: 30, error: ERROR_TEXT.connect, slow: false });
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(JSON.stringify(r)).not.toContain("db.corp");
  });

  it("never reads the response body", async () => {
    const text = vi.fn();
    const json = vi.fn();
    const arrayBuffer = vi.fn();
    const fake = { status: 200, ok: true, body: null, text, json, arrayBuffer } as unknown as Response;
    const r = await probeSite("https://acmeplumbing.com/", (async () => fake) as unknown as typeof fetch, clock(0, 10));
    expect(r.ok).toBe(true);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("times out after the probe limit when the site never answers", async () => {
    vi.useFakeTimers();
    const fetchFn = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted: db.corp", "AbortError")));
      })) as unknown as typeof fetch;
    let t = 0;
    const pending = probeSite("https://acmeplumbing.com/", fetchFn, () => t);
    t = PROBE_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    const r = await pending;
    expect(r).toEqual({ ok: false, status: null, ms: PROBE_TIMEOUT_MS, error: ERROR_TEXT.timeout, slow: false });
    expect(JSON.stringify(r)).not.toContain("db.corp");
  });

  it("does not leave the timeout timer running after a fast answer", async () => {
    vi.useFakeTimers();
    await probeSite("https://acmeplumbing.com/", (async () => res(200)) as unknown as typeof fetch, clock(0, 5));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks a slow success slow and a fast one not", async () => {
    const ok = (async () => res(200)) as unknown as typeof fetch;
    expect((await probeSite("https://acmeplumbing.com/", ok, clock(1000, 7000))).slow).toBe(true);
    expect((await probeSite("https://acmeplumbing.com/", ok, clock(1000, 1000 + SLOW_MS))).slow).toBe(false);
    expect((await probeSite("https://acmeplumbing.com/", ok, clock(1000, 1100))).slow).toBe(false);
  });
});
