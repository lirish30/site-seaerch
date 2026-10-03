import type { ListingSource } from "../listings/source";
import type { StepLike } from "./lead";
import type { Listing } from "../types";
import { getSearch, setFoundCount, setSearchStatus, setProcessedCount } from "../db/searches";
import { upsertBusiness } from "../db/businesses";
import { recordUsage } from "../db/usage";
import { PRICES } from "../cost";

export const LEAD_BATCH_SIZE = 5;
export const LEAD_BATCH_DELAY_MS = 20_000;

export interface SearchDeps {
  db: D1Database; source: ListingSource; startLead: (p: { businessId: string; searchId: string }) => Promise<void>;
}

export async function runSearch(deps: SearchDeps, step: StepLike, searchId: string) {
  const search = await getSearch(deps.db, searchId);
  if (!search) throw new Error(`Search ${searchId} not found`);

  try {
    const fetched = await step.do("fetch-listings", async () => {
      try {
        const r = await deps.source.search({
          location: search.location, businessType: search.business_type, radiusKm: search.radius_km, maxResults: search.max_results,
        });
        return { ok: true as const, listings: r.listings, requests: r.requests };
      } catch (e) {
        return { ok: false as const, error: (e as Error).message, listings: [] as Listing[], requests: 0 };
      }
    });
    if (!fetched.ok) {
      await step.do("mark-failed", () => setSearchStatus(deps.db, searchId, "failed", fetched.error).then(() => true));
      return { businessIds: [] as string[] };
    }

    await step.do("record-usage", () =>
      recordUsage(deps.db, "brightdata", fetched.requests, fetched.requests * PRICES.brightdataPerRequest).then(() => true));

    const toProcess = await step.do("upsert", async () => {
      const ids = new Set<string>();
      const skipped = new Set<string>();
      for (const l of fetched.listings) {
        const b = await upsertBusiness(deps.db, l, searchId);
        if (b.lead_status === "skip") skipped.add(b.id); else ids.add(b.id);
      }
      await setFoundCount(deps.db, searchId, ids.size + skipped.size);
      // Absolute set (no leads started yet) so a step retry cannot double-count.
      await setProcessedCount(deps.db, searchId, skipped.size);
      return [...ids];
    });

    for (let i = 0; i < toProcess.length; i += LEAD_BATCH_SIZE) {
      if (i > 0) await step.sleep(`batch-gap-${i}`, LEAD_BATCH_DELAY_MS);
      const batch = toProcess.slice(i, i + LEAD_BATCH_SIZE);
      await step.do(`start-batch-${i}`, async () => {
        for (const businessId of batch) await deps.startLead({ businessId, searchId });
        return true;
      });
    }

    await step.do("mark-done", () => setSearchStatus(deps.db, searchId, "done").then(() => true));
    return { businessIds: toProcess };
  } catch (e) {
    const message = String((e as any)?.message ?? e).slice(0, 500);
    await step.do("mark-failed-unexpected", () => setSearchStatus(deps.db, searchId, "failed", message).then(() => true));
    return { businessIds: [] as string[] };
  }
}
