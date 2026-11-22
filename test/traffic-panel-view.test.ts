import { describe, expect, it } from "vitest";
import {
  PROFILE_CONNECT_PATH, PROFILE_HELP, accessLine, analyticsAccessLine, canClearLocation, canFind, canLink, canPull, canSaveLocation, canUnlink, foundLine, ga4IdProblem, hasLink, lastMonthOf, linkBody, linkedLines, locationBody, locationProblem,
  monthRows, needsDomain, periodLabel, profileNote, pullResult, showPanel, siteName, unlinkQuestion,
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
    expect(linkedLines({ gscProperty: null, ga4Property: null, gbpLocation: null })).toEqual([]);
    expect(linkedLines({ gscProperty: "sc-domain:ace.com", ga4Property: "123456789", gbpLocation: null })).toEqual(["Search Console: sc-domain:ace.com", "Analytics property: 123456789"]);
    expect(linkedLines({ gscProperty: null, ga4Property: null, gbpLocation: "locations/1234567890" })).toEqual(["Business Profile: locations/1234567890"]);
    expect(hasLink({ gscProperty: null, ga4Property: "1", gbpLocation: null })).toBe(true);
    expect(hasLink({ gscProperty: null, ga4Property: null, gbpLocation: "locations/123456" })).toBe(true);
    expect(hasLink({ gscProperty: null, ga4Property: null, gbpLocation: null })).toBe(false);
  });
  it("sends only the sources that were chosen, and nothing when none was", () => {
    expect(linkBody({ gsc: "", ga4: "" })).toBeNull();
    expect(linkBody({ gsc: "sc-domain:ace.com", ga4: "" })).toEqual({ gscProperty: "sc-domain:ace.com" });
    expect(linkBody({ gsc: "", ga4: "123456789" })).toEqual({ ga4Property: "123456789" });
    expect(linkBody({ gsc: "a", ga4: "1" })).toEqual({ gscProperty: "a", ga4Property: "1" });
  });
});

describe("a typed Analytics property id (I2)", () => {
  it("sends the typed id as ga4Property, and it wins over the select", () => {
    expect(linkBody({ gsc: "", ga4: "", ga4Typed: "  412345678 " })).toEqual({ ga4Property: "412345678" });
    expect(linkBody({ gsc: "", ga4: "123456789", ga4Typed: "412345678" })).toEqual({ ga4Property: "412345678" });
    expect(linkBody({ gsc: "sc-domain:ace.com", ga4: "", ga4Typed: "12345" })).toEqual({ gscProperty: "sc-domain:ace.com", ga4Property: "12345" });
    expect(linkBody({ gsc: "", ga4: "123456789", ga4Typed: "" })).toEqual({ ga4Property: "123456789" });
    expect(linkBody({ gsc: "", ga4: "123456789", ga4Typed: "   " })).toEqual({ ga4Property: "123456789" });
  });
  it("takes 5 to 15 digits and nothing else; a typed id that is not one sends nothing at all (not the select either)", () => {
    for (const bad of ["1234", "1234567890123456", "properties/12345", "12a45", "12 345", "-12345"]) {
      expect(ga4IdProblem(bad), bad).toBe("That is not an Analytics property id. It is 5 to 15 digits.");
      expect(linkBody({ gsc: "sc-domain:ace.com", ga4: "123456789", ga4Typed: bad }), bad).toBeNull();
      expect(canLink(linkBody({ gsc: "", ga4: "123456789", ga4Typed: bad }), false), bad).toBe(false);
    }
    for (const good of ["12345", "123456789012345", " 12345 ", ""]) expect(ga4IdProblem(good), good).toBeNull();
  });
  it("a typed id enables the Link button, and nothing runs while busy", () => {
    expect(canLink(linkBody({ gsc: "", ga4: "", ga4Typed: "412345678" }), false)).toBe(true);
    expect(canLink(linkBody({ gsc: "", ga4: "", ga4Typed: "412345678" }), true)).toBe(false);
  });
});

describe("monthRows", () => {
  const month = (over: object) => ({ period: "2026-11", status: "ok" as const, pulledAt: "2026-12-04T00:00:00.000Z", error: "", search: null, visits: null, profile: null, ...over });
  it("words what Google counted, leaving out a block that was not read and never showing it as 0", () => {
    const [a, b, c, d, e2] = monthRows([
      month({ search: { clicks: 1, impressions: 1 }, visits: { sessions: 1 } }),
      month({ period: "2026-10", search: { clicks: 7, impressions: 70 } }),
      month({ period: "2026-09" }),
      month({ period: "2026-08", search: { clicks: 0, impressions: 0 } }),
      month({ period: "2026-07", profile: { calls: 0 } }),
    ]);
    expect(a.numbers).toBe("1 click from 1 search result, 1 visit");
    expect(a.label).toBe("November 2026");
    expect(b.numbers).toBe("7 clicks from 70 search results");
    expect(c.numbers).toBe("");
    expect(d.numbers).toBe("0 clicks from 0 search results");
    expect(e2.numbers).toBe("0 calls from the profile");
    expect(monthRows([month({ visits: { sessions: 2 }, profile: { calls: 1 } })])[0].numbers).toBe("2 visits, 1 call from the profile");
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
  const linked = { domain: "ace.com", gscProperty: "sc-domain:ace.com", ga4Property: null, gbpLocation: null };
  const bare = { domain: "ace.com", gscProperty: null, ga4Property: null, gbpLocation: null };
  const noDomain = { domain: null, gscProperty: null, ga4Property: null, gbpLocation: null };

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
    expect(showPanel({ sites: [{ siteId: "s", domain: null, gscProperty: null, ga4Property: null, gbpLocation: null, lastError: "", months: [] }] })).toBe(true);
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

describe("the Business Profile location field", () => {
  const withLocation = { domain: "ace.com", gscProperty: null, ga4Property: null, gbpLocation: "locations/1234567890" };
  const none = { domain: "ace.com", gscProperty: null, ga4Property: null, gbpLocation: null };

  it("shows the plain help text and the permission note only while the connected account lacks the permission", () => {
    expect(PROFILE_HELP).toBe("From your Business Profile API access (the location id looks like locations/1234567890)");
    expect(PROFILE_CONNECT_PATH).toBe("/api/google/connect?profile=1");
    expect(profileNote({ connected: true, hasProfileScope: false })).toBe("The connected Google account does not have the Business Profile permission yet. A location can only be saved once it has.");
    expect(profileNote({ connected: true, hasProfileScope: true })).toBeNull();
    expect(profileNote({ connected: false, hasProfileScope: false })).toBeNull();
  });

  it("sends a pasted location trimmed, and nothing for a blank or a wrong one", () => {
    expect(locationBody("  locations/1234567890 ")).toEqual({ gbpLocation: "locations/1234567890" });
    for (const bad of ["", "   ", "1234567890", "https://business.google.com/locations/1234567890", "locations/12", "ChIJN1t_tDeuEmsRUsoyG83frY4"]) expect(locationBody(bad)).toBeNull();
  });

  it("says what is wrong with a pasted location only when something was typed that does not fit", () => {
    expect(locationProblem("")).toBeNull();
    expect(locationProblem("locations/1234567890")).toBeNull();
    expect(locationProblem("1234567890")).toBe("That is not a location id. It looks like locations/1234567890.");
  });

  it("saves only a new, valid location, with the permission and nothing else running; clears only a saved one", () => {
    expect(canSaveLocation("locations/1234567890", none, false, true)).toBe(true);
    expect(canSaveLocation("locations/1234567890", none, true, true)).toBe(false);
    expect(canSaveLocation("locations/1234567890", none, false, false)).toBe(false);
    expect(canSaveLocation("locations/1234567890", withLocation, false, true)).toBe(false);
    expect(canSaveLocation("nope", none, false, true)).toBe(false);
    expect(canSaveLocation("", none, false, true)).toBe(false);
    expect(canClearLocation(withLocation, false)).toBe(true);
    expect(canClearLocation(withLocation, true)).toBe(false);
    expect(canClearLocation(none, false)).toBe(false);
  });
});
