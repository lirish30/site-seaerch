import type { CareReport } from "../db/careReports";
import type { Env } from "../env";

/** Stub until the report approval lands: it proposes nothing yet. Replaced in Task 7. */
export async function proposeReportApproval(_env: Env, _report: CareReport): Promise<string | null> {
  return null;
}
