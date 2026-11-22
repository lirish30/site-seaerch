import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { editLedger } from "../../care/ledger";
import { ReportFacts } from "../../care/reportFacts";
import { previousMonth } from "../../care/reportSweep";
import { listReports } from "../../db/careReports";
import { getBusiness } from "../../db/businesses";
import { getSettings } from "../../db/settings";
import { localDay } from "../../monitoring/rollup";
import { zoneOf } from "../../sop/cadence";
import type { ToolCtx } from "./context";

/**
 * The monthly Care report tool, read only: per client, the report of one month with its status, its summary and recommendation, the headline numbers it was built from and the client's edit hours.
 * The answer is built field by field: never the report's token or link, a site's SSH alias or folder, a backup file name or anything else stored in the report's numbers beyond the fixed fields named here.
 * A rehearsal client's report is left out. An agent sends only a month and a client id, and nothing it sends is echoed.
 */
export function registerCareReportTools(server: McpServer, ctx: ToolCtx): void {
  const { db, log, text } = ctx;

  server.registerTool("get_care_report", {
    description: "The monthly Care reports of one month (period YYYY-MM, default last month), one per client, ordered by client name: status (collecting, ready, sent, revoked, cancelled), the summary and recommendation, when it was sent, how often the client opened it, the headline numbers (per site: uptime percent, days checked, incidents, longest outage in minutes, updates applied, rolled back and failed (with updatesTracked: false when no update run covered the site that month, so those counts were not measured and mean nothing), backups, mobile speed score; the edit requests done) and the client's edit hours that month (allowance, used, percent, state). A number that was not measured is null. clientId narrows to one client. Rehearsal clients are left out. Never a link or a token.",
    inputSchema: { period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "period must look like 2026-11").optional(), clientId: z.string().min(1).max(100).optional() },
  }, async ({ period, clientId }) => {
    const tz = zoneOf(await getSettings(db));
    const month = period ?? previousMonth(new Date(), tz);
    const reports = (await listReports(db, { period: month })).filter((r) => !r.test && (clientId === undefined || r.businessId === clientId));
    const rows = await Promise.all(reports.map(async (r) => {
      const facts = ReportFacts.safeParse(r.facts);
      return {
        clientId: r.businessId, client: (await getBusiness(db, r.businessId))?.name ?? "", status: r.status, summary: r.summary, recommendation: r.recommendation,
        sentOn: r.sentAt ? localDay(r.sentAt, tz) : null, views: r.viewCount,
        headline: facts.success ? {
          sites: facts.data.sites.map((s) => ({
            domain: s.domain, uptimePercent: s.uptimePercent, coveredDays: s.coveredDays, incidents: s.incidents, longestOutageMinutes: s.longestOutageMinutes,
            updatesApplied: s.updatesApplied, updatesRolledBack: s.updatesRolledBack, updatesFailed: s.updatesFailed, updatesTracked: s.updatesTracked === true, backups: s.backups, speedScore: s.speedScore,
          })),
          editRequestsDone: facts.data.edits ? facts.data.edits.requestsDone : null,
        } : null,
        ledger: await editLedger(ctx.env, r.businessId, month, tz),
      };
    }));
    rows.sort((a, b) => a.client.localeCompare(b.client));
    await log("get_care_report", `get_care_report ${month} client=${clientId === undefined ? "all" : "one"} -> ${rows.length}`);
    return text({ period: month, reports: rows });
  });
}
