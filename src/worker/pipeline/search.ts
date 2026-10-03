import type { ListingSource } from "../listings/source";
import type { StepLike } from "./lead";
import type { Listing } from "../types";
import { getSearch, setFoundCount, setSearchStatus, incrementProcessed } from "../db/searches";
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

  const fetched = await step.do("fetch-listings", async () => {
    try {
      const r = await deps.source.search({
        location: search.location, businessType: search.business_type, radiusKm: search.radius_km, maxResults: search.max_results,
      });
      await recordUsage(deps.db, "brightdata", r.requests, r.requests * PRICES.brightdataPerRequest);
      return { ok: true as const, listings: r.listings };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message, listings: [] as Listing[] };
    }
  });
  if (!fetched.ok) {
    await step.do("mark-failed", () => setSearchStatus(deps.db, searchId, "failed", fetched.error).then(() => true));
    return { businessIds: [] };
  }

  const toProcess = await step.do("upsert", async () => {
    const ids: string[] = [];
    let skipped = 0;
    for (const l of fetched.listings) {
      const b = await upsertBusiness(deps.db, l, searchId);
      if (b.lead_status === "skip") skipped++; else ids.push(b.id);
    }
    await setFoundCount(deps.db, searchId, fetched.listings.length);
    for (let i = 0; i < skipped; i++) await incrementProcessed(deps.db, searchId);
    return ids;
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
}
