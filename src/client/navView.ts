import { STATUSES, type LeadRow, type LeadStatus } from "./types";

export type Section = "home" | "leads" | "find" | "outreach" | "settings";

/** Which rail section a path belongs to. Today and Jobs are Home; lists, Promising and a lead are Leads; New search, searches, Radar and Import are Find. */
export function sectionOf(pathname: string): Section {
  if (pathname === "/today" || pathname === "/jobs") return "home";
  if (pathname === "/leads" || pathname.startsWith("/leads/") || pathname === "/promising") return "leads";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/outreach") return "outreach";
  return "find";
}

export type SidebarKind = "home" | "leads" | "find" | "outreach" | "settings";

/** Only list-style pages get a contextual sidebar; a lead's own page uses the full width. */
export function sidebarOf(pathname: string): SidebarKind | null {
  if (pathname === "/today" || pathname === "/jobs") return "home";
  if (pathname === "/outreach") return "outreach";
  if (pathname === "/leads" || pathname === "/promising") return "leads";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname.startsWith("/leads/")) return null;
  return "find";
}

/** Counts for the Leads sidebar from the loaded (active) rows. */
export function stageCounts(rows: LeadRow[]): { all: number; starred: number; byStatus: Record<LeadStatus, number> } {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
  let starred = 0;
  for (const r of rows) { byStatus[r.business.lead_status]++; if (r.business.starred_at !== null) starred++; }
  return { all: rows.length, starred, byStatus };
}
