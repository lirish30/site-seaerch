import { describe, expect, it } from "vitest";
import { allSelected, bulkSummary, normalizeTag, pruneSelection, someSelected, toggleId, togglePage } from "../src/client/bulkView";
import { defaultView, parseView, serializeView, type LeadView } from "../src/client/savedFilters";
import { defaultFilters } from "../src/client/leadFilters";
import { normalizeTag as serverNormalizeTag } from "../src/worker/db/businesses";

const S = (...ids: string[]) => new Set(ids);

describe("selection", () => {
  it("toggles one id without mutating the original", () => {
    const a = S("1");
    expect([...toggleId(a, "2")].sort()).toEqual(["1", "2"]);
    expect([...toggleId(a, "1")]).toEqual([]);
    expect([...a]).toEqual(["1"]);
  });
  it("select-all-on-page selects the page, then deselects just the page, leaving other pages alone", () => {
    const page = ["a", "b", "c"];
    const first = togglePage(S("z"), page);
    expect([...first].sort()).toEqual(["a", "b", "c", "z"]);
    expect(allSelected(first, page)).toBe(true);
    expect([...togglePage(first, page)]).toEqual(["z"]);
  });
  it("a partly selected page becomes fully selected", () => {
    expect(someSelected(S("a"), ["a", "b"])).toBe(true);
    expect(allSelected(S("a"), ["a", "b"])).toBe(false);
    expect(allSelected(S(), [])).toBe(false);
    expect([...togglePage(S("a"), ["a", "b"])].sort()).toEqual(["a", "b"]);
  });
  it("drops ids that left the view and keeps the same set when nothing left", () => {
    const sel = S("a", "gone");
    expect([...pruneSelection(sel, ["a", "b"])]).toEqual(["a"]);
    const same = S("a");
    expect(pruneSelection(same, ["a", "b"])).toBe(same);
  });
});

describe("bulkSummary", () => {
  it("words each action, with the count pluralised", () => {
    expect(bulkSummary({ action: "archive" }, { updated: 3, skipped: 0, undoToken: "t" })).toBe("Archived 3 leads.");
    expect(bulkSummary({ action: "restore" }, { updated: 1, skipped: 0, undoToken: "t" })).toBe("Restored 1 lead.");
    expect(bulkSummary({ action: "status", status: "contacted" }, { updated: 2, skipped: 0, undoToken: "t" })).toBe("Set status to contacted on 2 leads.");
    expect(bulkSummary({ action: "tag", tag: "hot" }, { updated: 2, skipped: 1, undoToken: "t" })).toBe('Added tag "hot" to 2 leads. 1 lead already matched or couldn\'t take it, so left alone.');
    expect(bulkSummary({ action: "untag", tag: "hot" }, { updated: 1, skipped: 0, undoToken: "t" })).toBe('Removed tag "hot" from 1 lead.');
  });
  it("says so when nothing changed", () => {
    expect(bulkSummary({ action: "archive" }, { updated: 0, skipped: 2, undoToken: null })).toMatch(/^Nothing changed\. 2 leads/);
  });
});

describe("saved filter serialisation", () => {
  const view = (o: Partial<Omit<LeadView, "table">> & { f?: Partial<typeof defaultFilters>; q?: string; niche?: string } = {}): LeadView => {
    const { f, q, niche, ...top } = o;
    return { ...defaultView, ...top, table: { q: q ?? "", niche: niche ?? "", f: { ...defaultFilters, ...(f ?? {}) } } };
  };

  it("the default view serializes to nothing and parses back to the default", () => {
    expect(serializeView(defaultView)).toBe("");
    expect(parseView("")).toEqual(defaultView);
  });
  it("round-trips every filter", () => {
    const v = view({ status: "contacted", archived: true, tag: "hot lead", q: "plumb & co", niche: "trades",
      f: { offer: "new_site", platform: "wix", hideSkipped: false, emailOnly: true, minScore: 40, minReviews: 10, maxRating: 4.2 } });
    expect(parseView(serializeView(v))).toEqual(v);
  });
  it("keeps the query short and under the server's 2,000 character limit for realistic input", () => {
    expect(serializeView(view({ q: "x".repeat(200), tag: "t".repeat(32) })).length).toBeLessThan(2000);
  });
  it("parses hostile or stale text into safe values", () => {
    const v = parseView("status=bogus&offer=free_money&minScore=999&maxRating=abc&minReviews=-5&hideSkipped=maybe&tag=" + "z".repeat(99));
    expect(v.status).toBe("");
    expect(v.table.f).toMatchObject({ offer: "any", minScore: 100, maxRating: null, minReviews: 0, hideSkipped: true });
    expect(v.tag).toHaveLength(32);
  });
  it("lowercases and trims the tag when saving", () => {
    expect(new URLSearchParams(serializeView(view({ tag: "  Hot " }))).get("tag")).toBe("hot");
  });
});

describe("normalizeTag", () => {
  it("matches the server's rules, so what the bar shows is what is stored", () => {
    for (const raw of ["  Hot   LEAD!", "Follow-up_1", "a\n\tb", "<b>x</b>", "   ", "!!!", "x".repeat(32), "x".repeat(33), "Ünï cödé"]) {
      expect(normalizeTag(raw)).toBe(serverNormalizeTag(raw));
    }
    expect(normalizeTag("  Hot   LEAD!")).toBe("hot lead");
  });
});
