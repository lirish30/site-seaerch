import { describe, expect, it } from "vitest";
import type { Deal } from "../src/worker/db/deals";
import type { Package, PackageKey } from "../src/worker/db/packages";
import { snapshotOf } from "../src/worker/db/packages";
import type { Option } from "../src/worker/sales/options";
import { CLAUSE_LIBRARY_VERSION } from "../src/worker/documents/clauses";
import { DEFAULT_DOCUMENTS_CONFIG } from "../src/worker/documents/config";
import { ProposalContentSchema, ProposalError, buildProposal, freezeProposal } from "../src/worker/documents/proposal";

const P = (key: PackageKey, name: string, kind: Package["kind"], priceCents: number, o: Partial<Package> = {}): Package => ({
  id: `pkg_${key}_1`, key, version: 1, name, kind, priceCents, setupCents: 0, termMonths: null, altPriceCents: null, fromPrice: false, summary: "",
  includes: [`${name} item one`, `${name} item two`], wordpressOnly: false, publicOffer: true, active: true, createdAt: "2026-11-18T00:00:00.000Z", ...o,
});
const CATALOG: Package[] = [
  P("quick_fix", "Quick Fix", "one_time", 79700),
  P("starter_site", "Starter Site", "one_time", 399700, { fromPrice: true }),
  P("growth_site", "Growth Site", "one_time", 699700, { fromPrice: true }),
  P("website_subscription", "Website Subscription", "subscription", 29700, { setupCents: 49700, termMonths: 24, wordpressOnly: true }),
  P("care", "Care", "monthly", 12900, { wordpressOnly: true }),
  P("local_seo", "Local SEO", "monthly", 79700, { setupCents: 75000, termMonths: 6 }),
  P("hourly", "Hourly", "hourly", 12500, { altPriceCents: 9500 }),
];
const opt = (id: Option["id"], items: Option["items"], recommended = id === "b"): Option => ({ id, label: `Option ${id}`, tagline: "t", items, recommended });
const OPTIONS: Option[] = [
  opt("a", [{ key: "quick_fix" }]),
  opt("b", [{ key: "starter_site" }, { key: "care" }]),
  opt("c", [{ key: "growth_site" }, { key: "care" }]),
];
const mkDeal = (o: Partial<Deal> = {}, catalog = CATALOG): Deal => ({
  id: "abcdef12-0000-4000-8000-000000000000", businessId: "biz1", stage: "recommended", source: "manual", skipCall: false, options: OPTIONS, recommendedOptionId: "b",
  priceSnapshot: catalog.map(snapshotOf), valueCents: null, notes: null, callPrep: null, recap: null, deckFrozenAt: null, lostReason: null,
  createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z", closedAt: null, ...o,
});
const NOW = new Date("2026-12-01T17:00:00.000Z");
const input = (o: Partial<Parameters<typeof buildProposal>[0]> = {}): Parameters<typeof buildProposal>[0] => ({
  deal: mkDeal(), optionId: "b", client: { name: "Ace Plumbing", contactName: "Pat Jones", contactEmail: "pat@ace.test" },
  settings: { your_name: "Pat Provider", business_name: "Siteline", contact_email: "hello@siteline.test" },
  packages: CATALOG, catalogHourly: { hourlyCents: 12500, hourlyCareCents: 9500 }, edits: {}, config: DEFAULT_DOCUMENTS_CONFIG,
  platform: "wordpress", now: NOW, version: 1, ...o,
});
const refused = (o: Partial<Parameters<typeof buildProposal>[0]>, re: RegExp) => {
  expect(() => buildProposal(input(o))).toThrow(ProposalError);
  expect(() => buildProposal(input(o))).toThrow(re);
};

describe("buildProposal", () => {
  it("builds the recommended option from the deal's own snapshot", () => {
    const c = buildProposal(input());
    expect(ProposalContentSchema.safeParse(c).success).toBe(true);
    expect(c.header).toEqual({
      reference: "SL-ABCDEF", version: 1, preparedOn: "2026-12-01T17:00:00.000Z", sentOn: null, expiresOn: null, clientName: "Ace Plumbing", contactName: "Pat Jones",
      contactEmail: "pat@ace.test", providerName: "Pat Provider", providerBusiness: "Siteline", providerEmail: "hello@siteline.test",
    });
    expect(c.optionId).toBe("b");
    expect(c.packages.map((p) => [p.key, p.version, p.name, p.priceLine])).toEqual([["starter_site", 1, "Starter Site", "from $3,997"], ["care", 1, "Care", "$129/mo"]]);
    expect(c.packages[0].includes).toEqual(["Starter Site item one", "Starter Site item two"]);
    expect(c.schedule.depositCents).toBe(199850);
    expect(c.careDeclined).toBe(false);
    expect(c.clauseLibraryVersion).toBe(CLAUSE_LIBRARY_VERSION);
    expect(c.clauses.map((x) => x.id)).toContain("care_terms");
    expect(c.assumptions.join(" ")).toMatch(/2 revision rounds/);
    expect(c.outOfScope.join(" ")).toMatch(/third-party/i);
    expect(c.scopeNotes).toBe("");
  });

  it("phases follow the package kinds and link to the milestone due when they end", () => {
    const starter = buildProposal(input());
    expect(starter.phases.map((p) => p.name)).toEqual(["Discovery and sitemap", "Design", "Build", "Review", "Finished"]);
    expect(starter.phases.map((p) => p.milestoneId)).toEqual([null, null, null, null, "site_finished"]);
    const growth = buildProposal(input({ optionId: "c" }));
    expect(growth.phases.map((p) => p.milestoneId)).toEqual([null, "design_approved", null, null, "site_finished"]);
    for (const p of growth.phases) expect(growth.schedule.milestones.map((m) => m.id)).toContain(p.milestoneId ?? "site_finished");
    const quick = buildProposal(input({ optionId: "a" }));
    expect(quick.phases.map((p) => p.name)).toEqual(["The fixes", "Done"]);
    const seo = buildProposal(input({ deal: mkDeal({ options: [opt("a", [{ key: "quick_fix" }]), opt("b", [{ key: "local_seo" }]), opt("c", [{ key: "starter_site" }, { key: "care" }])] }) }));
    expect(seo.phases.map((p) => p.name)).toEqual(["Setup", "Monthly work"]);
  });

  it("a build option without care is refused unless careDeclined", () => {
    const deal = mkDeal({ options: [OPTIONS[0], opt("b", [{ key: "starter_site" }]), OPTIONS[2]] });
    refused({ deal }, /care is on by default/i);
    const sub = mkDeal({ options: [OPTIONS[0], opt("b", [{ key: "website_subscription" }]), OPTIONS[2]] });
    refused({ deal: sub }, /care is on by default/i);
    const ok = buildProposal(input({ deal, edits: { careDeclined: true } }));
    expect(ok.careDeclined).toBe(true);
    // Quick Fix and recurring-only options are not builds.
    expect(() => buildProposal(input({ optionId: "a" }))).not.toThrow();
  });

  it("careDeclined adds the care_opt_out clause", () => {
    const deal = mkDeal({ options: [OPTIONS[0], opt("b", [{ key: "starter_site" }]), OPTIONS[2]] });
    const ids = buildProposal(input({ deal, edits: { careDeclined: true } })).clauses.map((c) => c.id);
    expect(ids).toContain("care_opt_out");
    expect(ids).not.toContain("care_terms");
    expect(buildProposal(input()).clauses.map((c) => c.id)).not.toContain("care_opt_out");
  });

  it("declining care that the option already includes is refused", () => {
    refused({ edits: { careDeclined: true } }, /care is in this option/i);
  });

  it("an unknown option id is refused", () => {
    refused({ optionId: "z" as "a" }, /option/i);
    const two = mkDeal({ options: [OPTIONS[0], OPTIONS[1]] });
    refused({ deal: two, optionId: "c" }, /option c/i);
  });

  it("a deal without options is refused", () => {
    refused({ deal: mkDeal({ options: null }) }, /no options/i);
  });

  it("a deal that is not recommended is refused", () => {
    for (const stage of ["booked", "discovery_done", "recommendation_booked", "won", "lost"] as const) {
      expect(() => buildProposal(input({ deal: mkDeal({ stage }) })), stage).toThrow(ProposalError);
    }
    expect(() => buildProposal(input({ deal: mkDeal({ stage: "proposal_sent" }) }))).not.toThrow();
  });

  it("skipCall deals at discovery_done are allowed", () => {
    expect(() => buildProposal(input({ deal: mkDeal({ stage: "discovery_done", skipCall: true }) }))).not.toThrow();
    expect(() => buildProposal(input({ deal: mkDeal({ stage: "discovery_done", skipCall: false }) }))).toThrow(ProposalError);
  });

  it("prices come from the snapshot, not the catalog", () => {
    const moved = CATALOG.map((p) => (p.key === "starter_site" ? { ...p, priceCents: 499700 } : p));
    const c = buildProposal(input({ packages: moved }));
    expect(c.packages[0].priceLine).toBe("from $3,997");
    expect(c.schedule.milestones.map((m) => m.amountCents)).toEqual([199850, 199850]);
    // The snapshot's name wins over a renamed catalog row too.
    const renamed = CATALOG.map((p) => (p.key === "starter_site" ? { ...p, name: "Renamed" } : p));
    expect(buildProposal(input({ packages: renamed })).packages[0].name).toBe("Starter Site");
  });

  it("a package deactivated after the sale does not block the proposal", () => {
    const off = CATALOG.map((p) => (p.key === "starter_site" ? { ...p, active: false } : p));
    expect(() => buildProposal(input({ packages: off }))).not.toThrow();
  });

  it("a snapshot entry with no catalog row, or an item with no snapshot entry, is refused", () => {
    refused({ packages: CATALOG.filter((p) => p.key !== "care") }, /care/i);
    refused({ packages: CATALOG.map((p) => (p.key === "care" ? { ...p, version: 2 } : p)) }, /care/i);
    refused({ deal: mkDeal({ priceSnapshot: CATALOG.filter((p) => p.key !== "care").map(snapshotOf) }) }, /care/i);
  });

  it("care on an other-platform site is refused", () => {
    refused({ platform: "other" }, /WordPress/i);
  });

  it("an empty contact email is refused", () => {
    refused({ client: { name: "Ace Plumbing", contactName: "Pat", contactEmail: "  " } }, /email/i);
  });

  it("a problem in another option does not block this one", () => {
    const deal = mkDeal({ options: [opt("a", [{ key: "quick_fix" }, { key: "hourly" }, { key: "care" }, { key: "care" }]), OPTIONS[1], OPTIONS[2]] });
    expect(() => buildProposal(input({ deal }))).not.toThrow();
    expect(() => buildProposal(input({ deal, optionId: "a" }))).toThrow(ProposalError);
  });

  it("a discount appears on the price line", () => {
    const deal = mkDeal({ options: [OPTIONS[0], opt("b", [{ key: "website_subscription", setupDiscountCents: 20000 }, { key: "care" }]), OPTIONS[2]] });
    const c = buildProposal(input({ deal }));
    expect(c.packages[0].priceLine).toBe("$297/mo for 24 months + $497 setup (setup discount $200)");
    expect(c.schedule.milestones[0].amountCents).toBe(29700);
  });

  it("freezeProposal sets sentOn and expiresOn 30 days later", () => {
    const c = buildProposal(input());
    const f = freezeProposal(c, new Date("2026-12-02T09:30:00.123Z"), 30);
    expect(f.header.sentOn).toBe("2026-12-02T09:30:00.123Z");
    expect(f.header.expiresOn).toBe("2027-01-01T09:30:00.123Z");
    expect(c.header.sentOn).toBeNull();
    expect({ ...f, header: { ...f.header, sentOn: null, expiresOn: null } }).toEqual(c);
  });

  it("a 5000-character scopeNotes is rejected", () => {
    refused({ edits: { scopeNotes: "x".repeat(5000) } }, /scope/i);
    expect(buildProposal(input({ edits: { scopeNotes: "x".repeat(4000) } })).scopeNotes).toHaveLength(4000);
  });

  it("list items and list lengths are capped", () => {
    refused({ edits: { extraAssumptions: ["y".repeat(301)] } }, /assumptions/i);
    refused({ edits: { extraOutOfScope: Array.from({ length: 20 }, (_, i) => `item ${i}`) } }, /out/i);
    const c = buildProposal(input({ edits: { extraAssumptions: ["Pat will send photos by Friday."], extraOutOfScope: ["Logo design."] } }));
    expect(c.assumptions.at(-1)).toBe("Pat will send photos by Friday.");
    expect(c.outOfScope.at(-1)).toBe("Logo design.");
  });

  it("a prospect's markup passes through as plain text", () => {
    const c = buildProposal(input({ client: { name: "<b>Ace</b> & Sons", contactName: "<i>Pat</i>", contactEmail: "pat@ace.test" } }));
    expect(c.header.clientName).toBe("<b>Ace</b> & Sons");
    expect(c.clauses[0].text).toContain("<b>Ace</b> & Sons");
  });

  it("the reference is stable across versions", () => {
    const v1 = buildProposal(input({ version: 1 }));
    const v2 = buildProposal(input({ version: 2, now: new Date("2026-12-05T00:00:00.000Z") }));
    expect(v1.header.reference).toBe("SL-ABCDEF");
    expect(v2.header.reference).toBe(v1.header.reference);
    expect(v2.header.version).toBe(2);
  });
});
