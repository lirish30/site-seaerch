import { readText, type Fetcher } from "../crawler/crawl";
import { latestAudit } from "../db/audits";
import { logActivity } from "../db/activity";
import { getBusiness } from "../db/businesses";
import { applySync, closeAll, getCareerSource, saveCareerSource, type SourceWrite } from "../db/jobs";
import { importUrl } from "../import/url";
import type { CareerSource } from "../types";
import { AtsError, fetchPostings } from "./ats";
import { detectBoard } from "./detect";
import { classifyRole } from "./roles";

export interface JobDeps { db: D1Database; fetch: Fetcher; now: () => Date; userAgent: string }
export interface SyncResult { added: number; relevantAdded: number; closed: number; error: string | null }

export const CHECK_EVERY_HOURS = 12, NONE_RECHECK_DAYS = 30, RETRY_HOURS = 24, EMPTY_STREAK_TO_CLOSE = 2;
const MAX_PAGE_BYTES = 400_000;
// Never fetched: sites we must not scrape (LinkedIn, Indeed, Glassdoor...) and boards for ATSes we do not read, so a link to them can only waste a request.
const SKIPPED_HOSTS = ["indeed.com", "linkedin.com", "glassdoor.com", "ziprecruiter.com", "monster.com", "workable.com", "bamboohr.com", "jobvite.com",
  "smartrecruiters.com", "recruitee.com", "breezy.hr", "teamtailor.com", "icims.com", "myworkdayjobs.com"];
const skipped = (url: string) => { const h = new URL(url).hostname.toLowerCase(); return SKIPPED_HOSTS.some((d) => h === d || h.endsWith("." + d)); };

const later = (now: Date, hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const noResult = (error: string | null = null): SyncResult => ({ added: 0, relevantAdded: 0, closed: 0, error });

/** Reads a lead's board once and records what is on it. Never throws for a board problem: those are recorded on the source. */
export async function syncSource(deps: JobDeps, source: CareerSource): Promise<SyncResult> {
  const now = deps.now(), nowIso = now.toISOString();
  const keep: SourceWrite = { business_id: source.business_id, status: "active", ats: source.ats, token: source.token, careers_url: source.careers_url,
    checked_at: nowIso, last_ok_at: source.last_ok_at, next_check_at: later(now, CHECK_EVERY_HOURS), empty_streak: source.empty_streak, last_error: null };
  if (!source.ats || !source.token) {
    await saveCareerSource(deps.db, { ...keep, status: "none", next_check_at: later(now, NONE_RECHECK_DAYS * 24) });
    return noResult();
  }
  let raws;
  try {
    raws = await fetchPostings(source.ats, source.token, deps.fetch, deps.userAgent);
  } catch (e) {
    // A missing board is parked for a month (the careers page may have moved); anything else may be a hiccup, so retry soon and close nothing.
    const gone = e instanceof AtsError && e.kind === "not_found";
    await saveCareerSource(deps.db, { ...keep, status: gone ? "none" : "active", next_check_at: later(now, gone ? NONE_RECHECK_DAYS * 24 : RETRY_HOURS), last_error: errText(e) });
    return noResult(errText(e));
  }
  const baseline = source.last_ok_at === null; // the first successful look says nothing about how old the roles are
  if (raws.length === 0) {
    // One empty answer is as likely a board outage as a real "no openings", so closing needs a streak.
    const streak = source.empty_streak + 1;
    const closed = streak >= EMPTY_STREAK_TO_CLOSE ? await closeAll(deps.db, source.business_id, nowIso) : 0;
    await saveCareerSource(deps.db, { ...keep, last_ok_at: nowIso, empty_streak: streak });
    return { ...noResult(), closed };
  }
  const { added, closed } = await applySync(deps.db, source.business_id, raws.map((r) => ({
    external_id: r.externalId, title: r.title, url: r.url, location: r.location, department: r.department, role_kind: classifyRole(r.title), posted_at: r.postedAt,
  })), nowIso, baseline);
  await saveCareerSource(deps.db, { ...keep, last_ok_at: nowIso, empty_streak: 0 });
  const relevant = added.filter((p) => p.role_kind);
  if (!baseline && relevant.length) await logActivity(deps.db, source.business_id, "job_found", relevant.map((p) => p.title).join("; ").slice(0, 300));
  return { added: added.length, relevantAdded: relevant.length, closed, error: null };
}

/**
 * Finds the lead's board from the careers link the crawler stored on its latest audit, then does the first sync.
 * Returns null (and records nothing) for a lead that does not exist or has not been scanned, so a later tick tries again.
 */
export async function discoverSource(deps: JobDeps, businessId: string): Promise<CareerSource | null> {
  const [business, audit, existing] = await Promise.all([getBusiness(deps.db, businessId), latestAudit(deps.db, businessId), getCareerSource(deps.db, businessId)]);
  if (!business || !audit) return null;
  const now = deps.now(), nowIso = now.toISOString();
  const careers = audit.site_links.careers ?? null;
  // The link comes from the prospect's own website, so it is held to the same public-https rule as imported addresses.
  const safe = careers ? importUrl(careers) : null;
  const careersUrl = safe?.ok ? safe.url : null;
  // Parking must not forget what an earlier sync learned (board, last good look, streak), or a later rediscovery would baseline new roles.
  const park = async (status: "none" | "error", error: string | null, hours: number) => {
    await saveCareerSource(deps.db, { business_id: businessId, status, ats: existing?.ats, token: existing?.token, careers_url: careersUrl, checked_at: nowIso,
      last_ok_at: existing?.last_ok_at, next_check_at: later(now, hours), empty_streak: existing?.empty_streak, last_error: error });
    return getCareerSource(deps.db, businessId);
  };
  if (!safe?.ok || !safe.url.startsWith("https://")) return park("none", null, NONE_RECHECK_DAYS * 24);
  let ref = detectBoard(safe.url);
  if (!ref && skipped(safe.url)) return park("none", null, NONE_RECHECK_DAYS * 24);
  if (!ref) {
    try {
      const res = await deps.fetch(safe.url, { headers: { "user-agent": deps.userAgent, accept: "text/html" }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) ref = detectBoard(await readText(res, MAX_PAGE_BYTES));
      else {
        await res.body?.cancel().catch(() => {});
        // Rate limits and server errors pass; a 401/403/404/410 is the site's answer, so it is parked like "no board".
        if (res.status === 429 || res.status >= 500) return park("error", `careers page answered ${res.status}`, RETRY_HOURS);
      }
    } catch (e) {
      return park("error", errText(e), RETRY_HOURS);
    }
  }
  if (!ref) return park("none", null, NONE_RECHECK_DAYS * 24);
  // Only the same board keeps its sync state; a new board starts at zero so its first look is a baseline.
  const same = existing?.ats === ref.ats && existing?.token === ref.token;
  await saveCareerSource(deps.db, { business_id: businessId, status: "active", ats: ref.ats, token: ref.token, careers_url: careersUrl, checked_at: nowIso, next_check_at: nowIso,
    last_ok_at: same ? existing.last_ok_at : null, empty_streak: same ? existing.empty_streak : 0 });
  await syncSource(deps, (await getCareerSource(deps.db, businessId))!);
  return getCareerSource(deps.db, businessId);
}

/** The "Check now" action: re-read an active board, otherwise look for one. */
export async function checkLead(deps: JobDeps, businessId: string): Promise<CareerSource | null> {
  const existing = await getCareerSource(deps.db, businessId);
  if (existing?.status === "active") { await syncSource(deps, existing); return getCareerSource(deps.db, businessId); }
  return discoverSource(deps, businessId);
}
