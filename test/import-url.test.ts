import { describe, it, expect } from "vitest";
import { importUrl, importUrlProblem } from "../src/worker/import/url";

describe("importUrl accepts public http(s) addresses and normalises to a scheme", () => {
  const ok: [string, string][] = [
    ["acme.com", "https://acme.com"],
    ["www.acme.com/path", "https://www.acme.com/path"],
    ["https://Acme.com/", "https://Acme.com/"],
    ["HTTP://acme.com", "http://acme.com"],
    ["httpbin.org", "https://httpbin.org"],
    ["httpwatch.com", "https://httpwatch.com"],
    ["https://sub.acme.co.uk/a?b=1", "https://sub.acme.co.uk/a?b=1"],
    ["  acme.com  ", "https://acme.com"],
    ["https://acme.com:443/", "https://acme.com:443/"],
  ];
  it.each(ok)("%s", (raw, url) => {
    const r = importUrl(raw);
    expect(r).toMatchObject({ ok: true, url });
    expect(importUrlProblem(raw)).toBeNull();
  });
  it("returns the lowercase host without www", () => {
    expect(importUrl("https://WWW.Acme.com/x")).toMatchObject({ ok: true, host: "acme.com" });
    expect(importUrl("httpbin.org")).toMatchObject({ ok: true, host: "httpbin.org" });
  });
});

describe("importUrl rejects internal, non-http and malformed addresses", () => {
  const bad: [string, RegExp][] = [
    ["http://127.0.0.1:8787/", /ip address|numeric/i],
    ["169.254.169.254", /ip address|numeric/i],
    ["10.0.0.5", /ip address|numeric/i],
    ["http://2130706433/", /ip address|numeric/i],
    ["http://0x7f.1/", /ip address|numeric|web address/i],
    ["[::1]", /ip address|web address/i],
    ["http://[::1]:3000/", /ip address|web address/i],
    ["http://localhost", /internal|local/i],
    ["http://localhost./", /internal|local/i],
    ["foo.localhost", /internal|local/i],
    ["printer.local", /internal|local/i],
    ["db.internal", /internal|local/i],
    ["router.lan", /internal|local/i],
    ["nas.home.arpa", /internal|local/i],
    ["nodot", /web address|dot|domain/i],
    ["https://user:pw@acme.com", /user|password|login/i],
    ["https://acme.com:8443", /port/i],
    ["acme.com:8080/x", /port/i],
    ["javascript:alert(1)", /http/i],
    ["file:///etc/passwd", /http/i],
    ["data:text/html,x", /http/i],
    ["ftp://acme.com", /http/i],
    ["httpx://a.com", /http/i],
    ["mailto:a@b.com", /http/i],
    ["acme .com", /space/i],
    ["", /web address|empty|enter/i],
  ];
  it.each(bad)("%s", (raw, why) => {
    const r = importUrl(raw);
    expect(r.ok).toBe(false);
    expect(importUrlProblem(raw)).toMatch(why);
  });
});
