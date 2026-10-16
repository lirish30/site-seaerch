import type { Ats, CareerSource, JobPosting } from "./types";

const DAY = 86_400_000;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const ATS_LABEL: Record<Ats, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" };
export const atsLabel = (a: Ats | null) => (a ? ATS_LABEL[a] : "");

/** How old a role is, in words. A role found on the first look at a board has no known age unless the board dated it (same rule as the Today queue). */
export function ageLabel(p: Pick<JobPosting, "posted_at" | "first_seen_at" | "baseline">, now: Date): string {
  const days = (iso: string) => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY));
  // A date we can't read must not print as "NaN days" or "Invalid Date".
  const ok = (iso: string) => Number.isFinite(Date.parse(iso));
  if (p.posted_at && !ok(p.posted_at)) return "Age unknown";
  if (!p.posted_at && !ok(p.first_seen_at)) return "Age unknown";
  if (p.posted_at) { const d = days(p.posted_at); return d === 0 ? "Posted today" : `Posted ${plural(d, "day")} ago`; }
  if (p.baseline) return `Age unknown (on their board since at least ${new Date(p.first_seen_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })})`;
  const d = days(p.first_seen_at);
  return d === 0 ? "First seen today" : `First seen ${plural(d, "day")} ago`;
}

/** True when the board showed the role in the last 48 hours; the 48 mirrors SEEN_WITHIN_HOURS in src/worker/db/jobs.ts. A bad date is not recent. */
export function seenRecently(p: Pick<JobPosting, "last_seen_at">, now: Date): boolean {
  const t = Date.parse(p.last_seen_at);
  return Number.isFinite(t) && now.getTime() - t <= 48 * 3_600_000;
}

export function sourceLine(s: CareerSource | null): string {
  if (!s) return "Not checked yet";
  if (s.status === "none") return "No supported job board found on their site";
  if (s.status === "error") return `Couldn't read their careers page${s.last_error ? `: ${s.last_error}` : ""}`;
  return `Watching their ${atsLabel(s.ats)} board${s.last_error ? `. Last check failed: ${s.last_error}` : ""}`;
}

export const ROLE_KIND_LABEL = { web_dev: "Web development", cro: "Conversion (CRO)", seo: "SEO", design: "Web / UX design", marketing: "Marketing & growth" } as const;
export type RoleKindKey = keyof typeof ROLE_KIND_LABEL;

/** The stored comma list as a full ranking (unknown or repeated kinds dropped, missing ones last); mirrors parseKindOrder on the server. */
export function kindOrder(csv: unknown): RoleKindKey[] {
  const all = Object.keys(ROLE_KIND_LABEL) as RoleKindKey[];
  const given = (typeof csv === "string" ? csv.split(",") : []).map((k) => k.trim()).filter((k, i, a): k is RoleKindKey => k in ROLE_KIND_LABEL && a.indexOf(k) === i);
  return [...given, ...all.filter((k) => !given.includes(k))];
}

/** Moves one entry up (-1) or down (+1); out-of-range moves change nothing. */
export function moveKind(order: RoleKindKey[], i: number, by: -1 | 1): RoleKindKey[] {
  const j = i + by, out = [...order];
  if (j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
