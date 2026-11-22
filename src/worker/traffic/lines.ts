import type { TrafficFacts } from "./facts";

const whole = (n: number) => n.toLocaleString("en-US");
const times = (n: number) => `${whole(n)} ${n === 1 ? "time" : "times"}`;
/** `1,200 (last month 900)`, or only the figure when last month's is not known. */
const beside = (text: string, previous: number | null) => (previous === null ? text : `${text} (last month ${whole(previous)})`);

/**
 * Google's numbers as plain lines for Claude's untrusted block: counts and last-month comparisons only. The search queries and page paths are written by strangers and the channel names come from Google's
 * own list: none of them is listed (the page shows the queries and paths). `position` is worded by the caller, so Local SEO can keep it apart from its own rank check. The Business Profile counts (calls, direction requests, website clicks) are one more line, only when that was measured. No lines when none of the three was measured.
 */
export function trafficLines(t: TrafficFacts, o: { position?: string } = {}): string[] {
  const lines = ["Search and visits (counted by Google):"];
  if (t.search) {
    const s = t.search;
    lines.push(`Search results: shown ${beside(times(s.impressions), s.previousImpressions)}; clicked ${beside(times(s.clicks), s.previousClicks)}${s.position === null ? "" : `; ${o.position ?? "average position"} ${s.position}`}`);
  }
  if (t.visits) {
    const v = t.visits;
    lines.push(`Visits: ${beside(`${whole(v.sessions)} ${v.sessions === 1 ? "visit" : "visits"}`, v.previousSessions)} from ${whole(v.users)} ${v.users === 1 ? "person" : "people"}; ${beside(`${whole(v.organic)} from search`, v.previousOrganic)}`);
  }
  if (t.profile) {
    const p = t.profile;
    lines.push(`Google Business Profile: people tapped to call ${beside(times(p.calls), p.previousCalls)}; asked for directions ${times(p.directions)}; clicked through to the website ${times(p.websiteClicks)}`);
  }
  return lines.length > 1 ? lines : [];
}
