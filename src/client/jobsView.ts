import type { Ats, CareerSource, JobPosting } from "./types";

const DAY = 86_400_000;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const ATS_LABEL: Record<Ats, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" };
export const atsLabel = (a: Ats | null) => (a ? ATS_LABEL[a] : "");

/** How old a role is, in words. A role found on the first look at a board has no known age unless the board dated it (same rule as the Today queue). */
export function ageLabel(p: Pick<JobPosting, "posted_at" | "first_seen_at" | "baseline">, now: Date): string {
  const days = (iso: string) => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY));
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
