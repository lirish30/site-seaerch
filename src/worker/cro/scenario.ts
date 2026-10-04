import { BIZ_MODELS } from "./models";
import type { BusinessModel, ScenarioInputs } from "./types";

export const SCENARIO_LABEL = "Illustrative, based on the assumptions shown";
const VISITORS = { low: 500, medium: 2000, high: 8000 } as const;

export function defaultScenario(m: BusinessModel): ScenarioInputs {
  return { visitors: VISITORS[m.traffic_tier], currentRate: 0.02, targetRate: 0.03, closeRate: BIZ_MODELS[m.model].closeRate,
    dealValue: Math.round((m.deal_value_band.low + m.deal_value_band.high) / 2) };
}

/** Added monthly leads and revenue, from half the conversion lift (low) to all of it (high). */
export function scenarioRange(i: ScenarioInputs): { leads: [number, number]; revenue: [number, number] } {
  // Rounded to cents of a lead so 0.03 - 0.02 doesn't come out as 0.00999…
  const lift = Math.round(Math.max(0, i.targetRate - i.currentRate) * i.visitors * 100) / 100;
  const rev = (n: number) => Math.round(n * i.closeRate * i.dealValue);
  return { leads: [Math.round(lift / 2), Math.round(lift)], revenue: [rev(lift / 2), rev(lift)] };
}
