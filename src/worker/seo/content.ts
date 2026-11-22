// A client's monthly local SEO content (Plan 14): the pages, posts and Google Business Profile posts the plan includes, one slot each, and Claude's draft queued for every slot.
// Nothing here publishes anywhere: a draft is words for Logan to edit, approve and put on the client's site or profile himself.
import { LIVE } from "../clients/record";
import { insertContentSlots, listContent, listKeywords, type ContentItem, type ContentKind } from "../db/seo";
import type { Env } from "../env";
import { queueContentDraft } from "../queue/seoContent";

export { SEO_CONTENT_KIND } from "../queue/seoContent";

export type SeoPlanKey = "local_seo" | "local_seo_growth";
export interface SeoPlan { content: number; gbpPosts: number }

/** What each Local SEO plan includes every month: pages and answer-style posts (alternating, a page first) and Google Business Profile posts. */
export const SEO_PLAN: Record<SeoPlanKey, SeoPlan> = { local_seo: { content: 2, gbpPosts: 1 }, local_seo_growth: { content: 4, gbpPosts: 2 } };

const PLAN_KEYS = Object.keys(SEO_PLAN) as SeoPlanKey[];
const marks = (xs: readonly string[]) => xs.map(() => "?").join(",");

/**
 * What the client's live (billing or late) real Local SEO plan includes each month, or null when it has none. With both plans live, Growth counts.
 * The same way `editLedger` finds a Care plan: from the client's subscriptions.
 */
export async function planFor(db: D1Database, businessId: string): Promise<SeoPlan | null> {
  const rows = (await db.prepare(
    `SELECT package_key FROM subscriptions WHERE business_id = ? AND test = 0 AND status IN (${marks(LIVE)}) AND package_key IN (${marks(PLAN_KEYS)})`,
  ).bind(businessId, ...LIVE, ...PLAN_KEYS).all<{ package_key: SeoPlanKey }>()).results;
  if (!rows.length) return null;
  return SEO_PLAN[rows.some((r) => r.package_key === "local_seo_growth") ? "local_seo_growth" : "local_seo"];
}

const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/** The slots a plan has, in the order they take their keywords: the content slots (a page, a post, a page, ...) and then the Google posts. `slot` counts from 1 within its kind. */
function specs(plan: SeoPlan): { kind: ContentKind; slot: number }[] {
  const out: { kind: ContentKind; slot: number }[] = [];
  for (let i = 0; i < plan.content; i++) out.push({ kind: i % 2 === 0 ? "page" : "post", slot: Math.floor(i / 2) + 1 });
  for (let i = 0; i < plan.gbpPosts; i++) out.push({ kind: "gbp_post", slot: i + 1 });
  return out;
}

function briefFor(kind: ContentKind, term: string, town: string): string {
  if (kind === "page") return `service or location page about "${term}"${town ? ` in ${town}` : ""}`;
  if (kind === "post") return `answer-style post about "${term}"`;
  return `Google Business Profile post about "${term}"`;
}

/**
 * Plans the month's content for the client (`period` is `YYYY-MM`) and queues Claude's draft of each slot, which then goes `drafting`. Every new slot takes the active keyword that has the fewest
 * pieces so far, over every month of the client's content (a piece that is already there counts, a rejected one does not), ties by keyword order. Safe to run again: a slot that is there is left as it is, and one that is still `planned` with no task
 * gets its draft queued, so a crash half way through is finished by the next call. A client with no live plan, or with no active keyword, gets no new slots. Returns the period's rows.
 */
export async function ensureSlots(env: Env, businessId: string, period: string, now: Date): Promise<ContentItem[]> {
  if (!PERIOD.test(period)) throw new RangeError("a period is a month written YYYY-MM");
  const plan = await planFor(env.DB, businessId);
  if (!plan) return [];
  const keywords = await listKeywords(env.DB, businessId, { activeOnly: true });
  const all = await listContent(env.DB, { businessId });
  const there = all.filter((i) => i.period === period);

  // Coverage is counted over every month, so a keyword that was left out this month is first in line the next. A rejected piece never covered its keyword.
  const counts = new Map<string, number>();
  for (const i of all) if (i.keywordId && i.status !== "rejected") counts.set(i.keywordId, (counts.get(i.keywordId) ?? 0) + 1);

  for (const { kind, slot } of specs(plan)) {
    if (there.some((i) => i.kind === kind && i.slot === slot) || !keywords.length) continue;
    // `reduce` keeps the first of equals, which is the first in keyword order.
    const keyword = keywords.reduce((best, k) => ((counts.get(k.id) ?? 0) < (counts.get(best.id) ?? 0) ? k : best));
    counts.set(keyword.id, (counts.get(keyword.id) ?? 0) + 1);
    await insertContentSlots(env.DB, [{
      businessId, period, kind, slot, keywordId: keyword.id, brief: briefFor(kind, keyword.term, keyword.town), title: "", metaTitle: "", metaDescription: "", body: "",
      status: "planned", claudeTaskId: null, url: null,
    }], now.toISOString());
  }

  for (const i of await listContent(env.DB, { businessId, period })) {
    if (i.status === "planned" && i.claudeTaskId === null) await queueContentDraft(env, i, now);
  }
  return listContent(env.DB, { businessId, period });
}
