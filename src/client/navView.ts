import { STATUSES, type LeadRow, type LeadStatus } from "./types";

export type Section = "home" | "leads" | "find" | "outreach" | "settings";

/** Which rail section a path belongs to. Today is Home; lists, Promising and Import are Leads; New search, a search's results and Radar are Find. */
export function sectionOf(pathname: string): Section {
  if (pathname === "/today") return "home";
  if (pathname === "/leads" || pathname.startsWith("/leads/") || pathname === "/promising" || pathname === "/import") return "leads";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/outreach") return "outreach";
  return "find";
}

/** Only list-style pages get a contextual sidebar; a lead's own page, Home and Settings use the full width. */
export function sidebarOf(pathname: string): "leads" | "find" | null {
  if (pathname === "/leads" || pathname === "/promising" || pathname === "/import") return "leads";
  if (pathname === "/" || pathname === "/radar") return "find";
  return null;
}

/** Counts for the Leads sidebar from the loaded (active) rows. */
export function stageCounts(rows: LeadRow[]): { all: number; starred: number; byStatus: Record<LeadStatus, number> } {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
  let starred = 0;
  for (const r of rows) { byStatus[r.business.lead_status]++; if (r.business.starred_at !== null) starred++; }
  return { all: rows.length, starred, byStatus };
}
