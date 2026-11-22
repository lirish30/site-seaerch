import { describe, expect, it } from "vitest";
import { CITATION_DIRECTORIES, napCheck, normalizePhone, parseNapResult } from "../src/worker/seo/nap";

const NAP = { name: "Ace Plumbing", address: "12345 SW Main St., Tigard, OR 97224, USA", phone: "(503) 555-0147" };
const page = (body: string, url = "https://ace.test/") => ({ url, html: `<html><head><title>x</title></head><body>${body}</body></html>` });

describe("normalizePhone", () => {
  it("keeps ten digits and drops a leading 1", () => {
    expect(normalizePhone("(503) 555-0147")).toBe("5035550147");
    expect(normalizePhone("+1 503.555.0147")).toBe("5035550147");
    expect(normalizePhone("1-503-555-0147")).toBe("5035550147");
    expect(normalizePhone("503 555 0147")).toBe("5035550147");
  });
  it("is null for anything that is not a ten digit number", () => {
    expect(normalizePhone("555-0147")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("call us")).toBeNull();
    expect(normalizePhone("2 503 555 0147")).toBeNull();
    expect(normalizePhone("503555014799")).toBeNull();
  });
});

describe("napCheck phone", () => {
  it("is match when a footer shows the right phone, however it is written", () => {
    expect(napCheck([page("<footer>Call 503.555.0147 today</footer>")], NAP).phone).toBe("match");
    expect(napCheck([page(`<a href="tel:+15035550147">Call</a>`)], NAP).phone).toBe("match");
    expect(napCheck([page("<p>Wrong: (360) 555-0100</p>"), page("<p>(503) 555-0147</p>", "https://ace.test/contact")], NAP).phone).toBe("match");
  });
  it("is mismatch when the pages show phones and none is the right one", () => {
    expect(napCheck([page("<footer>Call (360) 555-0100</footer>")], NAP).phone).toBe("mismatch");
    expect(napCheck([page(`<a href="tel:3605550100">Call</a>`)], NAP).phone).toBe("mismatch");
  });
  it("is missing when no phone is shown, and order or licence numbers are not phones", () => {
    expect(napCheck([page("<footer>Licensed and insured. CCB 123456 order 20260101</footer>")], NAP).phone).toBe("missing");
    expect(napCheck([], NAP).phone).toBe("missing");
  });
  it("ignores phones inside scripts and comments", () => {
    expect(napCheck([page(`<script>var p = "(360) 555-0100";</script><!-- (360) 555-0101 --><p>hello</p>`)], NAP).phone).toBe("missing");
  });
});

describe("napCheck address", () => {
  it("matches the same number and street name written differently", () => {
    expect(napCheck([page("<p>12345 Southwest Main Street, Tigard</p>")], NAP).address).toBe("match");
    expect(napCheck([page("<p>12345 SW MAIN ST</p>")], NAP).address).toBe("match");
  });
  it("is missing when the number differs, or the street does", () => {
    expect(napCheck([page("<p>12999 SW Main St</p>")], NAP).address).toBe("missing");
    expect(napCheck([page("<p>12345 SW Oak St</p>")], NAP).address).toBe("missing");
  });
  it("needs both on one page, not one on each", () => {
    expect(napCheck([page("<p>12345 Oak St</p>"), page("<p>Main Street office</p>", "https://ace.test/about")], NAP).address).toBe("missing");
  });
  it("skips every direction word to find the street name", () => {
    const north = { ...NAP, address: "77 N Lombard St, Portland, OR" };
    expect(napCheck([page("<p>77 North Lombard Street</p>")], north).address).toBe("match");
    expect(napCheck([page("<p>77 N Portland Blvd</p>")], north).address).toBe("missing");
  });
  it("is unknown (nothing to compare) when the expected address has no number or street to look for", () => {
    expect(napCheck([page("<p>Main</p>")], { ...NAP, address: "Tigard, OR" }).address).toBe("unknown");
  });
  it("does not read a number inside a longer number", () => {
    expect(napCheck([page("<p>112345 SW Main St</p>")], NAP).address).toBe("missing");
  });
});

describe("napCheck on hostile pages", () => {
  it("reads a page of unclosed tags, scripts and comments in time, and an unclosed script hides the rest", () => {
    const started = Date.now();
    for (const junk of ["<".repeat(400_000), "<script ".repeat(60_000), "<!--".repeat(100_000), "<a href=\"tel:".repeat(40_000)]) {
      expect(napCheck([{ url: "https://ace.test/", html: junk }], NAP).checkedPages).toBe(1);
    }
    expect(Date.now() - started).toBeLessThan(2000);
    expect(napCheck([page("<script>unclosed (360) 555-0100 Ace Plumbing")], NAP)).toMatchObject({ phone: "missing", name: "missing" });
  });
});

describe("napCheck name and pages", () => {
  it("finds the name ignoring case, spacing and entities", () => {
    expect(napCheck([page("<h1>ACE   plumbing</h1>")], NAP).name).toBe("match");
    expect(napCheck([page("<h1>Ace Plumbing &amp; Heating</h1>")], { ...NAP, name: "Ace Plumbing & Heating" }).name).toBe("match");
    expect(napCheck([page("<h1>Best Plumbing</h1>")], NAP).name).toBe("missing");
  });
  it("counts the pages it looked at", () => {
    expect(napCheck([page("a"), page("b", "https://ace.test/contact")], NAP).checkedPages).toBe(2);
    expect(napCheck([], NAP)).toEqual({ phone: "missing", address: "missing", name: "missing", checkedPages: 0 });
  });
});

describe("constants", () => {
  it("lists the twelve directories", () => {
    expect(CITATION_DIRECTORIES).toEqual([
      "Apple Business Connect", "Bing Places", "Yelp", "Facebook", "BBB", "Nextdoor", "Angi", "HomeAdvisor", "Thumbtack", "Yellow Pages", "Chamber of commerce", "Manta",
    ]);
  });
  it("reads a stored result back, or null for anything else", () => {
    const r = { phone: "match", address: "missing", name: "match", checkedPages: 2 };
    expect(parseNapResult(JSON.stringify(r))).toEqual(r);
    expect(parseNapResult(null)).toBeNull();
    expect(parseNapResult("not json")).toBeNull();
    expect(parseNapResult(JSON.stringify({ phone: "bad" }))).toBeNull();
  });
});

describe("napCheck with nothing to compare", () => {
  const SITE = page("<h1>Ace Plumbing</h1><p>12345 SW Main St</p><footer>Call (360) 555-0100</footer>");
  it("is unknown for the phone when the listing has no phone, whatever the site shows", () => {
    expect(napCheck([SITE], { ...NAP, phone: "" }).phone).toBe("unknown");
    expect(napCheck([], { ...NAP, phone: "not a phone" }).phone).toBe("unknown");
  });
  it("is unknown for the address when the listing's address has no street number and name (a service-area business)", () => {
    expect(napCheck([SITE], { ...NAP, address: "Portland, OR" }).address).toBe("unknown");
    expect(napCheck([SITE], { ...NAP, address: "" }).address).toBe("unknown");
  });
  it("is unknown for the name when the listing has no name", () => {
    expect(napCheck([SITE], { ...NAP, name: "  " }).name).toBe("unknown");
  });
  it("still compares the parts that can be compared", () => {
    expect(napCheck([SITE], { name: "Ace Plumbing", address: "Portland, OR", phone: "" })).toEqual({ phone: "unknown", address: "unknown", name: "match", checkedPages: 1 });
  });
  it("reads a stored unknown part back", () => {
    expect(parseNapResult(JSON.stringify({ phone: "unknown", address: "match", name: "match", checkedPages: 2 }))).toEqual({ phone: "unknown", address: "match", name: "match", checkedPages: 2 });
  });
});
