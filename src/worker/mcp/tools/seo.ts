import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { previousMonth } from "../../care/reportSweep";
import { clientSql, testClientSql } from "../../clients/record";
import { getProfile, listKeywords, snapshotsFor } from "../../db/seo";
import { getSeoReportFor } from "../../db/seoReports";
import { getSettings } from "../../db/settings";
import { localDay } from "../../monitoring/rollup";
import { latestGrid, visiblePoints, waitingFor } from "../../seo/overview";
import { zoneOf } from "../../sop/cadence";
import type { ToolCtx } from "./context";

/**
 * The Local SEO status tool, read only: per client with a Local SEO profile, the watch's status, the search terms, the latest rank check summarized as the points where the business showed in the top 3, the
 * profile's rating and review count, what is waiting on Logan (counts only) and the month's report with its words. The answer is built field by field: never a report's token or link, a Google place id or map
 * location, a review's text or its writer's name, or anything a remote service said. A rehearsal client is left out. An agent sends only a month and a client id, and nothing it sends is echoed.
 */
export function registerSeoTools(server: McpServer, ctx: ToolCtx): void {
  const { db, log, text } = ctx;

  server.registerTool("get_seo_status", {
    description: "Local SEO status per client, ordered by client name: the watch status (setup, active, paused), the search terms being tracked, the latest rank check per term (measured points, and visible: how many of them showed the business in the top 3 of Google's results in our own check, null when too few points were measured), the Google profile's rating and review count (null when not read yet), the counts of review replies and content drafted and waiting for Logan and of low-rated reviews still needing an answer, and the report of one month (period YYYY-MM, default last month): its status (collecting, ready, sent, revoked, cancelled), summary, recommendation and three priorities, or null when none was started. A number that was not measured is null. clientId narrows to one client. Rehearsal clients are left out. Never a link, a token, a place id or any review text.",
    inputSchema: { period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "period must look like 2026-11").optional(), clientId: z.string().min(1).max(100).optional() },
  }, async ({ period, clientId }) => {
    const tz = zoneOf(await getSettings(db));
    const month = period ?? previousMonth(new Date(), tz);
    const clients = (await db.prepare(
      `SELECT b.id AS id, b.name AS name FROM seo_profiles sp JOIN businesses b ON b.id = sp.business_id
       WHERE b.archived_at IS NULL AND ${clientSql("b")} AND NOT ${testClientSql("b")} ${clientId === undefined ? "" : "AND b.id = ?"} ORDER BY LOWER(b.name), b.id`,
    ).bind(...(clientId === undefined ? [] : [clientId])).all<{ id: string; name: string }>()).results;
    const rows = await Promise.all(clients.map(async (b) => {
      const profile = await getProfile(db, b.id);
      const snapshot = (await snapshotsFor(db, b.id, {})).at(-1) ?? null;
      const report = await getSeoReportFor(db, b.id, month);
      return {
        clientId: b.id, client: b.name, status: profile?.status ?? null,
        keywords: (await listKeywords(db, b.id)).map((k) => ({ term: k.term, town: k.town.trim() === "" ? null : k.town, active: k.active })),
        grid: (await latestGrid(db, b.id)).map((g) => ({ term: g.term, town: g.town, takenOn: g.takenOn, measured: g.measured, visible: visiblePoints(g.points) })),
        rating: snapshot?.rating ?? null, reviewCount: snapshot?.reviewCount ?? null,
        waiting: await waitingFor(db, b.id),
        report: report && !report.test ? {
          period: report.period, status: report.status, summary: report.summary, recommendation: report.recommendation, priorities: report.priorities,
          sentOn: report.sentAt ? localDay(report.sentAt, tz) : null, views: report.viewCount,
        } : null,
      };
    }));
    await log("get_seo_status", `get_seo_status ${month} client=${clientId === undefined ? "all" : "one"} -> ${rows.length}`);
    return text({ period: month, clients: rows });
  });
}
