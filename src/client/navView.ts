import { STATUSES, type LeadRow, type LeadStatus } from "./types";

export type Section = "home" | "leads" | "find" | "outreach" | "work" | "settings";

const isWork = (p: string) => p === "/projects" || p.startsWith("/projects/") || p === "/timesheet" || p === "/billing" || p === "/money" || p === "/care" || p.startsWith("/care/") || p.startsWith("/tasks/") || p === "/clients" || p.startsWith("/clients/");

/** Which rail section a path belongs to. Today is Home; lists, Promising and a lead are Leads; New search, searches, Radar, Niche test and Import are Find; Outreach, Campaigns and the Pipeline are Outreach; projects, a task's redirect, the timesheet, Billing, Money and Care are Projects ("work"). */
export function sectionOf(pathname: string): Section {
  if (pathname === "/today") return "home";
  if (pathname === "/leads" || pathname.startsWith("/leads/") || pathname === "/promising") return "leads";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/outreach" || pathname === "/campaigns" || pathname === "/pipeline") return "outreach";
  if (isWork(pathname)) return "work";
  return "find";
}

export type SidebarKind = "home" | "leads" | "find" | "outreach" | "work" | "settings";

/** Only list-style pages get a contextual sidebar; a lead's own page and a client's page use the full width. */
export function sidebarOf(pathname: string): SidebarKind | null {
  if (pathname === "/today") return "home";
  if (pathname === "/outreach" || pathname === "/campaigns" || pathname === "/pipeline") return "outreach";
  if (pathname === "/leads" || pathname === "/promising") return "leads";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname.startsWith("/leads/") || pathname.startsWith("/clients/")) return null;
  if (isWork(pathname)) return "work";
  return "find";
}

/** Counts for the Leads sidebar from the loaded (active) rows. */
export function stageCounts(rows: LeadRow[]): { all: number; starred: number; byStatus: Record<LeadStatus, number> } {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
  let starred = 0;
  for (const r of rows) { byStatus[r.business.lead_status]++; if (r.business.starred_at !== null) starred++; }
  return { all: rows.length, starred, byStatus };
}
