import { describe, it, expect } from "vitest";
import { KEEP, buildDeck, problemsOf, scorecardOf, type DeckInput, type DeckPackage, type DeckSlide } from "../src/worker/sales/deck";
import type { Deal } from "../src/worker/db/deals";
import type { PackageSnapshot } from "../src/worker/db/packages";
import type { CallRecap } from "../src/worker/queue/callRecap";
import type { LeadType } from "../src/worker/sales/notes";
import type { Option } from "../src/worker/sales/options";

const snap = (key: PackageSnapshot["key"], name: string, kind: PackageSnapshot["kind"], priceCents: number, o: Partial<PackageSnapshot> = {}): PackageSnapshot =>
  ({ key, version: 1, name, kind, priceCents, setupCents: 0, termMonths: null, fromPrice: false, ...o });

const QUICK = snap("quick_fix", "Quick Fix", "one_time", 79700);
const CARE = snap("care", "Care", "monthly", 12900);
const SEO = snap("local_seo", "Local SEO", "monthly", 79700, { setupCents: 75000, termMonths: 6 });
const STARTER = snap("starter_site", "Starter Site", "one_time", 399700, { fromPrice: true });
const SUB = snap("website_subscription", "Website Subscription", "subscription", 29700, { setupCents: 49700, termMonths: 24 });
const SNAPSHOT = [QUICK, CARE, SEO];

const opt = (id: "a" | "b" | "c", label: string, keys: Option["items"][number]["key"][], recommended = false): Option =>
  ({ id, label, tagline: `${label} tagline`, items: keys.map((key) => ({ key })), recommended });
const OPTIONS = [opt("a", "Fix it", ["quick_fix"]), opt("b", "Fix it and keep it running", ["quick_fix", "care"], true), opt("c", "Fix it, keep it running, get found", ["quick_fix", "care", "local_seo"])];

const deal = (o: Partial<Deal> = {}): Deal => ({
  id: "d1", businessId: "b1", stage: "recommendation_booked", source: "manual", skipCall: true, options: OPTIONS, recommendedOptionId: "b", priceSnapshot: SNAPSHOT, valueCents: null,
  notes: null, callPrep: null, recap: null, deckFrozenAt: null, lostReason: null, createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z", closedAt: null, ...o,
});
const recap = (leadType: LeadType): CallRecap => ({
  playback: "You get most of your work by word of mouth and you want more water heater jobs.", recommendation: "Fix what is broken first, then keep the site looked after every month.",
  leadType, goals: ["More calls for water heater jobs", "Stop looking closed on Google"], currentState: ["Old site, no phone number up top"], generatedAt: "2026-11-18T00:00:00.000Z",
});
const CATALOG: DeckPackage[] = [
  { ...QUICK, includes: ["Fixed scope: the top 3 to 5 audit problems fixed"] }, { ...CARE, includes: ["Weekly updates", "Backups"] }, { ...SEO, includes: ["Citations"] },
  { ...STARTER, includes: ["Up to 5 pages"] }, { ...SUB, includes: ["The site", "Hosting"] },
];
const NOTES = { answers: [], goals: [], currentState: [], avgJobValueCents: 40000, missedJobsPerMonth: 5, platform: "wordpress" as const, decisionMakers: "", callHeldAt: null };

function input(leadType: LeadType, o: Partial<DeckInput> = {}): DeckInput {
  return {
    deal: deal(), business: { name: "Ace Plumbing", ownerName: "Pat Jones" }, notes: NOTES, recap: recap(leadType),
    problems: [
      { title: "The phone number doesn't tap on a phone", consequence: "c1", imageDataUri: null },
      { title: "Footer says 2020", consequence: "c2", imageDataUri: null },
      { title: "Google sees the page title as just Home", consequence: "c3", imageDataUri: null },
    ],
    scorecard: [{ label: "Phone test", result: "flag" }, { label: "Mobile speed", result: "62" }],
    samples: [{ name: "Birch Bakery", blurb: "New site", imageDataUri: null }, { name: "Cedar Dental", blurb: "Faster pages", imageDataUri: null }],
    settings: { your_name: "Logan Irish", bio: "I build and look after small business websites.", contact_email: "logan@example.test", role_title: "Web developer" },
    catalog: CATALOG, now: new Date("2026-11-18T20:00:00Z"), ...o,
  };
}
const keys = (slides: DeckSlide[]) => slides.map((s) => s.key);
const slide = (slides: DeckSlide[], key: string) => slides.find((s) => s.key === key)!;
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

describe("buildDeck: which slides", () => {
  it("wp_few_broken keeps slides 1–5, 7–9, 12, 14–18", () => {
    expect(keys(buildDeck(input("wp_few_broken")))).toEqual(
      ["title", "agenda", "recap", "found", "scorecard", "recommendation", "quick_fix", "care", "options", "about", "work", "timeline", "next", "thanks"]);
    expect(keys(buildDeck(input("wp_behind")))).toEqual(keys(buildDeck(input("wp_few_broken"))));
    expect(KEEP.other_platform).toEqual(["title", "agenda", "recap", "found", "scorecard", "recommendation", "quick_fix", "local_seo", "options", "about", "work", "timeline", "next", "thanks"]);
    expect(KEEP.more_calls).toEqual(["title", "agenda", "recap", "found", "numbers", "recommendation", "care", "local_seo", "options", "about", "work", "timeline", "next", "thanks"]);
  });

  it("other_platform has no care slide", () => {
    const d = deal({ options: [opt("a", "Fix it", ["quick_fix"]), opt("b", "Fix it, get found", ["quick_fix", "local_seo"], true), opt("c", "More", ["quick_fix", "local_seo"])] });
    const k = keys(buildDeck(input("other_platform", { deal: d })));
    expect(k).not.toContain("care");
    expect(k).toContain("quick_fix");
    expect(k).toContain("local_seo");
  });

  it("new_site uses the process and two-ways-to-pay slides", () => {
    const d = deal({ options: [opt("a", "Starter", ["starter_site"]), opt("b", "Subscription", ["website_subscription"], true), opt("c", "Starter and Care", ["starter_site", "care"])], priceSnapshot: [STARTER, SUB, CARE] });
    const slides = buildDeck(input("new_site", { deal: d }));
    expect(keys(slides)).toEqual(["title", "agenda", "recap", "found", "recommendation", "new_site", "pay_new_site", "about", "work", "timeline", "next", "thanks"]);
    expect(slide(slides, "pay_new_site").title).toBe("Two ways to pay for a new website.");
    expect(strings(slide(slides, "pay_new_site")).join("|")).toContain("$297/mo for 24 months + $497 setup");
    expect(strings(slide(slides, "pay_new_site")).join("|")).toContain("from $3,997");
  });

  it("a package slide is left out when no option holds the package", () => {
    const d = deal({ options: [opt("a", "Fix it", ["quick_fix"]), opt("b", "Fix it again", ["quick_fix"], true), opt("c", "Fix it more", ["quick_fix"])] });
    const k = keys(buildDeck(input("wp_few_broken", { deal: d })));
    expect(k).toContain("quick_fix");
    expect(k).not.toContain("care");
  });

  it("numbers slide is absent without both owner numbers, and the agenda then omits what it costs", () => {
    const withNumbers = buildDeck(input("more_calls"));
    expect(keys(withNumbers)).toContain("numbers");
    expect(strings(slide(withNumbers, "agenda").blocks).join("|")).toContain("What it costs");
    for (const notes of [{ ...NOTES, missedJobsPerMonth: null }, { ...NOTES, avgJobValueCents: null }, { ...NOTES, avgJobValueCents: 0 }, { ...NOTES, missedJobsPerMonth: 0 }]) {
      const slides = buildDeck(input("more_calls", { notes }));
      expect(keys(slides)).not.toContain("numbers");
      expect(strings(slide(slides, "agenda").blocks).join("|")).not.toContain("What it costs");
    }
    // A kind of lead the guide gives no numbers slide never shows one, even with both numbers.
    expect(keys(buildDeck(input("wp_few_broken")))).not.toContain("numbers");
    expect(strings(slide(buildDeck(input("wp_few_broken")), "agenda").blocks).join("|")).not.toContain("What it costs");
  });

  it("numbers slide math is jobs × value and matches the owner's numbers", () => {
    const s = slide(buildDeck(input("more_calls", { notes: { ...NOTES, avgJobValueCents: 45050, missedJobsPerMonth: 3 } })), "numbers");
    const stats = s.blocks.filter((b) => b.type === "stat");
    expect(stats.map((b) => (b as { value: string }).value)).toEqual(["3", "$450.50", "$1,351.50"]);
    expect(stats.map((b) => (b as { op?: string }).op)).toEqual([undefined, "times", "equals"]);
  });

  it("work slide needs two samples", () => {
    const one = buildDeck(input("wp_few_broken", { samples: [{ name: "Birch Bakery", blurb: "x", imageDataUri: null }] }));
    expect(keys(one)).not.toContain("work");
    expect(keys(buildDeck(input("wp_few_broken", { samples: [] })))).not.toContain("work");
    const four = buildDeck(input("wp_few_broken", { samples: Array.from({ length: 4 }, (_, i) => ({ name: `S${i}`, blurb: "x", imageDataUri: null })) }));
    expect(slide(four, "work").blocks.filter((b) => b.type === "image")).toHaveLength(3);
  });

  it("found and scorecard are left out when there is nothing to show", () => {
    const k = keys(buildDeck(input("wp_few_broken", { problems: [], scorecard: [] })));
    expect(k).not.toContain("found");
    expect(k).not.toContain("scorecard");
  });
});

describe("buildDeck: the options and the prices", () => {
  it("options slide has three options with the middle recommended and totals from the catalog", () => {
    const o = buildDeck(input("wp_few_broken")).find((s) => s.key === "options")!.blocks.filter((b) => b.type === "option") as Extract<DeckSlide["blocks"][number], { type: "option" }>[];
    expect(o.map((x) => x.label)).toEqual(OPTIONS.map((x) => x.label));
    expect(o.map((x) => x.recommended)).toEqual([false, true, false]);
    expect(o.map((x) => [x.upfront, x.monthly])).toEqual([["$797", null], ["$797", "$129/mo"], ["$1,547", "$926/mo"]]);
    expect(o[1].items.map((i) => [i.name, i.price])).toEqual([["Quick Fix", "$797"], ["Care", "$129/mo"]]);
  });

  it("an option holding a from-priced package says so in its up-front total, as the line item does", () => {
    const d = deal({ priceSnapshot: [QUICK, CARE, STARTER], options: [OPTIONS[0], opt("b", "New site and care", ["starter_site", "care"], true), opt("c", "Everything", ["starter_site", "quick_fix", "care"])] });
    const blocks = buildDeck(input("wp_few_broken", { deal: d })).find((x) => x.key === "options")!.blocks.filter((x) => x.type === "option") as Extract<DeckSlide["blocks"][number], { type: "option" }>[];
    expect(blocks[1].items.map((i) => i.price)).toEqual(["from $3,997", "$129/mo"]);
    expect(blocks.map((x) => [x.upfront, x.monthly])).toEqual([["$797", null], ["from $3,997", "$129/mo"], ["from $4,794", "$129/mo"]]);
  });

  it("a setup discount is shown and comes off the up-front total", () => {
    const d = deal({ options: [OPTIONS[0], { ...OPTIONS[1], items: [{ key: "quick_fix", setupDiscountCents: 10000 }, { key: "care" }] }, OPTIONS[2]] });
    const b = (buildDeck(input("wp_few_broken", { deal: d })).find((s) => s.key === "options")!.blocks.filter((x) => x.type === "option")[1]) as Extract<DeckSlide["blocks"][number], { type: "option" }>;
    expect(b.upfront).toBe("$697");
    expect(b.items[0].price).toBe("$797 (less $100 off setup)");
  });

  it("local seo is its own line and never inside the care price", () => {
    const c = buildDeck(input("wp_few_broken")).find((s) => s.key === "options")!.blocks[3] as Extract<DeckSlide["blocks"][number], { type: "option" }>;
    const care = c.items.find((i) => i.snapshot.key === "care")!, seo = c.items.find((i) => i.snapshot.key === "local_seo")!;
    expect(care.price).toBe("$129/mo");
    expect(seo.price).toBe("$797/mo + $750 setup, 6-month first term");
    expect(care.price).not.toContain("797");
    expect(c.items.map((i) => i.name)).toEqual(["Quick Fix", "Care", "Local SEO"]);
  });

  it("a catalog price change after freezing does not change the deck", () => {
    const later = CATALOG.map((p) => (p.key === "quick_fix" ? { ...p, priceCents: 89700, version: 2 } : p.key === "care" ? { ...p, priceCents: 14900, version: 2 } : p));
    const text = strings(buildDeck(input("wp_few_broken", { catalog: later, deal: deal({ deckFrozenAt: "2026-11-18T00:00:00.000Z" }) }))).join("|");
    expect(text).toContain("$797");
    expect(text).toContain("$129/mo");
    expect(text).not.toContain("$897");
    expect(text).not.toContain("$149");
  });

  it("a deal with no snapshot uses the current catalog", () => {
    const text = strings(buildDeck(input("wp_few_broken", { deal: deal({ priceSnapshot: [] }) }))).join("|");
    expect(text).toContain("$797");
    expect(text).toContain("$129/mo");
    const later = CATALOG.map((p) => (p.key === "quick_fix" ? { ...p, priceCents: 89700 } : p));
    expect(strings(buildDeck(input("wp_few_broken", { deal: deal({ priceSnapshot: [] }), catalog: later }))).join("|")).toContain("$897");
  });

  it("no slide contains a price not in the snapshot", () => {
    // The packages, their setup fees, the option totals, and (more_calls) the owner's two numbers and their product.
    const allowed = new Set(["$797", "$129", "$750", "$1,547", "$926", "$400", "$2,000", "$3,997", "$297", "$497"]);
    const siteDeal = deal({ options: [opt("a", "Starter", ["starter_site"]), opt("b", "Subscription", ["website_subscription"], true), opt("c", "Starter and Care", ["starter_site", "care"])], priceSnapshot: [STARTER, SUB, CARE] });
    for (const lead of ["wp_few_broken", "other_platform", "more_calls", "new_site"] as const) {
      const text = strings(buildDeck(input(lead, lead === "new_site" ? { deal: siteDeal } : {}))).join("|");
      const found = text.match(/\$\d[\d,]*(\.\d+)?/g) ?? [];
      expect(found.length, lead).toBeGreaterThan(0);
      for (const f of found) expect(allowed.has(f), `${lead}: ${f}`).toBe(true);
    }
  });

  it("the old template prices are nowhere in the deck", () => {
    const all = (["wp_few_broken", "other_platform", "more_calls", "new_site"] as const).map((l) => strings(buildDeck(input(l))).join("|")).join("|");
    for (const p of ["$125", "$700", "$3,500", "$250/mo", "$6,000"]) expect(all).not.toContain(p);
  });

  it("the recommendation slide says the sentence with no price", () => {
    const s = slide(buildDeck(input("wp_few_broken")), "recommendation");
    expect(strings(s.blocks).join("|")).toContain(recap("wp_few_broken").recommendation);
    expect(strings(s.blocks).join("|")).not.toContain("$");
    expect(s.speakerNote).toMatch(/one sentence before showing any prices/);
  });

  it("speaker notes carry the pre-close question and the ask", () => {
    const slides = buildDeck(input("wp_few_broken"));
    expect(slide(slides, "options").speakerNote).toContain("is there anything other than the price that would stop us from starting?");
    expect(slide(slides, "next").speakerNote).toContain("Would you like me to start on this?");
  });

  it("the about slide uses the bio from settings and the thanks slide the contact from settings", () => {
    const slides = buildDeck(input("wp_few_broken", { settings: { your_name: "Pat Q", bio: "A bio written in settings.", contact_email: "pat@example.test", role_title: "Designer" } }));
    expect(strings(slide(slides, "about")).join("|")).toContain("A bio written in settings.");
    expect(strings(slide(slides, "thanks")).join("|")).toContain("pat@example.test");
    expect(strings(slide(slides, "about")).join("|")).not.toContain("Sherwood");
  });

  it("the title slide names the business and the owner and the month", () => {
    const t = buildDeck(input("wp_few_broken"))[0];
    expect(t.title).toBe("Ace Plumbing");
    expect(strings(t.blocks).join("|")).toContain("Prepared for Pat Jones");
    expect(strings(t.blocks).join("|")).toContain("November 2026");
    expect(strings(buildDeck(input("wp_few_broken", { business: { name: "Ace Plumbing", ownerName: null } }))[0].blocks).join("|")).not.toContain("Prepared for");
  });
});

describe("problemsOf and scorecardOf", () => {
  const findings = [
    { code: "no_title_or_meta", evidence: "the page title is just Home" }, { code: "old_copyright", evidence: "footer says 2020. Coupon ended Oct 31." },
    { code: "no_click_to_call", evidence: "the phone number does not tap" }, { code: "no_sitemap", evidence: "x" },
  ] as const;
  const plan = {
    shots: [{ id: "s1", previewKey: "k/1.jpg" }, { id: "s2", previewKey: "k/2.jpg" }, { id: "s3", previewKey: "k/3.jpg" }],
    segments: [
      { role: "hook", text: "Hello there Pat", shotId: "s1" },
      { role: "problem", text: "The page title is just Home.", shotId: "s1", findingCode: "no_title_or_meta" },
      { role: "problem", text: "The footer is old.", shotId: "s2", findingCode: "old_copyright" },
      { role: "problem", text: "The phone does not tap.", shotId: "s3", findingCode: "no_click_to_call" },
      { role: "cta", text: "Book a call", shotId: "s1" },
    ],
  };

  it("shows the three video problems in the template's order: costs calls, looks out of date, harder to find", () => {
    const p = problemsOf(plan, [...findings], { s1: "data:image/jpeg;base64,AAAA", s2: null, s3: "data:image/jpeg;base64,BBBB" });
    expect(p.map((x) => x.label)).toEqual(["Costs calls", "Looks out of date", "Harder to find"]);
    expect(p.map((x) => x.title)).toEqual(["The phone number does not tap", "Footer says 2020.", "The page title is just Home"]);
    expect(p.map((x) => x.imageDataUri)).toEqual(["data:image/jpeg;base64,BBBB", null, "data:image/jpeg;base64,AAAA"]);
    expect(p[0].consequence).toBe("Someone who needs help right now moves on to the next result.");
  });

  it("with no video plan it is the first three audit flags, without pictures", () => {
    const p = problemsOf(null, [...findings]);
    expect(p).toHaveLength(3);
    expect(p.every((x) => x.imageDataUri === null)).toBe(true);
    expect(p.map((x) => x.title)).toEqual(["The page title is just Home", "Footer says 2020.", "The phone number does not tap"]);
  });

  it("the scorecard has only what the audit measured", () => {
    const rows = scorecardOf({ findings: [{ code: "no_click_to_call" } as any], pagespeed_mobile: 61.6, https: true, broken_link_count: 0, platform: null, partial: false, site_status: "ok" });
    expect(rows).toEqual([
      { label: "Phone test", result: "flag" }, { label: "Mobile speed", result: "62" }, { label: "Security (https)", result: "pass" },
      { label: "Freshness", result: "pass" }, { label: "Search basics", result: "pass" }, { label: "Broken links", result: "pass" },
    ]);
    expect(scorecardOf({ findings: [], pagespeed_mobile: null, https: null, broken_link_count: null, platform: "wix", partial: false, site_status: "ok" }).map((r) => r.label)).toEqual(["Phone test", "Freshness", "Platform + updates", "Search basics"]);
  });

  it("a partial audit, or a site that could not be read, gives no scorecard: an unmeasured check is never a pass", () => {
    const base = { findings: [] as any[], pagespeed_mobile: 61, https: true, broken_link_count: 0, platform: null };
    expect(scorecardOf({ ...base, partial: true, site_status: "ok" })).toEqual([]);
    for (const site_status of ["unreachable", "no_website", "parked", "blocked"] as const) expect(scorecardOf({ ...base, partial: false, site_status }), site_status).toEqual([]);
    expect(scorecardOf({ ...base, partial: false, site_status: "ok" }).length).toBeGreaterThan(0);
  });
});
