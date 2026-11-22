import { dayKey } from "../booking/slots";
import { countMemoView, getMemoByToken } from "../db/strategy";
import { getSettings } from "../db/settings";
import { isClientToken } from "../documents/token";
import type { Env } from "../env";
import { StrategyMemoResult } from "../queue/strategyMemo";
import { zoneOf } from "../sop/cadence";
import type { PublicTraffic } from "../traffic/public";
import { MemoFacts } from "./facts";

// What a client sees at `/y/<token>` (Plan 16): their strategy memo, field by field. Nothing is spread from the stored facts and nothing is added to them here, so a field that is not listed in `PublicMemo`
// can never reach a client: no id, no approval or task id, no raw facts, no trade, towns or keywords, no Google Business Profile figures, no search query or page path, no token.

/** Claude's words, as they were checked when they were stored. */
export type MemoBody = StrategyMemoResult;

export interface PublicMemo {
  clientName: string;
  version: number;
  /** The day the memo was sent, `YYYY-MM-DD` in the booking zone. */
  sentAt: string;
  body: MemoBody;
  /** What Google counted in `period` (`YYYY-MM`, Google's own month), or null when the memo has no search or visits figures. A block that was not measured is absent, never 0. The query and page lists are always empty. */
  traffic: ({ period: string } & PublicTraffic) | null;
}

/**
 * The memo behind a link, or null. Null is one answer for a malformed token (never looked up), an unknown one, and every memo that is not `sent` (collecting, ready, revoked, cancelled), so the caller cannot
 * tell them apart; a memo whose facts or words cannot be read is not shown either. A view is counted only when the page can be shown, and not when `o.countView` is false (the owner opening the link themselves).
 */
export async function publicMemo(env: Pick<Env, "DB">, token: string, now: Date, o: { countView?: boolean } = {}): Promise<PublicMemo | null> {
  if (!isClientToken(token)) return null;
  const memo = await getMemoByToken(env.DB, token);
  if (!memo || memo.status !== "sent") return null;
  const facts = MemoFacts.safeParse(memo.facts);
  const body = StrategyMemoResult.safeParse(memo.body);
  if (!facts.success || !body.success) return null;
  const f = facts.data;

  const tz = zoneOf(await getSettings(env.DB));
  const s = f.search;
  const v = f.visits;
  const traffic: PublicMemo["traffic"] = f.period && (s || v)
    ? {
      period: f.period,
      ...(s ? { search: { clicks: s.clicks, impressions: s.impressions, position: s.position, previousClicks: s.previousClicks, previousImpressions: s.previousImpressions, queries: [], pages: [] } } : {}),
      ...(v ? { visits: { sessions: v.sessions, users: v.users, organic: v.organic, previousSessions: v.previousSessions, previousOrganic: v.previousOrganic } } : {}),
    }
    : null;
  if (o.countView !== false) await countMemoView(env.DB, memo.id, now.toISOString());

  return {
    clientName: f.clientName,
    version: memo.version,
    sentAt: dayKey(Date.parse(memo.sentAt ?? "") || now.getTime(), tz),
    // Zod parsing keeps only the schema's own keys, so nothing else stored in the body can reach the page.
    body: body.data,
    traffic,
  };
}
