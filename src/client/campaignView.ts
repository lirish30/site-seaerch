import type { OffsetKind, StepKind } from "./types";

const KIND_LABEL: Record<StepKind, string> = { email: "Email", call: "Call", checkin: "Check-in" };

/** "Email · business day 5", "Call · day 7": what a step is and when it is due. */
export function stepLabel(s: { kind: StepKind; offset_days: number; offset_kind: OffsetKind }): string {
  return `${KIND_LABEL[s.kind]} · ${s.offset_kind === "business" ? "business day" : "day"} ${s.offset_days}`;
}

/** Towns typed one per line or comma separated. Blanks go, and a repeat (any capitalisation) keeps its first spelling, as the server does. */
export function parseTowns(text: string): string[] {
  const seen = new Set<string>();
  return text.split(/[\n,]/).map((t) => t.trim()).filter((t) => {
    const k = t.toLowerCase();
    return !k || seen.has(k) ? false : (seen.add(k), true);
  });
}

/** The job value field: blank is "no value", otherwise a non-negative number ($ and commas allowed). */
export function parseJobValue(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (t === "") return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false };
  return { ok: true, value: Number(t) };
}

/** The server's 400 `fields` ({ name: ["Too small"] }) as one message per field. */
export function fieldErrors(fields: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return out;
  for (const [k, v] of Object.entries(fields)) if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
  return out;
}

/** POST /api/campaigns/:id/run-searches as lines for the live region: the count, then each blocked town with its reason. */
export function runSearchesLines(r: { started: number; blocked: { town: string; reason: string }[] }): string[] {
  return [`Started ${r.started} ${r.started === 1 ? "search" : "searches"}.`, ...r.blocked.map((b) => `${b.town}: blocked. ${b.reason}`)];
}

/** The question asked before Run searches: every town starts a paid search, and a second run starts them all again. */
export const runSearchesConfirm = (townCount: number): string =>
  `This will start ${townCount} search${townCount === 1 ? "" : "es"} (one per town) and uses your lead-data budget. Continue?`;

/** How a run's result reads: "ok" when every town started, "warn" when some were blocked, "bad" when none started. */
export function runResultTone(r: { started: number; blocked: unknown[] }): "ok" | "warn" | "bad" {
  return r.blocked.length === 0 ? "ok" : r.started > 0 ? "warn" : "bad";
}

export const VIDEO_EMAIL_LABEL = "Email 1 carries the video audit (needs a published video)";

/** What switching it on means for Start: shown under the checkbox only while it is on. */
export const videoEmailHelp = (on: 0 | 1): string =>
  on === 1 ? "Email 1 shows the lead's video as a GIF that links to its report page. A lead can start only once its latest audit has a published video." : "";

/** A search as the campaigns list reads it (`GET /api/searches` rows carry the campaign that started them). */
export interface CampaignSearch { campaign_id?: string | null; location: string; found_count: number; status: "running" | "done" | "failed"; created_at: string }

/** What the list shows for a campaign from its searches: leads found, how many of its towns have been searched, whether one is running, and when it last ran. */
export function campaignStats(c: { id: string; towns: string[] }, searches: CampaignSearch[]): { leads: number; searchedTowns: number; running: boolean; lastRunAt: string | null } {
  const mine = searches.filter((s) => s.campaign_id === c.id);
  const towns = new Set(c.towns.map((t) => t.trim().toLowerCase()));
  const searched = new Set(mine.filter((s) => s.status !== "failed").map((s) => s.location.trim().toLowerCase()).filter((t) => towns.has(t)));
  return {
    leads: mine.reduce((n, s) => n + (s.found_count || 0), 0), searchedTowns: searched.size, running: mine.some((s) => s.status === "running"),
    lastRunAt: mine.map((s) => s.created_at).sort().at(-1) ?? null,
  };
}

/** "Sherwood, Tigard +3": the first towns, then how many more. */
export function townsLine(towns: string[], show = 2): string {
  return towns.length <= show ? towns.join(", ") : `${towns.slice(0, show).join(", ")} +${towns.length - show}`;
}
