import type { FitProfile, Platform, Service, SuppressionReason } from "./types";
import { groupByCategory } from "./services";
import { REASON_LABEL } from "./suppressionView";

/** "Boise" → no change; "1 service" / "34 services". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// ---------- Services you sell ----------

export const serviceBadge = (services: Service[]) => `${plural(services.length, "service")} · ${plural(services.filter((s) => s.is_specialty).length, "specialty", "specialties")}`;

/** Services shown for the search box and the "Active only" switch, grouped in catalog order. A category with no match is dropped. */
export function visibleServices(services: Service[], q: string, activeOnly: boolean) {
  const needle = q.trim().toLowerCase();
  const keep = (s: Service) => (!activeOnly || s.active) && (!needle || `${s.name} ${s.category} ${s.summary}`.toLowerCase().includes(needle));
  return groupByCategory(services).map((g) => ({ category: g.category, all: g.services, services: g.services.filter(keep) })).filter((g) => g.services.length > 0);
}

export const activeCount = (services: Service[]) => services.filter((s) => s.active).length;

// ---------- Fit profiles ----------

export const PLATFORM_LABEL: Record<Platform, string> = {
  wix: "Wix", squarespace: "Squarespace", godaddy: "GoDaddy", wordpress: "WordPress", weebly: "Weebly", shopify: "Shopify", webflow: "Webflow", other: "Other",
};
export const platformLabel = (p: string) => PLATFORM_LABEL[p as Platform] ?? p;

/** The criteria a profile defines, as label + chips, in the order the card shows them. Empty when the profile has none (scoring ignores it). */
export function criteriaRows(p: Pick<FitProfile, "industries" | "geos" | "platforms" | "min_reviews" | "min_rating">): { label: string; items: string[] }[] {
  const rows: { label: string; items: string[] }[] = [];
  if (p.industries.length) rows.push({ label: "Industries", items: p.industries });
  if (p.geos.length) rows.push({ label: "Locations", items: p.geos });
  if (p.platforms.length) rows.push({ label: "Platforms", items: p.platforms.map(platformLabel) });
  if (p.min_reviews !== null) rows.push({ label: "Reviews", items: [`${p.min_reviews.toLocaleString("en-US")} or more`] });
  if (p.min_rating !== null) rows.push({ label: "Rating", items: [`${p.min_rating}★ or higher`] });
  return rows;
}

export const fitBadge = (profiles: FitProfile[]) => `${profiles.filter((p) => p.active).length} active`;

// ---------- Suppressions ----------

export const REASON_TONE: Record<SuppressionReason, "positive" | "info" | "warning" | "critical" | "neutral"> = {
  client: "positive", active_deal: "info", competitor: "warning", opt_out: "critical", other: "neutral",
};
export { REASON_LABEL };

/** "Sep 3" for a stored UTC timestamp. */
export const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/** A Google place id is long and opaque; show its ends. */
export const shortPlaceId = (id: string) => (id.length > 14 ? `${id.slice(0, 7)}…${id.slice(-4)}` : id);

export function suppressionBadge(rows: { kind: string }[]) {
  const domains = rows.filter((r) => r.kind === "domain").length, listings = rows.length - domains;
  return [plural(domains, "domain"), ...(listings ? [plural(listings, "listing")] : [])].join(" · ");
}

// ---------- Usage & limits ----------

export const USAGE_SERVICES: { key: string; label: string; always: boolean }[] = [
  { key: "brightdata", label: "Google Maps listings (Bright Data)", always: true },
  { key: "places", label: "Google Maps listings (Places API)", always: false },
  { key: "claude", label: "AI reviews & drafts (Claude)", always: true },
  { key: "claude_cro", label: "Conversion plan audits (Claude)", always: false },
  { key: "browser", label: "Browser checks", always: true },
  { key: "pagespeed", label: "Google PageSpeed", always: true },
];

/** One row per paid service, in a fixed order, with its month-to-date calls and estimated cost. Services we don't know are listed last. */
export function usageRows(usage: { service: string; units: number; est_cost_usd: number }[]) {
  const by = new Map(usage.map((u) => [u.service, u]));
  const known = USAGE_SERVICES.filter((s) => s.always || by.has(s.key)).map((s) => ({ service: s.key, label: s.label, calls: by.get(s.key)?.units ?? 0, cost: by.get(s.key)?.est_cost_usd ?? 0 }));
  const extra = usage.filter((u) => !USAGE_SERVICES.some((s) => s.key === u.service)).map((u) => ({ service: u.service, label: u.service, calls: u.units, cost: u.est_cost_usd }));
  return [...known, ...extra];
}
export const usageTotal = (rows: { calls: number; cost: number }[]) => ({ calls: rows.reduce((s, r) => s + r.calls, 0), cost: rows.reduce((s, r) => s + r.cost, 0) });

export const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Share of the limit already spent, as a whole percent (not capped, so an overrun reads as over 100%). A $0 limit with spend is 100%. */
export function spendPercent(spent: number, limit: number): number {
  if (limit <= 0) return spent > 0 ? 100 : 0;
  return Math.round((spent / limit) * 100);
}

export const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
export const monthAbbr = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

/** The tallest bar is `maxPx`; a month with spend never rounds to nothing, a month without gets a 2px stub so the baseline reads. */
export function chartBars(months: { month: string; est_cost_usd: number }[], maxPx = 101) {
  const max = Math.max(...months.map((m) => m.est_cost_usd), 0);
  return months.map((m) => ({
    month: m.month, label: monthAbbr(m.month), value: `$${Math.round(m.est_cost_usd).toLocaleString("en-US")}`,
    height: max > 0 && m.est_cost_usd > 0 ? Math.max(4, Math.round((m.est_cost_usd / max) * maxPx)) : 2,
  }));
}

// ---------- Google ----------

/** "Sep 1" for a stored timestamp, with the year when it isn't this one. */
export function sinceLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getUTCFullYear() !== now.getUTCFullYear() ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** The two Google permissions the app asks for (see SCOPES in src/worker/google/oauth.ts), in the words a person would use. */
export const PERMISSIONS: { icon: "mail" | "upload"; title: string; text: string; scope: string }[] = [
  { icon: "mail", title: "Create Gmail drafts", text: "Drafts land in your Drafts folder for you to review and send.", scope: "gmail.compose" },
  { icon: "upload", title: "Save reports to Drive", text: "PDFs and Docs go into a “Site Search reports” folder it creates.", scope: "drive.file" },
];

// ---------- Mailing footer ----------

/** What sits under an email when the footer is on: the same two lines the composer adds (blank ones are left out). */
export const footerLines = (address: string, optOut: string) => [address, optOut].map((l) => l.trim()).filter(Boolean);

/** The signature line of the preview: "Name · Role", whichever parts exist. */
export const signatureLine = (name: string, role: string) => [name, role].map((p) => p.trim()).filter(Boolean).join(" · ");
