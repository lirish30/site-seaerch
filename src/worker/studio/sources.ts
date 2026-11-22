// The facts a Studio post is written from (Plan 15). Two sources, both read from our own records and nothing else:
//  - `auditTips`: the findings a lead's audit report shows (what is wrong, and the fix it gives), made anonymous by default so a post never says whose site it was;
//  - `caseFacts`: what was done for a client, from its projects, packages and subscriptions, with no number the app did not measure.
// What these return reaches Claude only inside the untrusted block of a `studio.copy` task, so a finding that tries to give an instruction is only ever text there.
import { getAudit } from "../db/audits";
import { businessDomain, getBusiness } from "../db/businesses";
import { getDeal } from "../db/deals";
import { listSubscriptions } from "../db/subscriptions";
import { SEO_ONBOARDING_KEY } from "../db/projects";
import { CARE_KEYS, isClient } from "../clients/record";
import type { Business, Finding } from "../types";

const TRADE_FALLBACK = "local business";
export const MAX_TIPS = 6;
const TITLE_MAX = 120;
const DETAIL_MAX = 300;

const SEVERITY_ORDER: Record<Finding["severity"], number> = { critical: 0, important: 1, nice: 2 };

const regexEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tokensOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number): string => { const c = Array.from(squash(s)); return c.length <= max ? c.join("") : `${c.slice(0, max - 1).join("").trimEnd()}…`; };

/** Words in a business name that identify nothing. */
const GENERIC = new Set(["the", "and", "of", "a", "an", "llc", "inc", "ltd", "co", "corp", "company", "service", "services"]);

/** A name, an address or a domain as a pattern that ignores case, spacing and punctuation between its words, and stops at a word edge. */
const looseWords = (text: string): RegExp | null => {
  const t = tokensOf(text);
  if (t.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${t.map(regexEscape).join("[^\\p{L}\\p{N}]*")}(?:['’]s)?(?![\\p{L}\\p{N}])`, `giu`);
};

/** The phone number as a pattern that matches however it is written ("(208) 555-0142", "208.555.0142", "+1 208 555 0142"). */
function phonePattern(phone: string | null): RegExp | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  const d = digits.length >= 10 ? digits.slice(-10) : digits;
  if (d.length < 7) return null;
  return new RegExp(`(?<!\\d)(?:\\+?1[^\\d]{0,3})?${[...d].join("[^\\d]{0,3}")}(?!\\d)`, "g");
}

/** The pieces of an address worth removing: the whole address, then each comma-separated part that says something (a street, a city, a state and zip code). */
function addressParts(address: string | null): string[] {
  const parts = (address ?? "").split(",").map(squash).filter((p) => Array.from(p).length >= 4 && !/^\d+$/.test(p));
  return parts;
}

/** One business's identifying details, as the patterns that take them out of a string. */
interface Identity {
  name: string;
  /** Tried in order: the longer pieces first, so a street goes before the city inside it. */
  steps: { pattern: RegExp; replacement: string }[];
  /** The whole name as words, and the first word of it that says something (it alone gives the business away). */
  nameWords: string;
  lead: string | null;
}

function identityOf(b: Pick<Business, "name" | "domain" | "website_url" | "phone" | "address">): Identity {
  const steps: Identity["steps"] = [];
  const add = (pattern: RegExp | null, replacement: string) => { if (pattern) steps.push({ pattern, replacement }); };
  const address = (b.address ?? "").trim();
  if (address) add(looseWords(address), "the address");
  const domain = businessDomain(b);
  if (domain) add(new RegExp(`(?:https?://)?(?:www\\.)?${regexEscape(domain)}(?:/[^\\s]*)?`, "gi"), "the website");
  add(phonePattern(b.phone), "the phone number");
  add(looseWords(b.name), "the business");
  for (const p of addressParts(b.address)) add(looseWords(p), "the area");
  const nameTokens = tokensOf(b.name);
  return {
    name: b.name,
    steps,
    nameWords: nameTokens.join(" "),
    lead: nameTokens.find((t) => !GENERIC.has(t) && Array.from(t).length >= 3) ?? null,
  };
}

/** `s` with the business's name, domain, phone, address and city taken out, in ONE pass each (a name inside a name is not collapsed into a second one). */
function scrub(s: string, id: Identity): string {
  let out = s;
  for (const { pattern, replacement } of id.steps) out = out.replace(pattern, replacement);
  return squash(out);
}

/** Whether the business can still be told from `s`: its name as words, or the first word of it that says something. */
function stillNames(s: string, id: Identity): boolean {
  const words = tokensOf(s);
  if (id.nameWords && ` ${words.join(" ")} `.includes(` ${id.nameWords} `)) return true;
  return id.lead !== null && words.includes(id.lead);
}

/**
 * Whether any of `texts` names the business plainly: its whole name, its domain or its phone number (the first word of the name alone is not counted here: it may be an ordinary word). For a check on what
 * Claude wrote, which never saw the name when the post is anonymous. False when the business is unknown.
 */
export async function namesBusiness(db: D1Database, businessId: string, texts: string[]): Promise<boolean> {
  const b = await getBusiness(db, businessId);
  if (!b) return false;
  const id = identityOf(b);
  const domain = businessDomain(b);
  const phone = phonePattern(b.phone);
  return texts.some((t) => {
    const words = tokensOf(t);
    if (id.nameWords && ` ${words.join(" ")} `.includes(` ${id.nameWords} `)) return true;
    if (domain && t.toLowerCase().includes(domain)) return true;
    return !!phone && new RegExp(phone.source).test(t);
  });
}

export interface AuditTips { trade: string; tips: { title: string; detail: string }[] }

/**
 * The tips a post about an audit is written from: the findings the audit report shows (the problem it found and the fix it gives), worst first, at most six. With `anonymize` every string
 * (the trade included) has the business's name, domain, phone, address and city taken out first, and if any string still gives the business away the whole result is null: a tip that cannot be
 * made anonymous is not used. Null too when there is no audit, no business, or nothing to say. With `anonymize` off the text is passed on as it is.
 */
export async function auditTips(db: D1Database, auditId: string, o: { anonymize: boolean }): Promise<AuditTips | null> {
  const audit = await getAudit(db, auditId);
  if (!audit) return null;
  const business = await getBusiness(db, audit.business_id);
  if (!business) return null;
  const id = identityOf(business);
  const clean = (s: string): string => (o.anonymize ? scrub(s, id) : squash(s));

  const findings = audit.findings
    .filter((f) => f.category !== "site" && squash(f.evidence ?? "") !== "")
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.i - b.i)
    .slice(0, MAX_TIPS);
  const tips = findings.map(({ f }) => ({ title: cut(clean(f.evidence), TITLE_MAX), detail: cut(clean(f.recommendation ?? ""), DETAIL_MAX) }));
  if (tips.length === 0) return null;
  const trade = cut(clean(business.category?.trim() || TRADE_FALLBACK), 80);

  if (o.anonymize && [trade, ...tips.flatMap((t) => [t.title, t.detail])].some((s) => stillNames(s, id))) return null;
  return { trade, tips };
}

export interface CaseFacts { trade: string; built: string[]; care: boolean; seo: boolean }

/** What a package is, in words a post can use. */
const PACKAGE_WORDS: Record<string, string> = {
  quick_fix: "a quick fix to an existing website", starter_site: "a starter website", growth_site: "a growth website", website_subscription: "a website on a monthly plan",
};
const BUILD_WORDS = "a new website";

/**
 * What was done for a client, from its projects, packages and subscriptions only: the kind of work finished, whether Care is running and whether Local SEO is. There is no number in it (no result,
 * price, count or date), because the app measured none for a post. Null when the business is not a client or nothing was done yet.
 */
export async function caseFacts(db: D1Database, businessId: string): Promise<CaseFacts | null> {
  const business = await getBusiness(db, businessId);
  if (!business || !(await isClient(db, businessId))) return null;
  const projects = (await db.prepare(`SELECT kind, status, template_key, deal_id FROM projects WHERE business_id = ? AND test = 0 AND status != 'cancelled' ORDER BY created_at, id`)
    .bind(businessId).all<{ kind: string; status: string; template_key: string | null; deal_id: string | null }>()).results;

  const built = new Set<string>();
  for (const p of projects) {
    if (p.status !== "done" || (p.kind !== "build" && p.kind !== "quick_fix")) continue;
    const deal = p.deal_id ? await getDeal(db, p.deal_id) : null;
    const named = (deal?.priceSnapshot ?? []).map((s) => PACKAGE_WORDS[s.key]).filter((w): w is string => !!w);
    for (const w of named.length ? named : [p.kind === "quick_fix" ? PACKAGE_WORDS.quick_fix : BUILD_WORDS]) built.add(w);
  }

  const live = (await listSubscriptions(db, { businessId, statuses: ["active", "past_due"] })).filter((s) => !s.test);
  const care = live.some((s) => (CARE_KEYS as readonly string[]).includes(s.packageKey)) || projects.some((p) => p.kind === "care_onboarding" && (p.status === "done" || p.status === "active"));
  const seo = live.some((s) => s.packageKey === "local_seo" || s.packageKey === "local_seo_growth") || projects.some((p) => p.template_key === SEO_ONBOARDING_KEY && (p.status === "done" || p.status === "active"));

  if (built.size === 0 && !care && !seo) return null;
  return { trade: cut(business.category?.trim() || TRADE_FALLBACK, 80), built: [...built], care, seo };
}
