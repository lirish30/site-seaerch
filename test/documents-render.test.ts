import { describe, expect, it } from "vitest";
import type { SignatureRecord } from "../src/worker/db/documents";
import { CLAUSE_LIBRARY_VERSION } from "../src/worker/documents/clauses";
import { ESIGN_DISCLOSURE, ESIGN_VERSION } from "../src/worker/documents/consent";
import type { ProposalContent } from "../src/worker/documents/proposal";
import { PROPOSAL_CSP, renderProposalHtml } from "../src/worker/documents/render";

const XSS = "<script>alert(1)</script>";
const HASH = "ab".repeat(32);

const content = (o: Partial<ProposalContent> = {}): ProposalContent => ({
  header: {
    reference: "SL-ABCDEF", version: 2, preparedOn: "2026-12-01T17:00:00.000Z", sentOn: "2026-12-02T18:00:00.000Z", expiresOn: "2026-12-16T18:00:00.000Z",
    clientName: "Ace Plumbing", contactName: "Pat Jones", contactEmail: "pat@ace.test", providerName: "Pat Provider", providerBusiness: "Siteline", providerEmail: "hello@siteline.test",
  },
  optionId: "b",
  packages: [
    { key: "starter_site", version: 1, name: "Starter Site", priceLine: "from $3,997", includes: ["Five pages", "Contact form"] },
    { key: "care", version: 1, name: "Care", priceLine: "$129/mo", includes: ["Hosting and backups"] },
  ],
  scopeNotes: "Rebuild the site.\n\nKeep the logo.", assumptions: ["Client supplies photos"], outOfScope: ["Copywriting"],
  phases: [{ name: "Design", summary: "Layouts and approval.", milestoneId: "m2" }, { name: "Build", summary: "Pages and forms.", milestoneId: null }],
  schedule: {
    milestones: [
      { id: "m1", label: "Deposit", dueOn: "signing", amountCents: 199850 },
      { id: "m2", label: "Design approved", dueOn: "design_approved", amountCents: 150000 },
      { id: "m3", label: "Final payment", dueOn: "site_finished", amountCents: 49850 },
    ],
    recurring: [{ key: "care", name: "Care", monthlyCents: 12900, startsOn: "launch", termMonths: null, firstMonthPrepaid: false }],
    depositCents: 199850,
  },
  careDeclined: false,
  clauses: [{ id: "revisions", title: "Revisions", text: "Two rounds are included." }, { id: "warranty", title: "Warranty", text: "Thirty days.\n\nNo more." }],
  clauseLibraryVersion: CLAUSE_LIBRARY_VERSION,
  ...o,
});

const sig = (role: SignatureRecord["role"], o: Partial<SignatureRecord> = {}): SignatureRecord => ({
  id: `s_${role}`, documentId: "d1", role, signerName: role === "client" ? "Pat Jones" : "Pat Provider", signerEmail: role === "client" ? "pat@ace.test" : "hello@siteline.test",
  signedAt: role === "client" ? "2026-12-03T19:30:00.000Z" : "2026-12-03T19:31:00.000Z", ip: "203.0.113.9", userAgent: "Mozilla/5.0 Test", consentText: ESIGN_DISCLOSURE,
  consentVersion: ESIGN_VERSION, contentSha256: HASH, ...o,
});
const opts = (o: Partial<Parameters<typeof renderProposalHtml>[1]> = {}): Parameters<typeof renderProposalHtml>[1] => ({
  mode: "screen", status: "sent", contentSha256: null, signatures: [], auditPage: false, draftBanner: false, ...o,
});
const signed = (o: Partial<Parameters<typeof renderProposalHtml>[1]> = {}) =>
  opts({ status: "signed", contentSha256: HASH, signatures: [sig("client"), sig("provider")], ...o });

describe("renderProposalHtml", () => {
  it("escapes markup in every dynamic field", () => {
    const html = renderProposalHtml(
      content({
        header: { ...content().header, clientName: XSS, contactName: XSS, providerName: XSS, providerBusiness: XSS },
        scopeNotes: XSS, assumptions: [XSS], outOfScope: [XSS],
        packages: [{ key: "care", version: 1, name: XSS, priceLine: XSS, includes: [XSS] }],
        phases: [{ name: XSS, summary: XSS, milestoneId: null }], clauses: [{ id: "revisions", title: XSS, text: XSS }],
      }),
      signed({ auditPage: true, signatures: [sig("client", { signerName: XSS, userAgent: XSS, signerEmail: XSS, consentText: XSS }), sig("provider", { signerName: XSS })] }),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes quotes and ampersands so a name cannot break out of an attribute or entity", () => {
    const html = renderProposalHtml(content({ header: { ...content().header, clientName: `A&B "Co" 'x'` } }), opts());
    expect(html).toContain("A&amp;B &quot;Co&quot; &#39;x&#39;");
  });

  it("shows the reference, version, expiry and every clause title", () => {
    const html = renderProposalHtml(content(), opts());
    expect(html).toContain("SL-ABCDEF");
    expect(html).toMatch(/Version<\/th><td>2</);
    expect(html).toContain("2026-12-16");
    expect(html).toContain("Pat Jones");
    expect(html).toContain("hello@siteline.test");
    expect(html).toContain("1. Revisions");
    expect(html).toContain("2. Warranty");
    expect(html).toContain("Rebuild the site.");
    expect(html).toContain("Client supplies photos");
    expect(html).toContain("Copywriting");
    // Sections come in the brief's order.
    const order = ["Packages and prices", "Scope notes", "Assumptions", "Out of scope", "Phases and payment schedule", "Terms", "Signatures"].map((t) => html.indexOf(`<h2>${t}</h2>`));
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("prices appear exactly as the content's priceLine and schedule amounts", () => {
    const html = renderProposalHtml(content(), opts());
    expect(html).toContain("from $3,997");
    expect(html).toContain("$129/mo");
    expect(html).toContain("$1,998.50");
    expect(html).toContain("$1,500");
    expect(html).toContain("$498.50");
    expect(html).toContain("$129 per month");
    // A price is never worked out by the template: change the content and the page follows.
    const other = renderProposalHtml(content({ packages: [{ key: "care", version: 1, name: "Care", priceLine: "$1/mo", includes: [] }] }), opts());
    expect(other).toContain("$1/mo");
    expect(other).not.toContain("from $3,997");
  });

  it("an unsigned document says awaiting signature", () => {
    const html = renderProposalHtml(content(), opts());
    expect(html.match(/Awaiting signature/g)).toHaveLength(2);
    expect(html).not.toContain("Signed 20");
    expect(html).not.toContain("SHA-256");
  });

  it("a signed document shows both typed names and the hash", () => {
    const html = renderProposalHtml(content(), signed());
    expect(html).not.toContain("Awaiting signature");
    expect(html).toContain(`<p class="typed">Pat Jones</p>`);
    expect(html).toContain(`<p class="typed">Pat Provider</p>`);
    expect(html).toContain("Signed 2026-12-03");
    expect(html).toContain(HASH);
  });

  it("a half-signed document shows one name and one awaiting", () => {
    const html = renderProposalHtml(content(), opts({ signatures: [sig("client")] }));
    expect(html).toContain(`<p class="typed">Pat Jones</p>`);
    expect(html.match(/Awaiting signature/g)).toHaveLength(1);
  });

  it("the audit page is present only when auditPage is true and lists both signatures", () => {
    expect(renderProposalHtml(content(), signed())).not.toContain("Audit page");
    const html = renderProposalHtml(content(), signed({ auditPage: true }));
    expect(html).toContain("Audit page");
    expect(html).toContain("Client: Pat Jones");
    expect(html).toContain("Provider: Pat Provider");
    expect(html).toContain("203.0.113.9");
    expect(html).toContain("2026-12-03 19:30:00 UTC");
    expect(html).toContain("Mozilla/5.0 Test");
    expect(html).toContain("Consent version</th><td>1<");
    expect(html).toContain("Consent to electronic records and signatures");
    expect(html).toContain("Signed electronically under the US ESIGN Act");
    expect(html).toContain(`class="audit"`);
    expect((html.match(new RegExp(HASH, "g")) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("the user agent is truncated to 200 characters", () => {
    const ua = `${"a".repeat(200)}TAIL`;
    const html = renderProposalHtml(content(), signed({ auditPage: true, signatures: [sig("client", { userAgent: ua }), sig("provider")] }));
    expect(html).toContain("a".repeat(200));
    expect(html).not.toContain("a".repeat(201));
    expect(html).not.toContain("TAIL");
  });

  it("a missing ip or user agent says not recorded", () => {
    const html = renderProposalHtml(content(), signed({ auditPage: true, signatures: [sig("client", { ip: null, userAgent: null }), sig("provider")] }));
    expect(html.match(/not recorded/g)).toHaveLength(2);
  });

  it("no script tag and no external URL in the output", () => {
    for (const mode of ["screen", "pdf"] as const) {
      const html = renderProposalHtml(content(), signed({ mode, auditPage: true, draftBanner: true }));
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/https?:\/\//i);
      expect(html).not.toMatch(/\b(src|href)=/i);
      expect(html).not.toMatch(/@import|url\(/i);
    }
    expect(PROPOSAL_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'");
  });

  it("draftBanner renders the banner", () => {
    expect(renderProposalHtml(content(), opts({ draftBanner: true }))).toContain("DRAFT — clauses pending legal review");
    expect(renderProposalHtml(content(), opts())).not.toContain("pending legal review");
  });

  it("a voided or expired document says so", () => {
    expect(renderProposalHtml(content(), opts({ status: "void" }))).toContain("has been voided");
    expect(renderProposalHtml(content(), opts({ status: "expired" }))).toContain("has expired");
    expect(renderProposalHtml(content(), opts())).not.toContain("class=\"banner state\"");
  });

  it("marks the page for its mode", () => {
    expect(renderProposalHtml(content(), opts({ mode: "pdf" }))).toContain(`<body class="pdf">`);
    expect(renderProposalHtml(content(), opts({ mode: "screen" }))).toContain(`<body class="screen">`);
  });
});
