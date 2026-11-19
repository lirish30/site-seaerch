import { dollars } from "../../client/packagesView";
import type { PackageKey } from "../db/packages";
import type { DocumentsConfig } from "./config";

/**
 * The clause library behind every proposal and SOW. The text is original and every clause is a plain function of ClauseCtx.
 * Bump this on ANY change to a clause's text, so a signed document can say which wording the client agreed to.
 */
export const CLAUSE_LIBRARY_VERSION = 2;

/** The only place the contract numbers live (spec §11). Clause text reads them from here; nothing else spells them out. */
export const TERMS = {
  revisionRounds: 2,
  silenceDays: 14,
  requoteMonths: 6,
  pauseDays: 14,
  killFeePercent: 25,
  warrantyDays: 30,
  terminationDays: 30,
  subscriptionMonths: 24,
  seoFirstTermMonths: 6,
} as const;

export type ClauseId =
  | "scope_exclusions" | "change_orders" | "revisions" | "content_delays" | "payment_terms" | "late_fee" | "work_pause" | "kill_fee"
  | "ownership" | "warranty" | "termination" | "client_content" | "ai_content" | "accessibility" | "site_credit" | "no_ranking"
  | "care_terms" | "care_opt_out" | "subscription_term" | "seo_term" | "client_hosted";

export interface ClauseCtx {
  providerName: string;
  /** Passed through unchanged. The renderer escapes it (a prospect typed it). */
  clientName: string;
  keys: PackageKey[];
  careDeclined: boolean;
  /** The standard hourly rate, from the packages catalog. Never hard-coded here. */
  hourlyCents: number;
  /** The hourly rate for Care clients, or null when the catalog has none. */
  hourlyCareCents: number | null;
  config: DocumentsConfig;
}
export interface RenderedClause { id: ClauseId; title: string; text: string }

interface ClauseDef { id: ClauseId; title: string; applies?: (c: ClauseCtx) => boolean; text: (c: ClauseCtx) => string }
const has = (c: ClauseCtx, ...keys: PackageKey[]) => keys.some((k) => c.keys.includes(k));

const LIBRARY: ClauseDef[] = [
  { id: "scope_exclusions", title: "Scope and exclusions", text: (c) =>
    `${c.providerName} will deliver the work listed in the scope section of this document for ${c.clientName}, and nothing else. Anything not listed there is outside the project. That includes extra pages, new features, copywriting, photography, logo or brand design, third-party software fees, and domain or email setup, unless the scope names it. Work outside the scope is handled as a change order.` },
  { id: "change_orders", title: "Change orders", text: (c) =>
    `If ${c.clientName} asks for work outside the scope, ${c.providerName} will describe it and give an estimate before starting. Nothing outside the scope begins until ${c.clientName} approves the estimate in writing. Approved changes are billed at ${dollars(c.hourlyCents)} per hour${c.hourlyCareCents === null ? "" : `, or ${dollars(c.hourlyCareCents)} per hour while ${c.clientName} is on a Care plan`}, in 30-minute blocks. A change order is paid upfront or added to the next invoice, as the estimate says.` },
  { id: "revisions", title: "Revisions", text: (c) =>
    `The project includes ${TERMS.revisionRounds} revision rounds. A round is one consolidated set of feedback from ${c.clientName} on the work shown. Feedback sent in pieces counts as one round until ${c.providerName} has made the changes. Further rounds are change orders.` },
  { id: "content_delays", title: "Content and feedback delays", text: (c) =>
    `${c.providerName} needs ${c.clientName}'s content, approvals and access to keep the project moving. If ${c.providerName} hears nothing for ${TERMS.silenceDays} days after asking for them, the project goes to the back of the queue and restarts when ${c.providerName} has a free slot. If the project has been waiting on ${c.clientName} for more than ${TERMS.requoteMonths} months, ${c.providerName} may re-quote it at current prices before work resumes.` },
  { id: "payment_terms", title: "Payment terms", text: (c) =>
    `${c.clientName} pays the amounts and on the dates in the payment schedule table in this document. The deposit is due before any work starts. The final payment is due when the site is finished and ready for ${c.clientName}'s review, not at launch: a later launch date does not postpone it. Ownership and publication follow full payment, as set out under Ownership. Invoices are sent by email and are due on the date shown on them.` },
  { id: "late_fee", title: "Late fee", text: (c) =>
    `A balance that is past its due date accrues a late fee of ${c.config.lateFeePercentMonthly}% per month on the unpaid amount until it is paid. ${c.providerName} will remind ${c.clientName} before the due date, on it, and after it.` },
  { id: "work_pause", title: "Work pause for non-payment", text: (c) =>
    `If a payment is ${TERMS.pauseDays} days overdue, ${c.providerName} may pause all work for ${c.clientName}, including hosting changes and support requests, until the account is current. Dates in the project plan move by the length of the pause.` },
  { id: "kill_fee", title: "Kill fee", text: (c) =>
    `If ${c.clientName} ends the project before it is finished, ${c.clientName} owes ${c.providerName} for the work done so far and a kill fee of ${TERMS.killFeePercent}% of the remaining unpaid project price. Deposits already paid are applied to the amount owed.` },
  { id: "ownership", title: "Ownership", text: (c) =>
    `Ownership of the finished website and the custom work made for it transfers from ${c.providerName} to ${c.clientName} on full payment of everything owed under this document. Until then, ${c.providerName} owns the work and ${c.clientName} may not publish it. ${c.providerName} keeps ownership of its own tools, templates and general know-how, and gives ${c.clientName} a lasting right to use them as part of the site.` },
  { id: "warranty", title: "Warranty", text: (c) =>
    `For ${TERMS.warrantyDays} days after the site is finished, ${c.providerName} will fix any defect in the work, meaning something that does not work as the scope describes, at no charge. The warranty does not cover changes ${c.clientName} or anyone else makes to the site afterward, problems with third-party services, or new requests. Those are change orders.` },
  { id: "termination", title: "Termination", text: (c) =>
    `Either party may end this agreement by giving ${TERMS.terminationDays} days' written notice. ${c.clientName} pays for all work done up to the end date, and any kill fee or remaining term that applies under this document. ${c.providerName} hands over the work completed and paid for, and the clauses on ownership, payment and liability continue after the agreement ends.` },
  { id: "client_content", title: "Client content and legal pages", text: (c) =>
    `${c.clientName} promises that the text, images, logos and other material it supplies belong to it or that it has permission to use them, and agrees to cover ${c.providerName} for claims arising from that material. Legal pages such as a privacy policy and terms of use are drafted from ${c.clientName}'s answers and are not legal advice. ${c.clientName} is responsible for having them reviewed for its own business.` },
  { id: "ai_content", title: "AI-generated content", text: (c) =>
    `${c.providerName} may use AI tools to draft or edit parts of the work, such as copy or images. ${c.providerName} reviews what goes on the site, but ${c.clientName} should check facts, claims and licenses that matter to its business before approving. Where the scope includes AI-generated copy or images, they are delivered as drafts for ${c.clientName}'s review.` },
  { id: "accessibility", title: "Accessibility", text: (c) =>
    `${c.providerName} builds sites with accessibility in mind and tests the main templates. No site can promise to meet every accessibility standard for every visitor, and content ${c.clientName} adds later can affect it. This document is not a guarantee of legal compliance with any accessibility law.` },
  { id: "site_credit", title: "Site credit link", text: (c) =>
    `${c.clientName} agrees that ${c.providerName} may place a small credit link in the footer of the site. ${c.clientName} may ask for it to be removed at any time, and ${c.providerName} will remove it.` },
  { id: "no_ranking", title: "No ranking guarantees", text: (c) =>
    `${c.providerName} will follow good search practice, but search engines and AI assistants decide their own results. ${c.providerName} does not promise any ranking, traffic, number of leads or sales, and none of the amounts in this document depend on one.` },
  { id: "care_terms", title: "Care plan", applies: (c) => has(c, "care", "care_plus", "care_fallback"), text: (c) =>
    `The Care plan in this document covers hosting, updates, backups, security monitoring and the support listed in the schedule for ${c.clientName}'s site. It renews each billing period and is paid in advance by autopay. Edit time included in a period does not roll over. Either party may cancel with ${TERMS.terminationDays} days' written notice. Work beyond the plan is a change order.` },
  { id: "care_opt_out", title: "Care opt-out sign-off", applies: (c) => c.careDeclined, text: (c) =>
    `${c.clientName} has chosen not to take a Care plan. ${c.clientName} accepts responsibility for hosting, software updates, backups and security of the site after it is handed over, and understands that ${c.providerName} will not monitor or maintain it. ${c.providerName} is not liable for downtime, data loss or a security incident that a Care plan would have covered. Support after the warranty period is billed as a change order.` },
  { id: "subscription_term", title: "Website subscription term", applies: (c) => has(c, "website_subscription"), text: (c) =>
    `The website subscription runs for ${TERMS.subscriptionMonths} months from the start date. If ${c.clientName} ends it early, ${c.clientName} owes the payments for the remaining term. In month ${TERMS.subscriptionMonths + 1} the subscription converts to a Care plan automatically, unless ${c.clientName} chooses a site refresh before then.` },
  { id: "seo_term", title: "Local SEO term", applies: (c) => has(c, "local_seo", "local_seo_growth"), text: (c) =>
    `The first term of the local SEO service is ${TERMS.seoFirstTermMonths} months, billed monthly. After that it continues month to month and either party may cancel with ${TERMS.terminationDays} days' written notice. ${c.providerName} reports on its work each month. Local SEO is separate from any Care plan and is not included in one.` },
  { id: "client_hosted", title: "Client-hosted site", applies: (c) => has(c, "client_hosted_surcharge"), text: (c) =>
    `${c.clientName} keeps its own hosting. ${c.clientName} gives ${c.providerName} the access needed to do the Care work and keeps that access working. ${c.providerName} is not responsible for outages, speed or security problems caused by the host, and the extra monthly charge in the schedule covers the added work of managing a host it does not control.` },
];

/** The clauses that apply to this document, in a fixed order. The text is plain sentences; no markup, no escaping (the renderer escapes). */
export function clausesFor(ctx: ClauseCtx): RenderedClause[] {
  return LIBRARY.filter((d) => !d.applies || d.applies(ctx)).map((d) => ({ id: d.id, title: d.title, text: d.text(ctx) }));
}
