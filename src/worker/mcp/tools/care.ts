import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chunks } from "../../db/chunks";
import { listIncidents } from "../../db/monitoring";
import { careUpdatesBoard } from "../../care/views";
import { careFleet, incidentViews } from "../../monitoring/fleet";
import type { ToolCtx } from "./context";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * The Care tools, read only: the fleet as the Care board shows it, the Care updates board, and the incident list as the board's incident feed does.
 * Both answers are built here field by field from the fleet and incident views: no site address (only a domain), no vault name, no access note, no token, no Stripe id, no stored incident text.
 * Test clients and archived sites never appear. An agent sends only a flag, an id and a number, and nothing it sends is echoed.
 */
export function registerCareTools(server: McpServer, ctx: ToolCtx): void {
  const { db, log, text } = ctx;

  server.registerTool("get_care_overview", {
    description: "The Care board: every client on Care (or with a site monitored by hand), worst health first. Each has its health score (0 to 100), band (good, watch, at_risk), the plain reasons behind the score, its 30-day uptime percent (null with no checks yet), its Care plan label and how many incidents are open. Test clients are left out.",
    inputSchema: {},
  }, async () => {
    const fleet = await careFleet(db, new Date());
    const clients = fleet.map((r) => ({
      clientId: r.businessId, name: r.name, careLabel: r.careLabel, healthScore: r.health.score, band: r.health.band, reasons: [...r.health.reasons],
      uptime30: r.uptime30, openIncidents: r.openIncidents.length,
    }));
    await log("get_care_overview", `get_care_overview -> ${clients.length} clients`);
    return text({ clients });
  });

  server.registerTool("get_care_updates", {
    description: "The Care updates board: this week's update batch (period, status) and, for each Care site, its domain, whether it can take updates (and why not), the updates it could take with their risk (security, major, mild, minor), whether each is held or due, the status of its last update run and its open update_failed incident. Read only. Never an SSH alias, a folder, a page body or a picture.",
    inputSchema: {},
  }, async () => {
    const board = await careUpdatesBoard(db, new Date());
    const out = {
      batch: board.batch ? { period: board.batch.period, kind: board.batch.kind, status: board.batch.status } : null,
      sites: board.sites.map((s) => ({
        siteId: s.siteId, domain: s.domain, canUpdate: s.canUpdate, why: s.why,
        updates: s.updates.map((u) => ({ type: u.type, slug: u.slug, name: u.name, from: u.fromVersion, to: u.toVersion, risk: u.risk, held: u.held, due: u.due && !u.held })),
        lastRun: s.lastRun ? { status: s.lastRun.status, finishedAt: s.lastRun.finishedAt } : null,
        updateFailed: s.openIncident ? { id: s.openIncident.id, openedAt: s.openIncident.openedAt, detail: s.openIncident.detail } : null,
      })),
    };
    await log("get_care_updates", `get_care_updates -> ${out.sites.length} sites`);
    return text(out);
  });

  server.registerTool("list_incidents", {
    description: `Site incidents (a site down, a domain about to expire), newest first. open: true keeps only the open ones, false only the closed ones. clientId narrows to one client (an unknown id gives an empty list). limit is 1 to ${MAX_LIMIT}, default ${DEFAULT_LIMIT}. Test clients are left out. detail is a fixed phrase such as "HTTP 503".`,
    inputSchema: { open: z.boolean().optional(), clientId: z.string().min(1).max(100).optional(), limit: z.number().int().min(1).max(MAX_LIMIT).optional() },
  }, async ({ open, clientId, limit }) => {
    const incidents = await listIncidents(db, { ...(open !== undefined ? { open } : {}), ...(clientId !== undefined ? { businessId: clientId } : {}), limit: limit ?? DEFAULT_LIMIT });
    // The views word every detail safely and drop an incident whose site is archived; the client comes from the incident row.
    const views = await incidentViews(db, incidents, new Date());
    const clientOf = new Map(incidents.map((i) => [i.id, i.businessId]));
    const names = new Map<string, string>();
    for (const part of chunks([...new Set(views.map((v) => clientOf.get(v.id)!))])) {
      const rows = (await db.prepare(`SELECT id, name FROM businesses WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ id: string; name: string }>()).results;
      for (const r of rows) names.set(r.id, r.name);
    }
    const out = views.map((v) => ({
      id: v.id, clientId: clientOf.get(v.id)!, clientName: names.get(clientOf.get(v.id)!) ?? "", domain: v.domain, kind: v.kind, openedAt: v.openedAt, closedAt: v.closedAt, detail: v.detail,
    }));
    await log("list_incidents", `list_incidents open=${open ?? "any"} client=${clientId === undefined ? "all" : "one"} -> ${out.length}`);
    return text({ incidents: out });
  });
}
