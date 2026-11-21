import type { CareReport } from "../db/careReports";
import type { Env } from "../env";

/**
 * Stub until the report approval lands: it proposes nothing yet. Replaced in Task 7.
 * The contract Task 7 must keep: idempotent (one approval per report; a second call returns the existing id) and never null for a `ready` report. The summary task's crash-retry and
 * its stale paths call it for any `ready` report that has no approval linked, and rely on that.
 */
export async function proposeReportApproval(_env: Env, _report: CareReport): Promise<string | null> {
  return null;
}
