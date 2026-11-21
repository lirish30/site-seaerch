import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDomainExpiry, parseRdapExpiry } from "../src/worker/monitoring/rdap";

afterEach(() => {
  vi.useRealTimers();
});

const doc = {
  objectClassName: "domain",
  ldhName: "acmeplumbing.com",
  events: [
    { eventAction: "registration", eventDate: "2015-03-14T18:22:10Z" },
    { eventAction: "expiration", eventDate: "2027-03-14T18:22:10Z" },
    { eventAction: "last changed", eventDate: "2026-02-01T09:00:00Z" },
  ],
};

describe("parseRdapExpiry", () => {
  it("reads the expiration event as YYYY-MM-DD", () => {
    expect(parseRdapExpiry(doc)).toBe("2027-03-14");
  });

  it("gives null for anything that is not a usable document", () => {
    expect(parseRdapExpiry(null)).toBeNull();
    expect(parseRdapExpiry([])).toBeNull();
    expect(parseRdapExpiry({})).toBeNull();
    expect(parseRdapExpiry("2027-03-14")).toBeNull();
    expect(parseRdapExpiry({ events: "nope" })).toBeNull();
    expect(parseRdapExpiry({ events: [null, 5, "x"] })).toBeNull();
    expect(parseRdapExpiry({ events: [{ eventAction: "registration", eventDate: "2015-03-14T00:00:00Z" }] })).toBeNull();
  });

  it("gives null when the expiration value is not a date", () => {
    expect(parseRdapExpiry({ events: [{ eventAction: "expiration", eventDate: "soon" }] })).toBeNull();
    expect(parseRdapExpiry({ events: [{ eventAction: "expiration", eventDate: 20270314 }] })).toBeNull();
    expect(parseRdapExpiry({ events: [{ eventAction: "expiration" }] })).toBeNull();
    expect(parseRdapExpiry({ events: [{ eventAction: "expiration", eventDate: "2027-13-45T00:00:00Z" }] })).toBeNull();
  });

  it("skips a bad expiration event and uses a later good one", () => {
    expect(
      parseRdapExpiry({ events: [{ eventAction: "expiration", eventDate: "x" }, { eventAction: "expiration", eventDate: "2028-01-02T00:00:00Z" }] }),
    ).toBe("2028-01-02");
  });
});

describe("fetchDomainExpiry", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/rdap+json" } });

  it("requests rdap.org with the rdap accept header and returns the expiry", async () => {
    const fetchFn = vi.fn(async () => json(doc));
    expect(await fetchDomainExpiry("acmeplumbing.com", fetchFn as unknown as typeof fetch)).toEqual({ kind: "found", expiresOn: "2027-03-14" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rdap.org/domain/acmeplumbing.com");
    expect(init.headers).toMatchObject({ accept: "application/rdap+json" });
  });

  it("never requests a domain that fails the shape check", async () => {
    const fetchFn = vi.fn(async () => json(doc));
    for (const bad of ["not a domain", "", "localhost", "a.b/../c.com", "acme.com/x", "-.", "acme.c", "acme.com\n"]) {
      expect(await fetchDomainExpiry(bad, fetchFn as unknown as typeof fetch)).toEqual({ kind: "unknown" });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  const lookup = (fetchFn: unknown) => fetchDomainExpiry("acmeplumbing.com", fetchFn as typeof fetch);

  it("a clean 404 and a document with no expiration event are unknown: the registry answered, there is just no date", async () => {
    expect(await lookup(async () => json(doc, 404))).toEqual({ kind: "unknown" });
    expect(await lookup(async () => json({ events: [{ eventAction: "registration", eventDate: "2015-03-14T00:00:00Z" }] }))).toEqual({ kind: "unknown" });
    expect(await lookup(async () => json({}))).toEqual({ kind: "unknown" });
  });

  it("a rate limit, a server error, a body that is not JSON and a throw are failed: to be tried again", async () => {
    for (const status of [429, 500, 502, 503, 403]) expect(await lookup(async () => json(doc, status)), `status ${status}`).toEqual({ kind: "failed" });
    expect(await lookup(async () => new Response("<html>", { status: 200 }))).toEqual({ kind: "failed" });
    expect(await lookup(async () => { throw new TypeError("boom"); })).toEqual({ kind: "failed" });
  });

  it("is failed after 5 seconds of silence", async () => {
    vi.useFakeTimers();
    const fetchFn = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const pending = fetchDomainExpiry("acmeplumbing.com", fetchFn);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({ kind: "failed" });
  });
});
