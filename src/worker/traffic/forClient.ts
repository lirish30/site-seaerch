import { monthsFor } from "../db/traffic";
import { mergeTraffic, TrafficFacts } from "./facts";

/** The client's linked sites' pulled months of `period` merged into one, or null when no site gave one. A month that failed contributes nothing, and a month's error text is never read. */
export async function trafficFor(db: D1Database, businessId: string, period: string): Promise<TrafficFacts | null> {
  const parts: TrafficFacts[] = [];
  for (const m of await monthsFor(db, businessId, period)) {
    if (m.status === "failed") continue;
    const facts = TrafficFacts.safeParse(m.facts);
    if (facts.success) parts.push(facts.data);
  }
  return mergeTraffic(period, parts);
}
