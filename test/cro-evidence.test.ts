import { describe, it, expect } from "vitest";
import { buildEvidence, cityOf } from "../src/worker/cro/evidence";
import type { CapturedPage } from "../src/worker/cro/types";
import type { Business } from "../src/worker/types";
import { snapshot, box } from "./fixtures/cro";

const business = { id: "b1", name: "Ace Plumbing", category: "Plumber", address: "12 Main St, Boise, ID 83702", phone: "(208) 555-1234",
  website_url: "https://ace.com" } as Business;
const page = (o: Partial<CapturedPage> = {}): CapturedPage => ({
  index: 0, url: "https://ace.com/", kind: "home", ok: true, key: "k", desktop: snapshot(), mobile: snapshot({ viewport: { w: 390, h: 844 } }),
  axe: null, consoleErrors: [], failedRequests: [], requestHosts: [], flow: null, ...o,
});
const facts = (pages: CapturedPage[]) => buildEvidence(pages, business).map((e) => e.fact);
const cta = (text: string, o = {}) => ({ text, href: "/x", box: box(10, 10, 120, 48), aboveFold: true, inHeader: false, contrast: 7, fontPx: 16, ...o });

describe("buildEvidence", () => {
  it("assigns sequential ids and records page and kind", () => {
    const ev = buildEvidence([page()], business);
    expect(ev[0].id).toBe("E1");
    expect(ev.map((e) => e.id)).toEqual(ev.map((_, i) => `E${i + 1}`));
    expect(ev.every((e) => e.page === "https://ace.com/" && e.pageKind === "home")).toBe(true);
  });

  it("CTA: nothing above the fold on mobile, competing buttons, low contrast, small tap targets, header button", () => {
    const f = facts([page({
      desktop: snapshot({ ctas: [cta("Learn More"), cta("Our Services"), cta("Contact", { contrast: 2.1 })] }),
      mobile: snapshot({ viewport: { w: 390, h: 844 }, ctas: [cta("Call", { aboveFold: false, box: box(0, 900, 80, 30) })] }),
    })]);
    expect(f).toContain("On a phone, no action button is visible before scrolling");
    expect(f).toContain(`On desktop, 3 competing buttons show before scrolling: "Learn More", "Our Services", "Contact"`);
    expect(f).toContain(`Button "Contact" has low text contrast (2.1:1; 4.5:1 is the readable minimum)`);
    expect(f.some((x) => x.startsWith("1 button on mobile is smaller than a thumb-sized 44px"))).toBe(true);
    expect(f).toContain("No action button in the desktop header (only text links)");
  });

  it("nav: counts top-level items and flags buried high-intent pages", () => {
    const nav = ["Home", "Services", "Gallery", "Blog", "Team", "Careers", "FAQ", "Contact"].map((t) => ({ text: t, href: "/", children: [] as any[] }));
    nav.push({ text: "About", href: "/about", children: [{ text: "Financing", href: "/financing", children: [] }] });
    const f = facts([page({ desktop: snapshot({ nav }) })]);
    expect(f.some((x) => x.startsWith("Main menu has 9 top-level items: Home, Services"))).toBe(true);
    expect(f).toContain(`"Financing" is nested under "About" in the menu`);
  });

  it("contact: plain-text header phone vs tap-to-call", () => {
    expect(facts([page({ mobile: snapshot({ headerPhoneText: "(208) 555-1234" }) })]))
      .toContain(`Phone number in the mobile header is plain text, not tappable: "(208) 555-1234"`);
    expect(facts([page({ mobile: snapshot({ telLinks: [{ text: "(208) 555-1234", href: "tel:2085551234", inHeader: true, box: box() }] }) })]))
      .toContain(`Phone number is a tap-to-call link in the mobile header: "(208) 555-1234"`);
  });

  it("forms: field count with labels, captcha, privacy and generic submit", () => {
    const fields = ["Name", "Email", "Phone", "Address", "City", "Budget", "How did you hear about us?", "Message"].map((l) => ({ label: l, name: l, type: "text", required: l !== "City" }));
    const f = facts([page({ kind: "contact", url: "https://ace.com/contact", desktop: snapshot({ forms: [{ fields, hasCaptcha: true, privacyNote: false, submitText: "Submit", box: box() }] }) })]);
    expect(f).toContain(`Form has 8 fields (7 required): Name, Email, Phone, Address, City, Budget, How did you hear about us?, Message; it also has a CAPTCHA; no privacy reassurance near the button; the button just says "Submit"`);
  });

  it("flow: off-site booking vendor", () => {
    const f = facts([page({ flow: { ctaText: "Book Now", href: "https://www.vagaro.com/ace", finalUrl: "https://www.vagaro.com/ace", offDomain: true, vendor: "Vagaro", formFields: 0, opensModal: false } })]);
    expect(f).toContain(`Main button "Book Now" sends visitors to Vagaro (www.vagaro.com), off this website`);
  });

  it("trust: no review widget, unattributed testimonials, no guarantee", () => {
    const f = facts([page({ desktop: snapshot({ trust: { reviewWidget: null, testimonialCount: 4, attributedTestimonials: 0, badgeCount: 0, guaranteeText: null, yearsText: "since 1998" } }) })]);
    expect(f).toEqual(expect.arrayContaining([
      "No live review widget (Google, Trustpilot or Yelp) on this page", "4 testimonials, 0 with a name attached",
      "No badges or credentials shown", "No guarantee or warranty wording found", `Mentions experience: "since 1998"`,
    ]));
  });

  it("copy: H1 quote, generic phrases, we-vs-you, missing city", () => {
    const text = "We are proud. Our team. We work hard. Our values. We care. Quality service and competitive prices. You win.";
    const f = facts([page({ desktop: snapshot({ text }) })]);
    expect(f).toContain(`H1 headline: "Welcome to Our Website"`);
    expect(f.some((x) => x.startsWith(`Generic phrases used: "quality service", "competitive prices"`))).toBe(true);
    expect(f.some((x) => x.startsWith(`Copy talks about the business more than the customer ("we/our" 5`))).toBe(true);
    expect(f).toContain(`"Boise" is not in the headline or page title`);
  });

  it("site-wide: martech found across pages, with data for the tracking check", () => {
    const ev = buildEvidence([page({ requestHosts: ["www.googletagmanager.com"] }), page({ index: 1, url: "https://ace.com/contact", kind: "contact" })], business);
    const m = ev.filter((e) => e.family === "martech");
    expect(m).toHaveLength(1);
    expect(m[0].data).toEqual({ analytics: true, callTracking: false, tools: ["Google Tag Manager"] });
    expect(m[0].fact).toContain("No call tracking detected");
    const none = buildEvidence([page()], business).find((e) => e.family === "martech")!;
    expect(none.fact).toBe("No analytics, conversion or call tracking detected");
  });

  it("listing: phone mismatch and missing street address", () => {
    const site = { text: "Call (208) 555-9999 today", telLinks: [{ text: "Call", href: "tel:2085559999", inHeader: true, box: box() }] };
    const f = facts([page({ desktop: snapshot(site), mobile: snapshot(site) })]);
    expect(f).toContain("Phone on the website ((208) 555-9999) differs from the Google listing ((208) 555-1234)");
    expect(f).toContain(`Google listing address "12 Main St" is not shown on the site`);
  });

  it("health: accessibility, script errors, sideways scrolling and small text", () => {
    const f = facts([page({ axe: { critical: 1, serious: 2, top: [{ id: "color-contrast", help: "Elements must have sufficient color contrast", nodes: 5 }] },
      consoleErrors: ["TypeError: x is undefined"], mobile: snapshot({ overflowX: true, smallTextPct: 0.31 }) })]);
    expect(f).toEqual(expect.arrayContaining([
      "3 serious accessibility problems (e.g. Elements must have sufficient color contrast)",
      `1 script error while loading (e.g. "TypeError: x is undefined")`,
      "Page scrolls sideways on a phone", "31% of text on mobile is smaller than 12px",
    ]));
  });

  it("skips failed pages entirely", () => {
    expect(buildEvidence([page(), page({ index: 1, ok: false, url: "https://ace.com/x", desktop: null, mobile: null })], business)
      .every((e) => e.page === "https://ace.com/")).toBe(true);
  });

  it("cityOf reads the city from a US-style address", () => {
    expect(cityOf("12 Main St, Boise, ID 83702")).toBe("Boise");
    expect(cityOf("Boise")).toBeNull();
    expect(cityOf(null)).toBeNull();
  });
  it("tolerates a missing desktop or mobile snapshot", () => {
    const desktopOnly = buildEvidence([page({ mobile: null })], business);
    expect(desktopOnly.length).toBeGreaterThan(0);
    expect(desktopOnly.every((e) => e.device !== "mobile")).toBe(true);
    const mobileOnly = buildEvidence([page({ desktop: null, requestHosts: ["www.googletagmanager.com"] })], business);
    expect(mobileOnly.length).toBeGreaterThan(0);
    expect(mobileOnly.find((e) => e.family === "martech")).toBeDefined();
    expect(buildEvidence([page({ desktop: null, mobile: null })], business)).toEqual([]);
  });

  it("flow evidence survives an unparseable final url", () => {
    const f = facts([page({ flow: { ctaText: "Go", href: "x", finalUrl: "not a url", offDomain: false, vendor: null, formFields: 0, opensModal: false } })]);
    expect(f).toContain('Main button "Go" leads to not a url with no form');
  });

});
