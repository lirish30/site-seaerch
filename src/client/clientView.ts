import type { AccessStatus, Site } from "../worker/db/sites";
import type { ClientRow } from "../worker/clients/record";
import { shortDate } from "./billingView";

/** Pure helpers for the owner's Clients pages. No DOM, no fetch, no clock of its own. */

export type AccessTone = "neutral" | "warn" | "good";

/** How a checklist line looks: still to do is warn, in hand is good, not applicable is quiet. */
export function accessTone(status: AccessStatus): AccessTone {
  if (status === "needed" || status === "requested") return "warn";
  if (status === "received" || status === "verified") return "good";
  return "neutral";
}

const WORDS: Record<AccessStatus, string> = { needed: "Needed", requested: "Requested", received: "Received", verified: "Verified", not_applicable: "Not applicable" };
export const accessWords = (status: AccessStatus): string => WORDS[status];

const MOVES: Record<AccessStatus, AccessStatus[]> = {
  needed: ["requested", "not_applicable"],
  requested: ["received", "needed", "not_applicable"],
  received: ["verified", "requested", "not_applicable"],
  verified: ["received", "not_applicable"],
  not_applicable: ["needed"],
};

/** The moves worth offering from this status, the likely next step first. The current status is never in the list. */
export const accessActions = (status: AccessStatus): AccessStatus[] => [...MOVES[status]];

/** `$129`, `$1,998.50`, `$0`. Integer cents in; whole dollars drop the cents. Anything that is not a finite number reads `$0`. `monthly` adds `/mo`. */
export function moneyLabel(cents: number, o: { monthly?: boolean } = {}): string {
  const n = Number.isFinite(cents) ? Math.round(cents) : 0;
  const abs = Math.abs(n);
  const dollars = Math.trunc(abs / 100).toLocaleString("en-US");
  const rest = abs % 100;
  return `${n < 0 ? "-" : ""}$${dollars}${rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`}${o.monthly ? "/mo" : ""}`;
}

/** Whole days from one calendar date to another (both `YYYY-MM-DD`), or null when either does not read as a date. */
function daysBetween(from: string, to: string): number | null {
  const parse = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(t);
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : null;
  };
  const a = parse(from), b = parse(to);
  return a === null || b === null ? null : Math.round((b - a) / 86_400_000);
}

const FAR_DAYS = 90;

/** "Renews in 12 days", "Renews today", "Term ended", "No term". Past 90 days out a date reads better than a count. `today` is the owner's calendar day. */
export function renewalLabel(nextRenewalOn: string | null, today: string): string {
  if (!nextRenewalOn) return "No term";
  const days = daysBetween(today, nextRenewalOn);
  if (days === null) return "No term";
  if (days < 0) return "Term ended";
  if (days === 0) return "Renews today";
  if (days === 1) return "Renews tomorrow";
  if (days <= FAR_DAYS) return `Renews in ${days} days`;
  return `Renews ${shortDate(nextRenewalOn, true)}`;
}

/** What a site is called on screen: its domain, or a plain line for one added by hand with no address yet. */
export const siteTitle = (site: Pick<Site, "domain">): string => site.domain?.trim() || "New site (no domain yet)";

/** An address that is safe to put in `href`: absolute http or https with no login in it. Anything else (javascript:, data:, a bare word, an empty string) is null, so it is shown as text and never linked. */
export function safeHref(url: string | null): string | null {
  const s = url?.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

const CARE_KEYS: readonly string[] = ["care", "care_plus", "care_fallback"];

/** True when a real Care subscription is late on a bill. The Care label still shows for such a client; this adds the "Payment late" badge. */
export const carePastDue = (subs: { packageKey: string; status: string; test: boolean }[]): boolean =>
  subs.some((s) => !s.test && s.status === "past_due" && CARE_KEYS.includes(s.packageKey));

export type ClientSort = "name" | "mrr" | "access";

/** A sorted copy: by name (case-blind), by MRR with the biggest first, or by access missing with the most first. Ties fall back to name. */
export function sortClients(rows: ClientRow[], by: ClientSort): ClientRow[] {
  const name = (a: ClientRow, b: ClientRow) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id);
  const compare: Record<ClientSort, (a: ClientRow, b: ClientRow) => number> = {
    name,
    mrr: (a, b) => b.mrrCents - a.mrrCents || name(a, b),
    access: (a, b) => b.accessMissing - a.accessMissing || name(a, b),
  };
  return [...rows].sort(compare[by]);
}

const VAULT_HINT = "Type the name of the password manager item. Never the login.";

/** One word with a dash, underscore, dot or slash in it: a slug or a token, not a name with spaces between words. */
const looksLikeSlug = (s: string): boolean => /^\S+$/.test(s) && /[-_./]/.test(s);

/** What sits under the vault field: the standing hint, or the server's own refusal (plus a nudge toward spaces when what was typed was one slug-style word). */
export function vaultHint(problem: string | null, typed = ""): string {
  if (!problem) return VAULT_HINT;
  return looksLikeSlug(typed.trim()) ? `${problem} Use spaces between words.` : problem;
}

/** The sentence to show beside a field when the server refuses a save: its own words out of a 400's `fields` (limited to `only` when given), else a 409's `error`, else `fallback`. Never the input. */
export function serverProblem(body: unknown, fallback: string, only?: string[]): string {
  if (!body || typeof body !== "object") return fallback;
  const { error, fields } = body as { error?: unknown; fields?: unknown };
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    const lines = Object.entries(fields as Record<string, unknown>)
      .filter(([k]) => !only || only.includes(k))
      .flatMap(([, v]) => (Array.isArray(v) ? v.filter((m): m is string => typeof m === "string" && m !== "") : []));
    if (lines.length) return lines.join(" ");
  }
  return typeof error === "string" && error !== "" && error !== "invalid body" ? error : fallback;
}
