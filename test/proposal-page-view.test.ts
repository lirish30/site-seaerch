import { describe, expect, it } from "vitest";
import { formatExpiry, mailtoOf, nameProblem, payError, safeHttpsUrl, signError, signReady } from "../src/client/proposalPageView";

describe("signReady", () => {
  const ok = { name: "Pat Jones", consent: true, authority: true };

  it("signReady lists the first missing thing", () => {
    expect(signReady({ name: "", consent: false, authority: false })).toMatch(/agree to sign electronically/i);
    expect(signReady({ name: "", consent: true, authority: false })).toMatch(/sign for the business/i);
    expect(signReady({ name: "", consent: true, authority: true })).toMatch(/full name/i);
    expect(signReady({ name: "A", consent: true, authority: true })).toMatch(/full name/i);
    expect(signReady({ name: "12 34", consent: true, authority: true })).toMatch(/letter/i);
    expect(signReady({ name: "x".repeat(121), consent: true, authority: true })).toMatch(/too long/i);
    expect(signReady({ ...ok, name: "Pat\u202eJones" })).toMatch(/hidden/i);
  });

  it("is null once everything is there, and the name is judged after trimming", () => {
    expect(signReady(ok)).toBeNull();
    expect(signReady({ ...ok, name: "  Jo  " })).toBeNull();
    expect(signReady({ ...ok, name: "   " })).toMatch(/full name/i);
    expect(signReady({ ...ok, consent: false })).not.toBeNull();
    expect(signReady({ ...ok, authority: false })).not.toBeNull();
  });
});

describe("nameProblem", () => {
  it("accepts ordinary names, with accents, apostrophes, hyphens and other scripts", () => {
    for (const n of ["Pat Jones", "Mary-Jane O'Neil", "Dr. José Núñez", "李雷", "Al", "x".repeat(120)]) expect(nameProblem(n), n).toBeNull();
  });

  it("refuses control characters, line separators, bidi overrides, isolates and zero-width spaces", () => {
    for (const bad of ["Pat\u0000Jones", "Pat\tJones", "Pat\nJones", "Pat\u007fJones", "Pat\u0085Jones", "Pat\u2028Jones", "Pat\u202eJones", "Pat\u202aJones",
      "Pat\u2066Jones", "Pat\u2069Jones", "Pat\u200eJones", "Pat\u200fJones", "Pat\u061cJones", "Pat\u200bJones", "Pat\ufeffJones"]) {
      expect(nameProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("refuses names that are invisible or have fewer than two visible letters", () => {
    const bad = ["\u3164\u3164", "A\u2060\u2060", "\u00adA\u00ad", "\u115f\u1160", "\uffa0\uffa0", "\u17b4\u17b5", "\u034f\u034f", "\u2800\u2800", "\u2060\u2060",
      "A\u3164", "A\u2800", "A\u00ad", "A\u17b4", "A\u034f", "A\u1160", "A\uffa0", "A\u115f", "A\u200b"];
    for (const n of bad) expect(nameProblem(n), JSON.stringify(n)).not.toBeNull();
    expect(nameProblem("A 1")).toMatch(/letter/i); // one visible letter
  });

  it("keeps joiners and ordinary names with accents", () => {
    for (const n of ["Jos\u00e9 N\u00fa\u00f1ez", "Re\u200dza Karimi", "\u0645\u0631\u0636\u064a\u0629\u200c\u0645", "Zo\u00eb O\u2019Brien", "Anne-Marie"]) expect(nameProblem(n), JSON.stringify(n)).toBeNull();
  });

  it("counts characters, not UTF-16 units", () => {
    expect(nameProblem("😀😀")).toMatch(/letter/i); // two characters, no letter
    expect(nameProblem("Aé".repeat(60))).toBeNull(); // 120 characters
    expect(nameProblem("Aé".repeat(61))).toMatch(/too long/i);
  });
});

describe("formatExpiry", () => {
  const now = new Date("2026-12-01T12:00:00.000Z");
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const DAY = 86_400_000;

  it("formatExpiry boundaries", () => {
    expect(formatExpiry(at(0), now)).toBe("expired");
    expect(formatExpiry(at(-1), now)).toBe("expired");
    expect(formatExpiry(at(-5 * DAY), now)).toBe("expired");
    expect(formatExpiry(at(1), now)).toBe("expires today");
    expect(formatExpiry(at(DAY - 1), now)).toBe("expires today");
    expect(formatExpiry(at(DAY), now)).toBe("expires in 1 day");
    expect(formatExpiry(at(2 * DAY - 1), now)).toBe("expires in 1 day");
    expect(formatExpiry(at(2 * DAY), now)).toBe("expires in 2 days");
    expect(formatExpiry(at(12 * DAY + 3_600_000), now)).toBe("expires in 12 days");
  });

  it("an unreadable date reads as expired rather than open", () => {
    expect(formatExpiry("not a date", now)).toBe("expired");
  });
});

describe("signError", () => {
  it("has plain copy for each failure, and never echoes anything", () => {
    expect(signError(400)).toMatch(/name/i);
    expect(signError(409)).toMatch(/changed|no longer open/i);
    expect(signError(429)).toMatch(/wait/i);
    expect(signError(404)).toMatch(/no longer available/i);
    expect(signError(0)).toMatch(/connection/i);
    expect(signError(500)).toMatch(/went wrong/i);
  });
});

describe("safeHttpsUrl and mailtoOf", () => {
  it("only an https address is a link", () => {
    expect(safeHttpsUrl("https://pay.example.com/i/1?x=2")).toBe("https://pay.example.com/i/1?x=2");
    for (const bad of ["http://pay.example.com", "javascript:alert(1)", "data:text/html,x", "//evil.example", "", "not a url", " https://x.example"]) expect(safeHttpsUrl(bad), bad).toBeNull();
  });

  it("only a plain address is a mailto link", () => {
    expect(mailtoOf("logan@siteline.test")).toBe("mailto:logan@siteline.test");
    for (const bad of ["", "no at sign", "a@b.co?subject=x&bcc=evil@x.co", "a b@c.co", "<a@b.co>", "a@b.co\nBcc: x@y.co"]) expect(mailtoOf(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("payError", () => {
  it("names the one thing the client can do, and shows nothing the server sent", () => {
    expect(payError(500)).toBe("We couldn't open the payment page. Try again.");
    expect(payError(200)).toBe("We couldn't open the payment page. Try again.");
    expect(payError(404)).toMatch(/no longer available/);
    expect(payError(429)).toMatch(/Too many tries/);
    expect(payError(0)).toMatch(/could not reach the server/);
  });
});
