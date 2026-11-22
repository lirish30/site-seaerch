// STUB (Plan 14 Task 8): the real approval of the monthly Local SEO report is built in Task 10, which replaces this file wholesale. Until then nothing may reach it:
// the report's Claude task and the sweep are not live, and the tests of the report kind replace this module.
import type { SeoReport } from "../db/seoReports";
import type { Env } from "../env";

/** Proposes the approval for a `ready` report (one per report: a second call returns the existing one) and returns its id. */
export async function proposeSeoReportApproval(_env: Env, _report: SeoReport): Promise<string> {
  throw new Error("seo.report approval is not built yet");
}

/** Rewrites the pending approval's card after the words were edited; true when there was a pending one to rewrite. */
export async function refreshSeoReportApproval(_env: Env, _report: SeoReport): Promise<boolean> {
  throw new Error("seo.report approval is not built yet");
}
