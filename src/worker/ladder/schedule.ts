// The retention ladder's dates (Plan 15): pure, no database. A build's launch date is a local calendar date (YYYY-MM-DD) the caller worked out in the booking zone.
import { addDays } from "../billing/dates";
import type { LadderStep } from "../db/ladder";

type DatedStep = Exclude<LadderStep, "december_letter">;

/** Days after launch that each dated step falls due. */
export const LADDER_OFFSETS: Record<DatedStep, number> = { review_request: 0, testimonial: 10, thank_you: 30, check_in: 90, case_study: 120 };

/** The five dated steps after a launch, in the order they fall due. Days are added as calendar days, never months. */
export function ladderRowsFor(launchOn: string, o: { businessId: string; projectId: string }): { businessId: string; projectId: string; step: DatedStep; dueOn: string }[] {
  return (Object.keys(LADDER_OFFSETS) as DatedStep[]).map((step) => ({ businessId: o.businessId, projectId: o.projectId, step, dueOn: addDays(launchOn, LADDER_OFFSETS[step]) }));
}

/** The yearly letter to a client: due on the first of December, tied to no project. */
export const decemberRow = (businessId: string, year: number): { businessId: string; projectId: null; step: "december_letter"; dueOn: string } =>
  ({ businessId, projectId: null, step: "december_letter", dueOn: `${String(year).padStart(4, "0")}-12-01` });
