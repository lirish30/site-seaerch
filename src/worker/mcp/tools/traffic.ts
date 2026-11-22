import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { clientSql, testClientSql } from "../../clients/record";
import { getSettings } from "../../db/settings";
import { linksForBusiness, monthsFor, type TrafficMonth } from "../../db/traffic";
import { zoneOf } from "../../sop/cadence";
import { previousMonth } from "../../sop/months";
import { trafficFor } from "../../traffic/forClient";
import type { ToolCtx } from "./context";

/** An email address in a sentence (up to the next space, without the punctuation that ends a sentence). */
const ADDRESS = /[^\s@]+@[^\s@]*[^\s@.,;:!?)]/g;

/**
 * The traffic tool, read only: per real client with a site linked to Google, the month's numbers as Google counted them (the sites merged, as the reports merge them) and each site's status with the plain sentence
 * for why a month could not be read in full. The answer is built field by field: counts only (the search queries, page paths and channel names are written by strangers and are left out), never a Google property
 * id, a token, anything Google said, or an email address (any address in a sentence is worded out, whatever account it was, whether or not Google is still connected). A rehearsal client is left out. An agent sends only a month and a client id, and nothing it sends is echoed.
 */
export function registerTrafficTools(server: McpServer, ctx: ToolCtx): void {
  const { db, log, text } = ctx;

  server.registerTool("get_traffic", {
    description: "Search and visit numbers per client, ordered by client name, for one month (period YYYY-MM, default last month): Search Console clicks and impressions with the average position, Analytics visits, people and visits from search, each with last month's figure where known (null when it was not measured), merged over the client's linked sites, or traffic null when nothing was pulled. Each linked site has its domain, its status for that month (ok, partial, failed, or null when not pulled yet) and, when the status is not ok, one plain sentence for why. Numbers are counted by Google's own month. Only clients with a site linked to Google appear; clientId narrows to one client. Rehearsal clients are left out. Never a property id, a token, a search query or page, or anything Google said.",
    inputSchema: { period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "period must look like 2026-11").optional(), clientId: z.string().min(1).max(100).optional() },
  }, async ({ period, clientId }) => {
    const tz = zoneOf(await getSettings(db));
    const month = period ?? previousMonth(new Date(), tz);
    const clients = (await db.prepare(
      `SELECT b.id AS id, b.name AS name FROM businesses b
       WHERE b.archived_at IS NULL AND ${clientSql("b")} AND NOT ${testClientSql("b")} ${clientId === undefined ? "" : "AND b.id = ?"}
         AND EXISTS (SELECT 1 FROM site_analytics a JOIN sites s ON s.id = a.site_id WHERE s.business_id = b.id AND s.archived_at IS NULL AND (a.gsc_property IS NOT NULL OR a.ga4_property IS NOT NULL))
       ORDER BY LOWER(b.name), b.id`,
    ).bind(...(clientId === undefined ? [] : [clientId])).all<{ id: string; name: string }>()).results;
    // A stored sentence can name the Google account that was connected when it was written (maybe another one, maybe none now): any address in it is worded out.
    const plain = (s: string) => s.replace(ADDRESS, "the connected Google account");
    const rows = await Promise.all(clients.map(async (b) => {
      const t = await trafficFor(db, b.id, month);
      const pulled = new Map<string, TrafficMonth>((await monthsFor(db, b.id, month)).map((m) => [m.siteId, m]));
      return {
        clientId: b.id, client: b.name,
        traffic: t === null ? null : {
          search: t.search && { clicks: t.search.clicks, impressions: t.search.impressions, position: t.search.position, previousClicks: t.search.previousClicks, previousImpressions: t.search.previousImpressions },
          visits: t.visits && { sessions: t.visits.sessions, users: t.visits.users, organic: t.visits.organic, keyEvents: t.visits.keyEvents, previousSessions: t.visits.previousSessions, previousOrganic: t.visits.previousOrganic },
          profile: t.profile && { calls: t.profile.calls, directions: t.profile.directions, websiteClicks: t.profile.websiteClicks, previousCalls: t.profile.previousCalls },
        },
        sites: (await linksForBusiness(db, b.id)).filter((l) => l.gscProperty !== null || l.ga4Property !== null).map((l) => {
          const m = pulled.get(l.siteId);
          // A site not pulled yet says what its last attempt said, if anything; a month that is not ok says why; an ok month says nothing.
          return { domain: l.domain, status: m?.status ?? null, error: plain(m ? (m.status === "ok" ? "" : m.error) : l.lastError) };
        }),
      };
    }));
    await log("get_traffic", `get_traffic ${month} client=${clientId === undefined ? "all" : "one"} -> ${rows.length}`);
    return text({ period: month, clients: rows });
  });
}
