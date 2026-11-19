import { describe, expect, it } from "vitest";
import { CLAUSE_LIBRARY_VERSION, TERMS, clausesFor, type ClauseCtx, type ClauseId } from "../src/worker/documents/clauses";
import { DEFAULT_DOCUMENTS_CONFIG } from "../src/worker/documents/config";

const ctx = (o: Partial<ClauseCtx> = {}): ClauseCtx => ({
  providerName: "Irish Web", clientName: "Ace Plumbing", keys: ["starter_site", "care"], careDeclined: false,
  hourlyCents: 12500, hourlyCareCents: 9500, config: DEFAULT_DOCUMENTS_CONFIG, ...o,
});
const ids = (c: ClauseCtx) => clausesFor(c).map((x) => x.id);
const text = (c: ClauseCtx, id: ClauseId) => clausesFor(c).find((x) => x.id === id)!.text;

describe("clause library", () => {
  it("every clause named in spec 11 is present for a build option", () => {
    expect(CLAUSE_LIBRARY_VERSION).toBe(1);
    expect(ids(ctx({ keys: ["starter_site"] }))).toEqual([
      "scope_exclusions", "change_orders", "revisions", "content_delays", "payment_terms", "late_fee", "work_pause", "kill_fee",
      "ownership", "warranty", "termination", "client_content", "ai_content", "accessibility", "site_credit", "no_ranking",
    ]);
    for (const c of clausesFor(ctx())) { expect(c.title.length).toBeGreaterThan(0); expect(c.text.length).toBeGreaterThan(40); }
  });

  it("care_opt_out appears only when careDeclined", () => {
    expect(ids(ctx())).not.toContain("care_opt_out");
    const declined = ids(ctx({ keys: ["starter_site"], careDeclined: true }));
    expect(declined).toContain("care_opt_out");
    expect(declined).not.toContain("care_terms");
    expect(text(ctx({ careDeclined: true }), "care_opt_out")).toMatch(/hosting/i);
    expect(text(ctx({ careDeclined: true }), "care_opt_out")).toMatch(/security/i);
  });

  it("care_terms absent when no care key", () => {
    expect(ids(ctx({ keys: ["starter_site"] }))).not.toContain("care_terms");
    expect(ids(ctx({ keys: ["quick_fix"] }))).not.toContain("care_terms");
    for (const k of ["care", "care_plus", "care_fallback"] as const) expect(ids(ctx({ keys: ["starter_site", k] }))).toContain("care_terms");
  });

  it("the conditional clauses follow their package keys, in a fixed order", () => {
    expect(ids(ctx({ keys: ["website_subscription"] }))).toContain("subscription_term");
    expect(ids(ctx({ keys: ["starter_site"] }))).not.toContain("subscription_term");
    for (const k of ["local_seo", "local_seo_growth"] as const) expect(ids(ctx({ keys: [k] }))).toContain("seo_term");
    expect(ids(ctx({ keys: ["care", "client_hosted_surcharge"] }))).toContain("client_hosted");
    expect(ids(ctx({ keys: ["starter_site"] }))).not.toContain("client_hosted");
    const all = ids(ctx({ keys: ["website_subscription", "care", "local_seo", "client_hosted_surcharge"], careDeclined: true }));
    expect(all.slice(-5)).toEqual(["care_terms", "care_opt_out", "subscription_term", "seo_term", "client_hosted"]);
  });

  it("subscription_term states 24 months and conversion to Care in month 25", () => {
    const t = text(ctx({ keys: ["website_subscription"] }), "subscription_term");
    expect(t).toContain("24 months");
    expect(t).toMatch(/remaining/i);
    expect(t).toMatch(/month 25/i);
    expect(t).toContain("Care");
  });

  it("seo_term states 6 months", () => {
    expect(text(ctx({ keys: ["local_seo"] }), "seo_term")).toContain("6 months");
  });

  it("numbers come from TERMS", () => {
    expect(TERMS).toEqual({ revisionRounds: 2, silenceDays: 14, requoteMonths: 6, pauseDays: 14, killFeePercent: 25, warrantyDays: 30, terminationDays: 30, subscriptionMonths: 24, seoFirstTermMonths: 6 });
    const c = ctx();
    expect(text(c, "revisions")).toContain("2 revision rounds");
    expect(text(c, "content_delays")).toContain("14 days");
    expect(text(c, "content_delays")).toContain("6 months");
    expect(text(c, "work_pause")).toContain("14 days");
    expect(text(c, "kill_fee")).toContain("25%");
    expect(text(c, "warranty")).toContain("30 days");
    expect(text(c, "termination")).toContain("30 days");
  });

  it("the hourly rate in change_orders is the one in the context", () => {
    expect(text(ctx({ hourlyCents: 13000, hourlyCareCents: null }), "change_orders")).toContain("$130");
    const t = text(ctx({ hourlyCents: 12500, hourlyCareCents: 9500 }), "change_orders");
    expect(t).toContain("$125"); expect(t).toContain("$95");
    expect(text(ctx({ hourlyCents: 13000, hourlyCareCents: null }), "change_orders")).not.toContain("$125");
  });

  it("no other dollar figure appears in any clause text", () => {
    const c = ctx({ keys: ["website_subscription", "care", "local_seo", "client_hosted_surcharge"], careDeclined: true, hourlyCents: 13000, hourlyCareCents: 9900 });
    for (const clause of clausesFor(c)) {
      const found = clause.text.match(/\$[\d,.]+/g) ?? [];
      const allowed = clause.id === "change_orders" ? ["$130", "$99"] : [];
      expect(found, clause.id).toEqual(allowed);
    }
  });

  it("late_fee states the monthly percent from the config", () => {
    expect(text(ctx(), "late_fee")).toContain("1.5%");
    expect(text(ctx({ config: { ...DEFAULT_DOCUMENTS_CONFIG, lateFeePercentMonthly: 2 } }), "late_fee")).toContain("2%");
  });

  it("payment_terms: deposit before work, final payment when the site is finished, not at launch", () => {
    const t = text(ctx(), "payment_terms");
    expect(t).toMatch(/deposit/i); expect(t).toMatch(/before (any )?work (starts|begins)/i);
    expect(t).toMatch(/finished/i); expect(t).toMatch(/not (at|on) launch/i);
    expect(t).toMatch(/schedule/i);
  });

  it("names the parties, and ownership transfers on full payment", () => {
    const t = text(ctx(), "ownership");
    expect(t).toContain("Irish Web"); expect(t).toContain("Ace Plumbing"); expect(t).toMatch(/full payment/i);
  });

  it("client name with markup stays plain text in the clause", () => {
    const name = `Ace <b>"Plumbing"</b> & Sons`;
    const t = text(ctx({ clientName: name }), "ownership");
    expect(t).toContain(name);
    expect(t).not.toContain("&lt;");
  });

  it("carries no Webfor wording", () => {
    for (const c of clausesFor(ctx({ keys: ["website_subscription", "care", "local_seo", "client_hosted_surcharge"], careDeclined: true }))) expect(c.text + c.title).not.toMatch(/webfor/i);
  });
});
