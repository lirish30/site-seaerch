import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { countViews, createDraft, expireDue, getDocument, signaturesFor, voidDocument } from "../src/worker/db/documents";
import { listActivity } from "../src/worker/db/activity";
import { saveSettings } from "../src/worker/db/settings";
import { CONSENT_LABEL, ESIGN_DISCLOSURE, ESIGN_VERSION, authorityLabel } from "../src/worker/documents/consent";
import { afterSign, SignFormSchema, proposalPage, signProposal, type PublicProposal } from "../src/worker/documents/public";
import type { ProposalContent } from "../src/worker/documents/proposal";
import { REVIEWED_CONFIG, proposal, seedDeal, sendDraft } from "./fixtures/documents";

const NOW = new Date("2026-12-02T09:00:00.000Z");
const MIN = 60_000;
const view = (token: string, now = NOW, userAgent: string | null = "TestBrowser/1.0") => proposalPage(env, token, { now, userAgent });
const sign = (token: string, hash: string, o: { name?: string; ip?: string | null; userAgent?: string | null; now?: Date } = {}) =>
  signProposal(env, token, { name: o.name ?? "Pat Jones", consent: true, authority: true, sha256: hash }, { now: o.now ?? NOW, ip: o.ip === undefined ? "203.0.113.9" : o.ip, userAgent: o.userAgent === undefined ? "TestBrowser/1.0" : o.userAgent });

/** A sent proposal: its token, the hash a client would send, and the document. */
async function sent(o: { clientName?: string; test?: boolean; expiresAt?: string } = {}) {
  const s = await seedDeal();
  const content: ProposalContent = proposal();
  if (o.clientName) content.header = { ...content.header, clientName: o.clientName };
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content, test: o.test });
  const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: o.expiresAt });
  return { ...s, doc, hash, token: doc.token! };
}
const open = (p: PublicProposal | null) => { if (!p || p.state === "closed") throw new Error(`expected an open or signed page, got ${p?.state ?? "null"}`); return p; };
const clientRows = async (id: string) => (await signaturesFor(env.DB, id)).filter((s) => s.role === "client");
const sigCount = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM document_signatures`).first<{ n: number }>())!.n;

describe("proposalPage", () => {
  it("unknown, malformed and draft tokens are a 404; void and expired tokens show the closed page with no content", async () => {
    const a = await sent();
    expect(await view("A".repeat(43))).toBeNull();
    for (const bad of ["", "short", a.token.slice(1), `${a.token}x`, `${a.token.slice(0, 42)}+`, `${a.token.slice(0, 42)} `, a.token.toLowerCase() === a.token ? a.token.toUpperCase() : a.token.toLowerCase()]) {
      expect(await view(bad), JSON.stringify(bad)).toBeNull();
    }
    // A draft has no link; even a token forced onto one is not served.
    const s = await seedDeal();
    const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
    await env.DB.prepare(`UPDATE documents SET token = ? WHERE id = ?`).bind("D".repeat(43), draft.id).run();
    expect(await view("D".repeat(43))).toBeNull();
    expect(await countViews(env.DB, draft.id)).toBe(0);

    await saveSettings(env.DB, { contact_email: "logan@siteline.test" });
    await voidDocument(env.DB, a.doc.id, "wrong option");
    const voided = await view(a.token);
    expect(voided).toEqual({ state: "closed", clientName: "Ace Plumbing", contactEmail: "logan@siteline.test" });

    const b = await sent({ clientName: "Zed Heating" });
    expect(await expireDue(env.DB, "2027-01-01T00:00:00.000Z")).toBe(1);
    expect(await view(b.token)).toEqual({ state: "closed", clientName: "Zed Heating", contactEmail: "logan@siteline.test" });
    expect(await countViews(env.DB, a.doc.id)).toBe(0); // a closed page records nothing
    expect(await countViews(env.DB, b.doc.id)).toBe(0);
  });

  it("a sent proposal past its expiry reads as closed even before the cron has expired it, and records no view", async () => {
    const a = await sent();
    const late = new Date("2026-12-15T17:00:00.000Z"); // exactly the expiry instant: signing is refused, so the page is closed
    expect(await view(a.token, late)).toMatchObject({ state: "closed", clientName: "Ace Plumbing" });
    expect(await view(a.token, new Date("2027-02-01T00:00:00.000Z"))).toMatchObject({ state: "closed" });
    expect(await countViews(env.DB, a.doc.id)).toBe(0);
    expect((await getDocument(env.DB, a.doc.id))!.status).toBe("sent");
    expect(await view(a.token, new Date("2026-12-15T16:59:59.999Z"))).toMatchObject({ state: "open" });
  });

  it("the closed page falls back to the proposal's own sender address when settings have none", async () => {
    const a = await sent();
    await saveSettings(env.DB, { contact_email: "  " });
    await voidDocument(env.DB, a.doc.id, "x");
    expect(await view(a.token)).toEqual({ state: "closed", clientName: "Ace Plumbing", contactEmail: "hello@siteline.test" });
  });

  it("viewing records one view and moves sent to viewed", async () => {
    const a = await sent();
    const page = open(await view(a.token));
    expect(page.state).toBe("open");
    let doc = (await getDocument(env.DB, a.doc.id))!;
    expect(doc.status).toBe("viewed");
    expect(doc.firstViewedAt).toBe(NOW.toISOString());
    expect(await countViews(env.DB, a.doc.id)).toBe(1);
    // Again within ten minutes: still one row. Later: a second.
    await view(a.token, new Date(NOW.getTime() + 5 * MIN));
    expect(await countViews(env.DB, a.doc.id)).toBe(1);
    await view(a.token, new Date(NOW.getTime() + 11 * MIN), "Other/2.0");
    expect(await countViews(env.DB, a.doc.id)).toBe(2);
    doc = (await getDocument(env.DB, a.doc.id))!;
    expect(doc.status).toBe("viewed");
    expect(doc.firstViewedAt).toBe(NOW.toISOString());
    const ua = await env.DB.prepare(`SELECT user_agent FROM document_views WHERE document_id = ? ORDER BY viewed_at`).bind(a.doc.id).all<{ user_agent: string }>();
    expect(ua.results.map((r) => r.user_agent)).toEqual(["TestBrowser/1.0", "Other/2.0"]);
  });

  it("the page carries the rendered proposal, the consent texts and nothing else", async () => {
    const a = await sent();
    const page = open(await view(a.token));
    expect(Object.keys(page).sort()).toEqual(["authorityLabel", "clientName", "consentLabel", "contactEmail", "contentSha256", "disclosure", "expiresAt", "html", "payment", "signed", "state"]);
    expect(page).toMatchObject({
      state: "open", contentSha256: a.hash, expiresAt: "2026-12-15T17:00:00.000Z", clientName: "Ace Plumbing", disclosure: ESIGN_DISCLOSURE, consentLabel: CONSENT_LABEL,
      authorityLabel: authorityLabel("Ace Plumbing"), signed: null, payment: { state: "none" },
    });
    expect(page.html).toMatch(/^<!doctype html>/);
    expect(page.html).toContain("Awaiting signature"); // the client's slot is empty, the provider's is signed
    expect(page.html).not.toContain("<script");
    const text = JSON.stringify(page);
    for (const secret of [a.token, a.doc.id, a.dealId, a.businessId]) expect(text).not.toContain(secret);
  });

  it("the draft banner shows until the clauses are reviewed, and always on a test document", async () => {
    const a = await sent();
    expect(open(await view(a.token)).html).toContain("DRAFT");
    await saveSettings(env.DB, { documents_config: REVIEWED_CONFIG });
    expect(open(await view(a.token)).html).not.toContain("DRAFT");
    const t = await sent({ test: true });
    expect(open(await view(t.token)).html).toContain("DRAFT");
  });

  it("the page html escapes a business name with markup", async () => {
    const a = await sent({ clientName: `<script>alert(1)</script> & "Co"` });
    const page = open(await view(a.token));
    expect(page.html).not.toContain("<script");
    expect(page.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;");
    // The raw name is plain data for the page, which shows it through React.
    expect(page.clientName).toBe(`<script>alert(1)</script> & "Co"`);
    expect(page.authorityLabel).toBe(`I am authorized to sign for <script>alert(1)</script> & "Co"`);
  });
});

describe("signProposal", () => {
  it("sign stores name, ip, user agent, consent text and the hash", async () => {
    const a = await sent();
    await view(a.token);
    const r = await sign(a.token, a.hash, { name: "  Pat   Jones ", ip: "203.0.113.9", userAgent: "Mozilla/5.0 (Test)" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page.state).toBe("signed");
    const page = open(r.page);
    expect(page.signed).toEqual({ name: "Pat   Jones", at: NOW.toISOString() });
    expect(page.html).toContain("Pat   Jones");
    expect(page.html).not.toContain("Awaiting signature");

    const doc = (await getDocument(env.DB, a.doc.id))!;
    expect(doc).toMatchObject({ status: "signed", signedAt: NOW.toISOString() });
    const [mine] = await clientRows(a.doc.id);
    expect(mine).toMatchObject({
      role: "client", signerName: "Pat   Jones", signerEmail: "pat@ace.test", signedAt: NOW.toISOString(), ip: "203.0.113.9", userAgent: "Mozilla/5.0 (Test)",
      consentVersion: ESIGN_VERSION, contentSha256: a.hash,
    });
    expect(mine.consentText).toBe([ESIGN_DISCLOSURE, CONSENT_LABEL, authorityLabel("Ace Plumbing")].join("\n\n"));
    expect((await signaturesFor(env.DB, a.doc.id)).map((s) => s.role).sort()).toEqual(["client", "provider"]);
    const act = await listActivity(env.DB, a.businessId);
    expect(act.filter((x) => x.kind === "proposal_signed")).toHaveLength(1);
    expect(act.find((x) => x.kind === "proposal_signed")!.detail).toContain("Pat   Jones");
  });

  it("the name is stored trimmed, and a missing ip or user agent is stored as nothing", async () => {
    const a = await sent();
    expect((await sign(a.token, a.hash, { name: "\u00a0 Pat Jones \u3000", ip: null, userAgent: null })).ok).toBe(true);
    expect(await clientRows(a.doc.id)).toMatchObject([{ signerName: "Pat Jones", ip: null, userAgent: null }]);
  });

  it("a signed document stays viewable and says who signed", async () => {
    const a = await sent();
    await view(a.token);
    await sign(a.token, a.hash, { name: "Pat Jones" });
    const later = new Date(NOW.getTime() + 60 * 86_400_000); // long after the proposal's own expiry
    const page = open(await view(a.token, later));
    expect(page.state).toBe("signed");
    expect(page.signed).toEqual({ name: "Pat Jones", at: NOW.toISOString() });
    expect(page.html).toContain("Pat Jones");
    expect(page.html).toContain("Pat Provider"); // the provider's countersignature is there too
    expect(page.html).not.toContain("Awaiting signature");
    expect(page.contentSha256).toBe(a.hash);
    expect(await countViews(env.DB, a.doc.id)).toBe(1); // opening a signed paper records no further view
  });

  it("sign with a stale hash is refused", async () => {
    const a = await sent();
    for (const stale of ["0".repeat(64), "f".repeat(64)]) {
      expect(await sign(a.token, stale)).toEqual({ ok: false, status: 409, error: "this proposal changed, reload" });
    }
    expect(await clientRows(a.doc.id)).toEqual([]);
    expect((await getDocument(env.DB, a.doc.id))!.status).toBe("sent");
    // An upper-case copy of the right hash is the same hash.
    expect((await sign(a.token, a.hash.toUpperCase())).ok).toBe(true);
  });

  it("an unknown or malformed token is a 404 whatever the form says", async () => {
    expect(await sign("A".repeat(43), "0".repeat(64))).toEqual({ ok: false, status: 404, error: "not found" });
    expect(await sign("short", "0".repeat(64))).toEqual({ ok: false, status: 404, error: "not found" });
    const before = await sigCount();
    const r = await signProposal(env, "A".repeat(43), { name: "x", consent: false }, { now: NOW, ip: null, userAgent: null });
    expect(r).toEqual({ ok: false, status: 404, error: "not found" }); // the form is not looked at before the token
    expect(await sigCount()).toBe(before);
  });

  it("sign with consent false or authority false is a 400", async () => {
    const a = await sent();
    const base = { name: "Pat Jones", consent: true, authority: true, sha256: a.hash };
    for (const bad of [{ consent: false }, { authority: false }, { consent: undefined }, { authority: "true" }, { consent: 1 }]) {
      const r = await signProposal(env, a.token, { ...base, ...bad }, { now: NOW, ip: null, userAgent: null });
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false, status: 400 });
      expect(SignFormSchema.safeParse({ ...base, ...bad }).success).toBe(false);
    }
    expect(await signProposal(env, a.token, { ...base, extra: 1 }, { now: NOW, ip: null, userAgent: null })).toMatchObject({ ok: false, status: 400 });
    expect(await signProposal(env, a.token, { ...base, sha256: "xyz" }, { now: NOW, ip: null, userAgent: null })).toMatchObject({ ok: false, status: 400 });
    expect(await clientRows(a.doc.id)).toEqual([]);
  });

  it("a name with a bidi override or control character is a 400", async () => {
    const a = await sent();
    for (const name of ["Pat\u202eJones", "\u202ePat Jones", "Pat\u0000Jones", "Pat\u0007", "Pat\nJones", "Pat\u2066Jones", "Pat\u200fJones", "Pat\u2028Jones", "Pat\u007fJones"]) {
      const r = await sign(a.token, a.hash, { name });
      expect(r, JSON.stringify(name)).toMatchObject({ ok: false, status: 400 });
    }
    // Too short, no letters, blank.
    for (const name of ["A", " A ", "12", "?!", "   ", ""]) expect(await sign(a.token, a.hash, { name }), JSON.stringify(name)).toMatchObject({ ok: false, status: 400 });
    expect(await clientRows(a.doc.id)).toEqual([]);
  });

  it("a 5000-character name is a 400", async () => {
    const a = await sent();
    expect(await sign(a.token, a.hash, { name: "A".repeat(5000) })).toMatchObject({ ok: false, status: 400 });
    expect(await sign(a.token, a.hash, { name: "A".repeat(121) })).toMatchObject({ ok: false, status: 400 });
    expect((await sign(a.token, a.hash, { name: "A".repeat(120) })).ok).toBe(true);
  });

  it("a name that is markup is stored as typed and shown escaped", async () => {
    const a = await sent();
    const r = await sign(a.token, a.hash, { name: `<img src=x onerror=alert(1)> Jones` });
    expect(r.ok).toBe(true);
    if (!r.ok || r.page.state === "closed") return;
    expect(r.page.html).not.toContain("<img");
    expect(r.page.html).toContain("&lt;img src=x onerror=alert(1)&gt; Jones");
    expect((await clientRows(a.doc.id))[0].signerName).toBe(`<img src=x onerror=alert(1)> Jones`);
  });

  it("a second sign returns the first signature and adds no row", async () => {
    const a = await sent();
    const first = await sign(a.token, a.hash, { name: "Pat Jones", ip: "203.0.113.9" });
    const before = await signaturesFor(env.DB, a.doc.id);
    const second = await sign(a.token, a.hash, { name: "Someone Else", ip: "198.51.100.7", now: new Date(NOW.getTime() + 5 * MIN) });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(open(second.page).signed).toEqual({ name: "Pat Jones", at: NOW.toISOString() });
    expect(second.page).toEqual(first.page);
    expect(await signaturesFor(env.DB, a.doc.id)).toEqual(before);
    expect((await listActivity(env.DB, a.businessId)).filter((x) => x.kind === "proposal_signed")).toHaveLength(1);
    // A retry that carries a stale hash is not an answer to the signed paper.
    expect(await sign(a.token, "0".repeat(64))).toMatchObject({ ok: false, status: 409 });
  });

  it("two simultaneous signs leave one signature", async () => {
    const a = await sent();
    const results = await Promise.all([sign(a.token, a.hash, { name: "Pat Jones" }), sign(a.token, a.hash, { name: "Pat Jones" }), sign(a.token, a.hash, { name: "Pat Jones" })]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await clientRows(a.doc.id)).toHaveLength(1);
    expect((await listActivity(env.DB, a.businessId)).filter((x) => x.kind === "proposal_signed")).toHaveLength(1);
    expect((await getDocument(env.DB, a.doc.id))!.status).toBe("signed");
  });

  it("sign after expiry is a 409", async () => {
    const a = await sent();
    const after = new Date("2026-12-16T00:00:00.000Z");
    expect(await sign(a.token, a.hash, { now: after })).toEqual({ ok: false, status: 409, error: "this proposal is no longer open" });
    expect(await sign(a.token, a.hash, { now: new Date("2026-12-15T17:00:00.000Z") })).toMatchObject({ ok: false, status: 409 }); // the expiry instant itself
    await expireDue(env.DB, "2027-01-01T00:00:00.000Z");
    expect(await sign(a.token, a.hash)).toMatchObject({ ok: false, status: 409 }); // now marked expired, whatever `now` says
    expect(await clientRows(a.doc.id)).toEqual([]);
  });

  it("a void document cannot be signed", async () => {
    const a = await sent();
    await voidDocument(env.DB, a.doc.id, "wrong option");
    expect(await sign(a.token, a.hash)).toEqual({ ok: false, status: 409, error: "this proposal is no longer open" });
    expect(await clientRows(a.doc.id)).toEqual([]);
  });

  it("the user agent is capped at 300 characters", async () => {
    const a = await sent();
    expect((await sign(a.token, a.hash, { userAgent: "u".repeat(5000), ip: "9".repeat(500) })).ok).toBe(true);
    const [mine] = await clientRows(a.doc.id);
    expect(mine.userAgent).toBe("u".repeat(300));
    expect(mine.ip).toBe("9".repeat(64));
    const b = await sent();
    await view(b.token, NOW, "v".repeat(5000));
    const ua = (await env.DB.prepare(`SELECT user_agent FROM document_views WHERE document_id = ?`).bind(b.doc.id).first<{ user_agent: string }>())!.user_agent;
    expect(ua).toBe("v".repeat(300));
  });

  it("a user agent with markup is stored as typed and never reaches the screen page", async () => {
    const a = await sent();
    await sign(a.token, a.hash, { userAgent: `<script>alert(1)</script>` });
    expect((await clientRows(a.doc.id))[0].userAgent).toBe(`<script>alert(1)</script>`);
    expect(open(await view(a.token)).html).not.toContain("<script"); // the screen page has no audit section
  });
});

describe("afterSign", () => {
  it("is a no-op that never throws, whatever it is given", async () => {
    const a = await sent();
    await expect(afterSign(env, a.doc)).resolves.toBeUndefined();
    await expect(afterSign({} as typeof env, a.doc)).resolves.toBeUndefined();
    expect(await clientRows(a.doc.id)).toEqual([]);
  });
});

describe("SignFormSchema", () => {
  const good = { name: "Pat Jones", consent: true, authority: true, sha256: "a".repeat(64) };
  it("trims the name, lower-cases the hash and rejects unknown keys", () => {
    expect(SignFormSchema.parse({ ...good, name: "  Pat Jones  ", sha256: "A".repeat(64) })).toEqual({ ...good });
    expect(SignFormSchema.safeParse({ ...good, x: 1 }).success).toBe(false);
    expect(SignFormSchema.safeParse({ ...good, sha256: "a".repeat(63) }).success).toBe(false);
    expect(SignFormSchema.safeParse({ ...good, sha256: `${"a".repeat(63)}g` }).success).toBe(false);
  });
});
