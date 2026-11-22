import type { TrafficFacts } from "./facts";
import { hasTrafficData } from "./facts";

/** What Google counted, as a client's report page shows it (Care's and Local SEO's). A block is left out when it was not measured; queries and page paths are plain strings (the page puts them in as text). Key events and channels never appear. */
export interface PublicTraffic {
  search?: {
    clicks: number; impressions: number; position: number | null; previousClicks: number | null; previousImpressions: number | null;
    queries: { query: string; clicks: number; impressions: number }[];
    pages: { path: string; clicks: number }[];
  };
  visits?: { sessions: number; users: number; organic: number; previousSessions: number | null; previousOrganic: number | null };
  /** Google Business Profile, only for a site whose owner linked a location: what people did on the listing. */
  profile?: { calls: number; directions: number; websiteClicks: number; previousCalls: number | null };
}

/** The traffic block of a page, field by field, or undefined when the report has no search, visits or profile block. */
export function publicTraffic(t: TrafficFacts | null | undefined): PublicTraffic | undefined {
  if (!hasTrafficData(t)) return undefined;
  const out: PublicTraffic = {};
  if (t.search) {
    const s = t.search;
    out.search = {
      clicks: s.clicks, impressions: s.impressions, position: s.position, previousClicks: s.previousClicks, previousImpressions: s.previousImpressions,
      queries: s.queries.map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions })), pages: s.pages.map((p) => ({ path: p.path, clicks: p.clicks })),
    };
  }
  if (t.visits) {
    const v = t.visits;
    out.visits = { sessions: v.sessions, users: v.users, organic: v.organic, previousSessions: v.previousSessions, previousOrganic: v.previousOrganic };
  }
  if (t.profile) {
    const p = t.profile;
    out.profile = { calls: p.calls, directions: p.directions, websiteClicks: p.websiteClicks, previousCalls: p.previousCalls };
  }
  return out;
}
