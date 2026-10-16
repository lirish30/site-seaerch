import { defaultFilters, defaultTableFilters, filterLeadRows, isDraftReady, OFFERS, type TableFilters } from "./leadFilters";
import { STATUSES, type LeadRow, type LeadStatus } from "./types";

/** The leads page's filter state. `status`, `archived`, `tag` and `starred` are fetched server-side; `drafts` and `table` filter what was loaded. */
export interface LeadView { status: LeadStatus | ""; archived: boolean; tag: string; starred: boolean; drafts: boolean; table: TableFilters }
export const defaultView: LeadView = { status: "", archived: false, tag: "", starred: false, drafts: false, table: defaultTableFilters };

const clampNum = (v: string | null, min: number, max: number): number | null => {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};

/** URL-search-params text holding only what differs from the defaults, so an unfiltered page serializes to "". */
export function serializeView(v: LeadView): string {
  const p = new URLSearchParams(), d = defaultFilters, f = v.table.f;
  if (v.status) p.set("status", v.status);
  if (v.archived) p.set("archived", "1");
  if (v.starred) p.set("starred", "1");
  if (v.drafts) p.set("drafts", "1");
  if (v.tag.trim()) p.set("tag", v.tag.trim().toLowerCase());
  if (v.table.q.trim()) p.set("q", v.table.q.trim());
  if (v.table.niche) p.set("niche", v.table.niche);
  if (f.offer !== d.offer) p.set("offer", f.offer);
  if (f.platform !== d.platform) p.set("platform", f.platform);
  if (f.hideSkipped !== d.hideSkipped) p.set("hideSkipped", f.hideSkipped ? "1" : "0");
  if (f.emailOnly) p.set("emailOnly", "1");
  if (f.minScore > 0) p.set("minScore", String(f.minScore));
  if (f.minReviews !== null && f.minReviews > 0) p.set("minReviews", String(f.minReviews));
  if (f.maxRating !== null) p.set("maxRating", String(f.maxRating));
  return p.toString();
}

/** Reads text written by `serializeView`. A saved value that no longer makes sense falls back to its default rather than failing. */
export function parseView(query: string): LeadView {
  const p = new URLSearchParams(query);
  const status = p.get("status") as LeadStatus | null, offer = p.get("offer");
  return {
    status: status && STATUSES.includes(status) ? status : "",
    archived: p.get("archived") === "1",
    starred: p.get("starred") === "1",
    drafts: p.get("drafts") === "1",
    tag: (p.get("tag") ?? "").slice(0, 32),
    table: {
      q: (p.get("q") ?? "").slice(0, 200),
      niche: (p.get("niche") ?? "").slice(0, 60),
      f: {
        hideSkipped: p.get("hideSkipped") === "0" ? false : defaultFilters.hideSkipped,
        emailOnly: p.get("emailOnly") === "1",
        minScore: clampNum(p.get("minScore"), 0, 100) ?? defaultFilters.minScore,
        minReviews: clampNum(p.get("minReviews"), 0, Number.MAX_SAFE_INTEGER),
        maxRating: clampNum(p.get("maxRating"), 0, 5),
        offer: offer && (OFFERS as readonly string[]).includes(offer) ? (offer as TableFilters["f"]["offer"]) : defaultFilters.offer,
        platform: (p.get("platform") ?? "").slice(0, 40) || defaultFilters.platform,
      },
    },
  };
}

/** The rows a view shows, worked out from every loaded lead (used for the sidebar's counts; the page itself asks the server for status, tag, starred and archived). */
export function viewRows(rows: LeadRow[], v: LeadView): LeadRow[] {
  const tag = v.tag.trim().toLowerCase();
  const scoped = rows.filter((r) => (!v.status || r.business.lead_status === v.status)
    && (!v.starred || r.business.starred_at !== null) && (!tag || r.business.tags.includes(tag)) && (!v.drafts || isDraftReady(r)));
  return filterLeadRows(scoped, v.table);
}
