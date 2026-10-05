import { isRetryable, type ListingSource } from "../listings/source";
import type { StepLike } from "./lead";
import type { Business, Listing, ScanStage } from "../types";
import { getSearch, setFoundCount, setSearchStatus, setProcessedCount } from "../db/searches";
import { upsertBusiness } from "../db/businesses";
import { isSuppressed } from "../db/suppression";
import { latestDraft } from "../db/drafts";
import { latestAudit } from "../db/audits";
import { recordUsage } from "../db/usage";
import { PRICES } from "../cost";

export const LEAD_BATCH_SIZE = 5;
export const LEAD_BATCH_DELAY_MS = 20_000;

export interface SearchDeps {
  db: D1Database; source: ListingSource; startLead: (p: { businessId: string; searchId: string; stage: ScanStage }) => Promise<void>;
}

// Only (re)work leads nobody has acted on: brand new ones, or reviewed ones whose latest draft
// hasn't been hand-edited. Skipped/contacted/replied/won/lost leads are never re-crawled or re-drafted.
// A new-only (Radar) search narrows that further: only businesses with no audit row at all, so a lead the owner
// already has an audit and draft for is never re-paid. Any audit row counts, even a partial or unreachable one.
// The exception is a lead whose last run FAILED (last_error is set when a lead workflow gives up, e.g. the draft step
// after the audit was saved, and cleared when the next run starts): it never completed, so it is worth retrying.
async function shouldStartLead(db: D1Database, b: Business, newOnly: boolean): Promise<boolean> {
  const open = b.lead_status === "new" || (b.lead_status === "reviewed" && !(await latestDraft(db, b.id))?.edited);
  return open && (!newOnly || !!b.last_error || !(await latestAudit(db, b.id)));
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
        // Transient (429/5xx): rethrow so Workflows retries the step; once retries are exhausted the
        // outer catch marks the search failed. Permanent (4xx) errors fail the search right away.
        if (isRetryable(e)) throw e;
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
      const notStarted = new Set<string>(); // linked to this search, but already decided/worked on
      // Matches the suppression list (clients, opt-outs, competitors): never stored or started, but counted below as found
      // and processed so the search's progress still reaches done. Keyed so a repeated listing counts once.
      const suppressed = new Set<string>();
      for (const l of fetched.listings) {
        // A known business may have a domain the listing lacks (e.g. it came back without a website this time).
        const known = l.placeId ? await deps.db.prepare(`SELECT domain FROM businesses WHERE place_id = ?`).bind(l.placeId).first<{ domain: string | null }>() : null;
        const hit = await isSuppressed(deps.db, { placeId: l.placeId, domain: known?.domain, websiteUrl: l.websiteUrl });
        if (hit) { suppressed.add(l.placeId ? `p:${l.placeId}` : `d:${hit.value}`); continue; }
        const b = await upsertBusiness(deps.db, l, searchId);
        if (ids.has(b.id) || notStarted.has(b.id)) continue;
        if (await shouldStartLead(deps.db, b, search.new_only === 1)) ids.add(b.id); else notStarted.add(b.id);
      }
      await setFoundCount(deps.db, searchId, ids.size + notStarted.size + suppressed.size);
      // Absolute set (no leads started yet) so a step retry cannot double-count.
      await setProcessedCount(deps.db, searchId, notStarted.size + suppressed.size);
      return [...ids];
    });

    const stage: ScanStage = search.quick_scan === 1 ? "quick" : "full";
    for (let i = 0; i < toProcess.length; i += LEAD_BATCH_SIZE) {
      if (i > 0) await step.sleep(`batch-gap-${i}`, LEAD_BATCH_DELAY_MS);
      const batch = toProcess.slice(i, i + LEAD_BATCH_SIZE);
      await step.do(`start-batch-${i}`, async () => {
        for (const businessId of batch) await deps.startLead({ businessId, searchId, stage });
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
