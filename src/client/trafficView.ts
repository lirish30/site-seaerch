import type { PublicTraffic } from "../worker/traffic/public";

/** The "Search and visits" section of a client's report page (Care's and Local SEO's). Plain values in, plain text out: no DOM, no fetch, no clock. */

const whole = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A figure, and last month's beside it when there is one: "40 (last month 30)". */
const beside = (n: number, previous: number | null) => (previous === null ? whole(n) : `${whole(n)} (last month ${whole(previous)})`);

export interface TrafficView {
  /** Null when search was not measured: the block is left out, never shown as 0. */
  search: { rows: { label: string; value: string }[]; empty: string | null; queries: { text: string; value: string }[]; pages: { text: string; value: string }[] } | null;
  visits: { rows: { label: string; value: string }[] } | null;
  /** Null when no Business Profile location was linked or it could not be read: the block is left out. A real zero is shown as 0. */
  profile: { rows: { label: string; value: string }[] } | null;
  note: string;
}

/**
 * The "Search and visits" section: null (no section) unless a search, a visits or a Business Profile block was measured. Queries and paths are returned as they are, for the page to put in as text. `positionLabel` names Search
 * Console's average position (Local SEO words it so it is never taken for its own rank check).
 */
export function trafficView(t: PublicTraffic | undefined, o: { positionLabel?: string } = {}): TrafficView | null {
  if (!t || (!t.search && !t.visits && !t.profile)) return null;
  const clicks = (n: number) => plural(n, "click", "clicks");
  let search: TrafficView["search"] = null;
  if (t.search) {
    const s = t.search;
    // Google counted the month and the site was never shown: a real zero, said in words (the rows would only repeat it).
    if (s.clicks === 0 && s.impressions === 0) search = { rows: [], empty: "No search impressions were recorded.", queries: [], pages: [] };
    else {
      const rows = [{ label: "Shown in Google", value: beside(s.impressions, s.previousImpressions) }, { label: "Clicked", value: beside(s.clicks, s.previousClicks) }];
      if (s.position !== null) rows.push({ label: o.positionLabel ?? "Average position", value: String(s.position) });
      search = { rows, empty: null, queries: s.queries.map((q) => ({ text: q.query, value: clicks(q.clicks) })), pages: s.pages.map((p) => ({ text: p.path, value: clicks(p.clicks) })) };
    }
  }
  const visits = t.visits ? { rows: [
    { label: "Visits", value: beside(t.visits.sessions, t.visits.previousSessions) },
    { label: "People", value: whole(t.visits.users) },
    { label: "Visits from search", value: beside(t.visits.organic, t.visits.previousOrganic) },
  ] } : null;
  const profile = t.profile ? { rows: [
    { label: "People tapped to call", value: beside(t.profile.calls, t.profile.previousCalls) },
    { label: "Directions requested", value: whole(t.profile.directions) },
    { label: "Website clicks from your profile", value: whole(t.profile.websiteClicks) },
  ] } : null;
  return { search, visits, profile, note: "Counted by Google's own month." };
}
