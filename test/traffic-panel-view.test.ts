import { describe, expect, it } from "vitest";
import {
  accessLine, analyticsAccessLine, canFind, canLink, canPull, canUnlink, foundLine, hasLink, lastMonthOf, linkBody, linkedLines, monthRows, needsDomain, periodLabel, pullResult, showPanel, siteName, unlinkQuestion,
} from "../src/client/trafficPanelView";

describe("accessLine", () => {
  it("names the client and the connected account when Google is connected with both scopes", () => {
    expect(accessLine({ connected: true, hasScopes: true, email: "me@x.test" }, "Ace Plumbing")).toBe("Ask Ace Plumbing to add me@x.test as a viewer on their Search Console and Analytics.");
  });
  it("says to connect Google first when it is not connected, and to reconnect when a scope is missing", () => {
    expect(accessLine({ connected: false, hasScopes: false, email: null }, "Ace")).toBe("Connect your Google account in Settings first.");
    expect(accessLine({ connected: true, hasScopes: false, email: "me@x.test" }, "Ace")).toBe("Reconnect Google in Settings to add Search Console and Analytics.");
  });
});

describe("lastMonthOf and periodLabel", () => {
  it("is the month before today's, rolling January back to December", () => {
    expect(lastMonthOf("2026-12-10")).toBe("2026-11");
    expect(lastMonthOf("2027-01-02")).toBe("2026-12");
    expect(lastMonthOf("soon")).toBeNull();
    expect(periodLabel("2026-11")).toBe("November 2026");
    expect(periodLabel("nope")).toBe("nope");
  });
});

describe("linkedLines, hasLink and linkBody", () => {
  it("lists only what is linked, as plain text", () => {
    expect(linkedLines({ gscProperty: null, ga4Property: null })).toEqual([]);
    expect(linkedLines({ gscProperty: "sc-domain:ace.com", ga4Property: "123456789" })).toEqual(["Search Console: sc-domain:ace.com", "Analytics property: 123456789"]);
    expect(hasLink({ gscProperty: null, ga4Property: "1" })).toBe(true);
    expect(hasLink({ gscProperty: null, ga4Property: null })).toBe(false);
  });
  it("sends only the sources that were chosen, and nothing when none was", () => {
    expect(linkBody({ gsc: "", ga4: "" })).toBeNull();
    expect(linkBody({ gsc: "sc-domain:ace.com", ga4: "" })).toEqual({ gscProperty: "sc-domain:ace.com" });
    expect(linkBody({ gsc: "", ga4: "123456789" })).toEqual({ ga4Property: "123456789" });
    expect(linkBody({ gsc: "a", ga4: "1" })).toEqual({ gscProperty: "a", ga4Property: "1" });
  });
});

describe("monthRows", () => {
  const month = (over: object) => ({ period: "2026-11", status: "ok" as const, pulledAt: "2026-12-04T00:00:00.000Z", error: "", search: null, visits: null, ...over });
  it("words what Google counted, leaving out a block that was not read and never showing it as 0", () => {
    const [a, b, c, d] = monthRows([
      month({ search: { clicks: 1, impressions: 1 }, visits: { sessions: 1 } }),
      month({ period: "2026-10", search: { clicks: 7, impressions: 70 } }),
      month({ period: "2026-09" }),
      month({ period: "2026-08", search: { clicks: 0, impressions: 0 } }),
    ]);
    expect(a.numbers).toBe("1 click from 1 search result, 1 visit");
    expect(a.label).toBe("November 2026");
    expect(b.numbers).toBe("7 clicks from 70 search results");
    expect(c.numbers).toBe("");
    expect(d.numbers).toBe("0 clicks from 0 search results");
  });
  it("keeps the plain sentence only for a month that was not read in full", () => {
    const [ok, partial, failed] = monthRows([month({ error: "old" }), month({ status: "partial", error: "Google did not answer." }), month({ status: "failed", error: "Reconnect Google in Settings." })]);
    expect([ok.error, partial.error, failed.error]).toEqual(["", "Google did not answer.", "Reconnect Google in Settings."]);
    expect([ok.statusWord, partial.statusWord, failed.statusWord]).toEqual(["Read in full", "Read in part", "Could not be read"]);
    expect([ok.tone, partial.tone, failed.tone]).toEqual(["positive", "warning", "critical"]);
  });
});

describe("analyticsAccessLine and foundLine", () => {
  it("reports the checklist's Analytics item, or nothing when the record has none", () => {
    expect(analyticsAccessLine([{ key: "hosting", status: "verified" }, { key: "analytics", status: "requested" }])).toBe("Analytics access on the checklist: Requested");
    expect(analyticsAccessLine([{ key: "hosting", status: "verified" }])).toBeNull();
  });
  it("says so when nothing was found for the site", () => {
    expect(foundLine({ gsc: [], ga4: [], email: "me@x.test" })).toContain("Nothing found");
    expect(foundLine({ gsc: [{ siteUrl: "sc-domain:ace.com", label: "ace.com" }], ga4: [], email: null })).toBe("Choose what to link.");
  });
});

describe("what the buttons may do", () => {
  const linked = { domain: "ace.com", gscProperty: "sc-domain:ace.com", ga4Property: null };
  const bare = { domain: "ace.com", gscProperty: null, ga4Property: null };
  const noDomain = { domain: null, gscProperty: null, ga4Property: null };

  it("everything is off while something else is running", () => {
    expect(canFind(linked, true)).toBe(false);
    expect(canPull(linked, true, "2026-11")).toBe(false);
    expect(canUnlink(linked, true)).toBe(false);
    expect(canLink({ gscProperty: "sc-domain:ace.com" }, true)).toBe(false);
  });

  it("with nothing running, a linked site with a domain can find, pull and unlink", () => {
    expect(canFind(linked, false)).toBe(true);
    expect(canPull(linked, false, "2026-11")).toBe(true);
    expect(canUnlink(linked, false)).toBe(true);
  });

  it("a site with no domain cannot find (an empty domain is no domain either)", () => {
    expect(needsDomain(noDomain)).toBe(true);
    expect(needsDomain({ ...noDomain, domain: "" })).toBe(true);
    expect(needsDomain(bare)).toBe(false);
    expect(canFind(noDomain, false)).toBe(false);
    expect(canFind({ ...noDomain, domain: "" }, false)).toBe(false);
    expect(canFind(bare, false)).toBe(true);
  });

  it("a site with nothing linked cannot pull or unlink, and a pull needs a month", () => {
    expect(canPull(bare, false, "2026-11")).toBe(false);
    expect(canUnlink(bare, false)).toBe(false);
    expect(canPull(linked, false, null)).toBe(false);
  });

  it("an empty choice cannot be linked", () => {
    expect(canLink(linkBody({ gsc: "", ga4: "" }), false)).toBe(false);
    expect(canLink(linkBody({ gsc: "", ga4: "123456789" }), false)).toBe(true);
  });

  it("the panel is hidden for a client with no sites", () => {
    expect(showPanel({ sites: [] })).toBe(false);
    expect(showPanel({ sites: [{ siteId: "s", domain: null, gscProperty: null, ga4Property: null, lastError: "", months: [] }] })).toBe(true);
  });

  it("names the site and asks before unlinking it", () => {
    expect(siteName(bare)).toBe("ace.com");
    expect(siteName(noDomain)).toBe("This site");
    expect(unlinkQuestion(bare)).toBe("Unlink ace.com from Google? The months already pulled stay.");
  });
});

describe("pullResult", () => {
  it("is plain news for a month read in full and a problem for anything else", () => {
    expect(pullResult({ status: "ok", error: "" })).toEqual({ text: "Pulled last month.", tone: "ok" });
    expect(pullResult({ status: "ok", error: "an old sentence" }).tone).toBe("ok");
    expect(pullResult({ status: "partial", error: "Google did not answer." })).toEqual({ text: "Google did not answer.", tone: "error" });
    expect(pullResult({ status: "failed", error: "" })).toEqual({ text: "Last month could not be read.", tone: "error" });
  });
});
