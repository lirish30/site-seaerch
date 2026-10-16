import { TYPE_GROUPS } from "./businessTypes";
import { estimateNewSearchSeconds } from "./eta";

export const RESULT_PRESETS = [25, 50, 100, 200];
export const MAX_RESULTS = 200;
/** inFlightUsd: estimated cost of searches still running, already counted in `ok` by the server. quickUsd: the same search as a quick scan. */
export type Estimate = { estUsd: number; quickUsd?: number; inFlightUsd?: number; spent: number; limit: number; ok: boolean };

export const TYPE_TOTAL = TYPE_GROUPS.reduce((n, g) => n + g.types.length, 0);
/** The sidebar group that holds the types the user added themselves. */
export const CUSTOM_GROUP = "Custom";

export const money = (n: number) => `$${n.toFixed(2)}`;
/** A whole-dollar limit reads "$150"; anything else keeps its cents. */
const limitText = (n: number) => (Number.isInteger(n) ? `$${n}` : money(n));

/** What the "Custom" box holds: a whole number of results from 1 to 200, or null while it is blank or not a number. */
export function parseCustomResults(raw: string): number | null {
  const n = Math.floor(Number(raw.trim()));
  return raw.trim() !== "" && Number.isFinite(n) && n >= 1 ? Math.min(MAX_RESULTS, n) : null;
}

/** "$0.05" a lead, or "under $0.01" when the per-lead cost rounds to nothing (a quick scan only pays for the Maps listing). */
export function perLeadText(totalUsd: number, maxResults: number): string {
  const each = totalUsd / maxResults;
  return each < 0.005 ? "under $0.01" : money(each);
}

/** "Takes about 12 minutes": searches for several types run side by side, so the time is one search's. */
export function etaText(count: number, maxResults: number): string {
  if (count === 0) return "Pick a business type to see the time";
  const s = estimateNewSearchSeconds(maxResults);
  if (s < 60) return "Takes under a minute";
  const m = Math.round(s / 60);
  return `Takes about ${m} minute${m === 1 ? "" : "s"}`;
}

export interface SummaryInput { location: string; count: number; maxResults: number; quickScan: boolean; repeat: boolean; every: number }
/** The five rows of the Summary card, in Figma order. */
export function summaryRows(f: SummaryInput): { key: "location" | "types" | "businesses" | "scan" | "repeats"; label: string; value: string }[] {
  return [
    { key: "location", label: "Location", value: f.location.trim() || "Not set" },
    { key: "types", label: "Business types", value: f.count === 0 ? "None yet" : `${f.count} type${f.count === 1 ? "" : "s"}` },
    { key: "businesses", label: "Businesses", value: f.count === 0 ? "None yet" : `Up to ${f.count * f.maxResults}` },
    { key: "scan", label: "Scan", value: f.quickScan ? "Quick scan first" : "Full scan" },
    { key: "repeats", label: "Repeats", value: f.repeat ? `Every ${f.every} days` : "Off" },
  ];
}

/** This month's spend bar: the ink part is spent, the Signal part is searches still running, and the note says whether this search fits. */
export function meterView(est: Estimate, totalUsd: number, count: number) {
  const inFlight = est.inFlightUsd ?? 0;
  const over = est.spent + inFlight + totalUsd > est.limit;
  const pct = (n: number) => (est.limit > 0 ? Math.max(0, Math.min(100, (n / est.limit) * 100)) : 0);
  const spentPct = pct(est.spent);
  const flightPct = Math.min(pct(inFlight), 100 - spentPct);
  const parts = [
    inFlight > 0 ? `+ ${money(inFlight)} in searches still running` : "",
    count === 0 ? "" : over ? "this search would go over your limit" : "this search fits",
  ].filter(Boolean);
  return { label: `${money(est.spent)} of ${limitText(est.limit)}`, spentPct, flightPct, over, note: parts.join(" · ") };
}

/** Types that match the filter, group by group; the user's own types sit in a "Custom" group at the end. Empty groups drop out. */
export function visibleGroups(custom: string[], filter: string) {
  const q = filter.trim().toLowerCase();
  const groups = TYPE_GROUPS.map((g) => ({ name: g.name, types: q ? g.types.filter((t) => t.toLowerCase().includes(q)) : g.types }));
  const mine = q ? custom.filter((t) => t.toLowerCase().includes(q)) : custom;
  if (mine.length) groups.push({ name: CUSTOM_GROUP, types: mine });
  return groups.filter((g) => g.types.length > 0);
}

/** The group whose types are showing: the one picked if it still has matches, otherwise the first that does. */
export const activeGroup = <G extends { name: string }>(groups: G[], picked: string): G | undefined => groups.find((g) => g.name === picked) ?? groups[0];

/** The sentence under the form after some (or all) of a batch of searches could not start. */
export function startFailureText(failed: string[], limitHit: boolean): string {
  return failed.length ? `Couldn't start: ${failed.join(", ")}.${limitHit ? " This would go over your monthly spend limit." : ""}` : "";
}

export const startedText = (n: number) => `Started ${n} search${n === 1 ? "" : "es"}. They're listed under Recent in the sidebar.`;
