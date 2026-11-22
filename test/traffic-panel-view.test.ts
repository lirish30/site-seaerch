import { describe, expect, it } from "vitest";
import { accessLine, analyticsAccessLine, foundLine, hasLink, lastMonthOf, linkBody, linkedLines, monthRows, periodLabel } from "../src/client/trafficPanelView";

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
