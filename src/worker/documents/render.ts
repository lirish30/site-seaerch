import { dollars } from "../../client/packagesView";
import type { DocumentStatus, SignatureRecord } from "../db/documents";
import type { ProposalContent } from "./proposal";
import type { Milestone, Recurring } from "./schedule";

/** Sent with the page: nothing may load or run, and only this site may frame it. */
export const PROPOSAL_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";

export interface ProposalRenderOptions {
  mode: "screen" | "pdf";
  status: DocumentStatus;
  contentSha256: string | null;
  signatures: SignatureRecord[];
  auditPage: boolean;
  draftBanner: boolean;
}

const USER_AGENT_MAX = 200;

/** The only way text reaches the page. Every name, note, signer name and user agent is a person's or a prospect's, never markup. */
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const paragraphs = (s: string): string => s.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
const list = (items: string[]): string => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
/** The calendar day of an ISO instant, in UTC. */
const day = (iso: string | null): string => (iso ? esc(iso.slice(0, 10)) : "&mdash;");
const instant = (iso: string): string => esc(iso.replace("T", " ").replace(/\.\d+Z$/, "Z").replace(/Z$/, " UTC"));

const DUE: Record<Milestone["dueOn"], string> = { signing: "At signing", design_approved: "When the design is approved", site_finished: "When the site is finished" };
const STARTS: Record<Recurring["startsOn"], string> = { signing: "from signing", launch: "from launch", kickoff: "from kickoff" };

function recurringLine(r: Recurring): string {
  const term = r.termMonths === null ? "until cancelled" : `for ${r.termMonths} months`;
  return `${esc(dollars(r.monthlyCents))} per month, ${STARTS[r.startsOn]}, ${term}${r.firstMonthPrepaid ? ". The first month is paid at signing." : ""}`;
}

function header(c: ProposalContent): string {
  const h = c.header;
  return `<header class="head"><p class="eyebrow">Proposal and statement of work</p><h1>${esc(h.clientName)}</h1>
<table class="kv"><tr><th>Reference</th><td>${esc(h.reference)}</td><th>Version</th><td>${esc(String(h.version))}</td></tr>
<tr><th>Prepared</th><td>${day(h.preparedOn)}</td><th>Sent</th><td>${day(h.sentOn)}</td></tr>
<tr><th>Expires</th><td>${day(h.expiresOn)}</td><th></th><td></td></tr>
<tr><th>Prepared for</th><td>${esc(h.contactName)}<br>${esc(h.contactEmail)}<br>${esc(h.clientName)}</td>
<th>Prepared by</th><td>${esc(h.providerName)}<br>${esc(h.providerBusiness)}<br>${esc(h.providerEmail)}</td></tr></table></header>`;
}

function packages(c: ProposalContent): string {
  return `<section><h2>Packages and prices</h2>${c.packages.map((p) =>
    `<div class="pkg"><div class="pkg-top"><h3>${esc(p.name)}</h3><span class="price">${esc(p.priceLine)}</span></div>${p.includes.length ? list(p.includes) : ""}</div>`).join("")}</section>`;
}

function scope(c: ProposalContent): string {
  return `${c.scopeNotes.trim() ? `<section><h2>Scope notes</h2>${paragraphs(c.scopeNotes)}</section>` : ""}${
    c.assumptions.length ? `<section><h2>Assumptions</h2>${list(c.assumptions)}</section>` : ""}${
    c.outOfScope.length ? `<section><h2>Out of scope</h2>${list(c.outOfScope)}</section>` : ""}`;
}

function phases(c: ProposalContent): string {
  const s = c.schedule;
  const due = new Map(s.milestones.map((m) => [m.id, m]));
  return `<section><h2>Phases and payment schedule</h2>${c.phases.map((p, i) => {
    const m = p.milestoneId === null ? undefined : due.get(p.milestoneId);
    return `<div class="phase"><h3>${i + 1}. ${esc(p.name)}</h3>${paragraphs(p.summary)}${m ? `<p class="due">Payment due: ${esc(m.label)}, ${esc(dollars(m.amountCents))}</p>` : ""}</div>`;
  }).join("")}
<table class="grid"><thead><tr><th>Payment</th><th>Due</th><th class="num">Amount</th></tr></thead><tbody>${s.milestones.map((m) =>
    `<tr><td>${esc(m.label)}</td><td>${DUE[m.dueOn]}</td><td class="num">${esc(dollars(m.amountCents))}</td></tr>`).join("")}${s.recurring.map((r) =>
    `<tr><td>${esc(r.name)}</td><td colspan="2">${recurringLine(r)}</td></tr>`).join("")}</tbody>
<tfoot><tr><th colspan="2">Deposit due at signing</th><td class="num">${esc(dollars(s.depositCents))}</td></tr></tfoot></table></section>`;
}

function clauses(c: ProposalContent): string {
  return `<section><h2>Terms</h2>${c.clauses.map((x, i) => `<div class="clause"><h3>${i + 1}. ${esc(x.title)}</h3>${paragraphs(x.text)}</div>`).join("")}</section>`;
}

function signatureBlock(c: ProposalContent, o: ProposalRenderOptions): string {
  const slot = (role: SignatureRecord["role"], label: string, org: string): string => {
    const sig = o.signatures.find((s) => s.role === role);
    return `<div class="sig"><h3>${esc(label)}</h3><p class="org">${esc(org)}</p>${sig
      ? `<p class="typed">${esc(sig.signerName)}</p><p class="when">Signed ${day(sig.signedAt)}</p>`
      : `<p class="await">Awaiting signature</p>`}</div>`;
  };
  return `<section class="signatures"><h2>Signatures</h2><div class="sigs">${slot("client", "Client", c.header.clientName)}${slot("provider", "Provider", c.header.providerBusiness)}</div>${
    o.contentSha256 ? `<p class="hash">Document fingerprint (SHA-256): <code>${esc(o.contentSha256)}</code></p>` : ""}</section>`;
}

function auditPage(c: ProposalContent, o: ProposalRenderOptions): string {
  const rows = o.signatures.length ? o.signatures.map((s) => `<div class="audit-sig"><h3>${s.role === "client" ? "Client" : "Provider"}: ${esc(s.signerName)}</h3>
<table class="kv"><tr><th>${s.role === "client" ? "Email the link was sent to" : "Email"}</th><td>${esc(s.signerEmail)}</td></tr><tr><th>Signed at</th><td>${instant(s.signedAt)}</td></tr>
<tr><th>IP address</th><td>${s.ip ? esc(s.ip) : "not recorded"}</td></tr>
<tr><th>User agent</th><td>${s.userAgent ? esc(s.userAgent.slice(0, USER_AGENT_MAX)) : "not recorded"}</td></tr>
<tr><th>Consent version</th><td>${esc(String(s.consentVersion))}</td></tr>
<tr><th>Document hash</th><td><code>${esc(s.contentSha256)}</code></td></tr></table>
<p class="consent-h">Consent shown at signing</p><div class="consent">${paragraphs(s.consentText)}</div></div>`).join("") : "<p>No signatures yet.</p>";
  return `<section class="audit"><h2>Audit page</h2><p>${esc(c.header.reference)} version ${esc(String(c.header.version))} for ${esc(c.header.clientName)}.</p>${
    o.contentSha256 ? `<p class="hash">Document hash (SHA-256): <code>${esc(o.contentSha256)}</code></p>` : ""}${rows}<p class="esign">Signed electronically under the US ESIGN Act.</p></section>`;
}

const CSS = `*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#14202b;background:#fff;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.page{max-width:780px;margin:0 auto;padding:32px 20px 64px}.pdf .page{max-width:none;padding:0}
h1{margin:0 0 14px;font-size:30px;line-height:1.15;letter-spacing:-.01em}h2{margin:28px 0 10px;font-size:19px;border-bottom:1px solid #d5dce3;padding-bottom:4px;break-after:avoid}
h3{margin:0 0 4px;font-size:15px}p{margin:0 0 8px}ul{margin:4px 0 8px;padding-left:20px}li{margin-bottom:2px}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#1f5fbf;margin:0 0 4px}
.banner{background:#fff3cd;border:1px solid #e0b84a;color:#5c4400;font-weight:700;text-align:center;padding:8px 12px;margin:0 0 18px;letter-spacing:.04em}
.banner.state{background:#fde8e8;border-color:#d97b7b;color:#7a1f1f}
table{border-collapse:collapse;width:100%}.kv th{text-align:left;color:#5b6b79;font-weight:600;padding:3px 10px 3px 0;vertical-align:top;white-space:nowrap}.kv td{padding:3px 14px 3px 0;vertical-align:top;overflow-wrap:anywhere}
.grid th,.grid td{border:1px solid #d5dce3;padding:6px 8px;text-align:left;vertical-align:top}.grid thead th{background:#f2f5f8}.grid tfoot th,.grid tfoot td{background:#f2f5f8;font-weight:700}.num{text-align:right!important;white-space:nowrap}
.pkg,.phase,.clause,.sig,.audit-sig{break-inside:avoid;margin-bottom:12px}.pkg-top{display:flex;justify-content:space-between;gap:12px}.price{font-weight:700;white-space:nowrap}
.due{color:#34424f;font-style:italic}.sigs{display:flex;gap:24px}.sig{flex:1;border:1px solid #d5dce3;border-radius:6px;padding:12px}.org{color:#5b6b79}
.typed{font-family:"Snell Roundhand","Brush Script MT","Segoe Script",cursive;font-size:24px;margin:8px 0 2px;overflow-wrap:anywhere}.when{color:#5b6b79;font-size:13px}.await{color:#8a6a00;font-weight:600;margin-top:12px}
.hash,code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere;word-break:break-all}.consent{border-left:3px solid #d5dce3;padding-left:12px;color:#34424f}.consent-h{font-weight:600;margin:10px 0 4px}
.audit{break-before:page;page-break-before:always}.esign{font-weight:700;margin-top:16px}
@media (max-width:560px){.sigs{flex-direction:column;gap:12px}.pkg-top{flex-direction:column;gap:2px}}`;

/** The proposal and SOW as one self-contained page: inline CSS, no script, no request of its own. Every dynamic string goes through `esc()`. */
export function renderProposalHtml(c: ProposalContent, o: ProposalRenderOptions): string {
  const state = o.status === "void" ? "This document has been voided and can no longer be signed."
    : o.status === "expired" ? "This proposal has expired and can no longer be signed." : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.header.clientName)} proposal ${esc(c.header.reference)}</title><style>${CSS}</style></head><body class="${o.mode}"><main class="page">${
    o.draftBanner ? `<div class="banner">DRAFT — clauses pending legal review</div>` : ""}${state ? `<div class="banner state">${esc(state)}</div>` : ""}${
    header(c)}${packages(c)}${scope(c)}${phases(c)}${clauses(c)}${signatureBlock(c, o)}${o.auditPage ? auditPage(c, o) : ""}</main></body></html>`;
}
