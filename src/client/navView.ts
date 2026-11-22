import { STATUSES, type LeadRow, type LeadStatus } from "./types";

/**
 * The rail's sections, as in the Figma file: Home, Approvals, then finding work (Leads, Find, Outreach), then running it
 * (Sales, Clients, Work, Money), then Settings.
 */
export type Section = "home" | "approvals" | "leads" | "find" | "outreach" | "sales" | "clients" | "work" | "money" | "settings";

const under = (p: string, ...roots: string[]) => roots.some((r) => p === r || p.startsWith(`${r}/`));

/** Which rail section a path belongs to. */
export function sectionOf(pathname: string): Section {
  const p = pathname;
  if (p === "/today") return "home";
  if (under(p, "/approvals")) return "approvals";
  if (under(p, "/leads") || p === "/promising") return "leads";
  if (under(p, "/settings")) return "settings";
  if (p === "/outreach" || p === "/studio") return "outreach";
  if (p === "/pipeline" || p === "/campaigns" || under(p, "/deals")) return "sales";
  if (under(p, "/clients", "/care") || p === "/seo") return "clients";
  if (under(p, "/projects", "/tasks") || p === "/timesheet" || p === "/batches") return "work";
  if (p === "/money" || p === "/billing") return "money";
  return "find";
}

export type SidebarKind = "home" | "leads" | "find" | "outreach" | "sales" | "clients" | "work" | "money" | "settings";

/** List pages get their section's sidebar; one record (a lead, a client, a deal, a project) uses the full width. */
export function sidebarOf(pathname: string): SidebarKind | null {
  const p = pathname;
  if (p.startsWith("/leads/") || p.startsWith("/clients/") || p.startsWith("/deals/") || p.startsWith("/projects/") || p.startsWith("/care/runs/")) return null;
  const s = sectionOf(p);
  if (s === "approvals") return null;
  return s;
}

/** Counts for the Leads sidebar from the loaded (active) rows. */
export function stageCounts(rows: LeadRow[]): { all: number; starred: number; byStatus: Record<LeadStatus, number> } {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
  let starred = 0;
  for (const r of rows) { byStatus[r.business.lead_status]++; if (r.business.starred_at !== null) starred++; }
  return { all: rows.length, starred, byStatus };
}
