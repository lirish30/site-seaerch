import type { BizModelKey, BusinessModel, CroAudit, CroItem, CroStep, EvidenceFamily, Horizon, RecMode, ScenarioInputs } from "../worker/cro/types";

export type { BizModelKey, BusinessModel, CroAudit, CroItem, Evidence, Horizon, ScenarioInputs } from "../worker/cro/types";
export { BIZ_MODEL_KEYS } from "../worker/cro/types";
export { BIZ_MODELS } from "../worker/cro/models";
export { scenarioRange, SCENARIO_LABEL } from "../worker/cro/scenario";
export { cropView, itemCrop } from "../worker/cro/crop";

export interface CroResponse { audit: CroAudit | null; items: CroItem[] }
export interface CroHistoryRow { id: string; status: string; created_at: string; completed_at: string | null; item_count: number }

export const MODE_LABEL: Record<RecMode, string> = { fix: "Just fix", fix_measure: "Fix & measure", test: "Test", strategic: "Strategic" };
export const STEP_LABEL: [CroStep, string][] = [
  ["capture", "Capturing key pages on desktop and phone"], ["evidence", "Collecting evidence"],
  ["model", "Working out how the business makes money"], ["pages", "Reviewing each page"], ["synthesize", "Writing the roadmap"],
];
export const stepIndex = (s: CroStep) => (s === "done" ? STEP_LABEL.length : STEP_LABEL.findIndex(([k]) => k === s));
export const effectiveModel = (a: Pick<CroAudit, "business_model" | "model_overrides">): BusinessModel | null =>
  a.business_model ? { ...a.business_model, ...a.model_overrides } : null;
export const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Plain-English names for the kinds of evidence, so no internal jargon reaches the screen. */
export const EVIDENCE_FAMILY_LABEL: Record<EvidenceFamily, string> = {
  cta: "Buttons and links", nav: "Navigation", contact: "Contact options", form: "Forms", flow: "Click-through",
  trust: "Trust signals", copy: "Wording", martech: "Tracking tools", listing: "Google listing", health: "Site health",
};

// ---------- "Do this month" vs the 30/60/90 roadmap (mirrors the deck's rule in src/worker/report/cro.ts) ----------

const TOP_ITEMS = 5;
export interface RoadmapSplit { month: CroItem[]; columns: Record<Horizon, CroItem[]>; hidden: CroItem[] }

/** "Do this month" is the first five included 30-day items by rank; the rest of the included items go in the horizon columns.
 *  Items the user hid stay out of both (they're also left out of the deck and the emails). */
export function splitRoadmap(items: CroItem[]): RoadmapSplit {
  const sorted = [...items].sort((x, y) => x.rank - y.rank);
  const visible = sorted.filter((i) => i.included);
  const month = visible.filter((i) => i.horizon === 30).slice(0, TOP_ITEMS);
  const rest = visible.filter((i) => !month.includes(i));
  return {
    month,
    columns: { 30: rest.filter((i) => i.horizon === 30), 60: rest.filter((i) => i.horizon === 60), 90: rest.filter((i) => i.horizon === 90) },
    hidden: sorted.filter((i) => !i.included),
  };
}

/** The item to swap ranks with when moving `item` up (-1) or down (+1) as the screen shows it, or null at an edge.
 *  30-day items move through "Do this month" and the "Also this month" column as one list. */
export function neighborOf(s: RoadmapSplit, item: CroItem, dir: -1 | 1): CroItem | null {
  if (!item.included) return null;
  const list = item.horizon === 30 ? [...s.month, ...s.columns[30]] : s.columns[item.horizon] ?? [];
  const i = list.findIndex((x) => x.id === item.id);
  return i < 0 ? null : list[i + dir] ?? null;
}

// ---------- Form validation (the server rejects bad bodies with a bare 400, so check here first) ----------

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const MAX_AMOUNT = 1e9;
const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

export type ScenarioField = Exclude<keyof ScenarioInputs, "edited">;
export type ScenarioForm = Record<ScenarioField, string>;
const pct = (v: number) => String(Math.round(v * 1000) / 10);
export const scenarioToForm = (s: ScenarioInputs): ScenarioForm => ({
  visitors: String(s.visitors), currentRate: pct(s.currentRate), targetRate: pct(s.targetRate), closeRate: pct(s.closeRate), dealValue: String(s.dealValue),
});

/** Rates are typed as percentages (0–100) and stored as fractions (0–1). */
export function parseScenarioForm(f: ScenarioForm): Parsed<ScenarioInputs> {
  const amount = (s: string, label: string): Parsed<number> => {
    const n = num(s);
    return Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT ? { ok: true, value: n } : { ok: false, error: `${label} must be a number from 0 to 1,000,000,000.` };
  };
  const rate = (s: string, label: string): Parsed<number> => {
    const n = num(s);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? { ok: true, value: n / 100 } : { ok: false, error: `${label} must be a percentage from 0 to 100.` };
  };
  const visitors = amount(f.visitors, "Visitors a month"); if (!visitors.ok) return visitors;
  const currentRate = rate(f.currentRate, "Converting today"); if (!currentRate.ok) return currentRate;
  const targetRate = rate(f.targetRate, "After the changes"); if (!targetRate.ok) return targetRate;
  const closeRate = rate(f.closeRate, "Leads that buy"); if (!closeRate.ok) return closeRate;
  const dealValue = amount(f.dealValue, "Average job"); if (!dealValue.ok) return dealValue;
  return { ok: true, value: { visitors: visitors.value, currentRate: currentRate.value, targetRate: targetRate.value, closeRate: closeRate.value, dealValue: dealValue.value } };
}

export interface AssumptionsForm { model: BizModelKey; primary: string; tier: BusinessModel["traffic_tier"]; low: string; high: string; cycle: string }
export interface AssumptionOverrides {
  model?: BizModelKey; primary_conversion?: string; traffic_tier?: BusinessModel["traffic_tier"];
  deal_value_band?: { low: number; high: number }; sales_cycle?: string;
}
export const assumptionsToForm = (m: BusinessModel): AssumptionsForm => ({
  model: m.model, primary: m.primary_conversion, tier: m.traffic_tier, low: String(m.deal_value_band.low), high: String(m.deal_value_band.high), cycle: m.sales_cycle.label,
});

/** Validates the "how this business makes money" form and returns only the fields the user changed. */
export function parseAssumptionsForm(f: AssumptionsForm, current: BusinessModel): Parsed<AssumptionOverrides> {
  const primary = f.primary.trim(), cycle = f.cycle.trim(), low = num(f.low), high = num(f.high);
  if (!primary || primary.length > 200) return { ok: false, error: "Main goal is required (200 characters at most)." };
  if (!cycle || cycle.length > 100) return { ok: false, error: "Sales cycle is required (100 characters at most)." };
  if (![low, high].every((n) => Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT)) return { ok: false, error: "Job values must be numbers from 0 to 1,000,000,000." };
  if (low > high) return { ok: false, error: "The low job value can't be higher than the high one." };
  const o: AssumptionOverrides = {};
  if (f.model !== current.model) o.model = f.model;
  if (primary !== current.primary_conversion) o.primary_conversion = primary;
  if (f.tier !== current.traffic_tier) o.traffic_tier = f.tier;
  if (low !== current.deal_value_band.low || high !== current.deal_value_band.high) o.deal_value_band = { low, high };
  if (cycle !== current.sales_cycle.label) o.sales_cycle = cycle;
  return { ok: true, value: o };
}

/** Whether "Rebuild roadmap" shows: the form differs from the saved assumptions (or is invalid, so the problem can be reported),
 *  or an earlier attempt saved edits but the rebuild was refused (402/409), so the roadmap is still built from the old ones. */
export const rebuildVisible = (parsed: Parsed<AssumptionOverrides>, rebuildOwed: boolean): boolean =>
  rebuildOwed || !parsed.ok || Object.keys(parsed.value).length > 0;

/** A rebuild-only retry has nothing new to save, so it skips the assumptions PATCH. */
export const rebuildNeedsPatch = (o: AssumptionOverrides): boolean => Object.keys(o).length > 0;
