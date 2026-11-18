import type { SpendLevel } from "./approvalsView";

export interface ServiceSpend { service: string; spentUsd: number; capUsd: number | null; level: SpendLevel }

export const MAX_CAP_USD = 1000;

const SERVICE_LABEL: Record<string, string> = {
  brightdata: "Bright Data",
  places: "Google Places",
  pagespeed: "PageSpeed",
  browser: "Browser rendering",
  claude: "Claude (subscription)",
  claude_cro: "Claude (subscription)",
  claude_agent: "Claude (subscription)",
};

/** Friendly name for a usage service key; an unknown key is shown as it is. */
export const serviceLabel = (service: string): string => SERVICE_LABEL[service] ?? service;

/** One service's line in Usage & limits: whole dollars, matching the total's spend line. */
export function serviceCapLine(s: { service: string; spentUsd: number; capUsd: number | null }): string {
  const spent = `$${Math.round(s.spentUsd)}`;
  return s.capUsd === null ? `${s.service}: ${spent}, no cap` : `${s.service}: ${spent} of $${Math.round(s.capUsd)}`;
}

/** What a cap's level means in words, since colour alone must not carry it. */
export const levelWord = (level: SpendLevel): string => (level === "capped" ? "Paused" : level === "warn" ? "Near cap" : "OK");

/** The cap box → a cap in dollars, null for a blank box (remove the cap), or an error. Blank must never save as $0. */
export function parseCapInput(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = raw.trim().replace(/^\$/, "");
  if (!t) return { ok: true, value: null };
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= MAX_CAP_USD ? { ok: true, value: n } : { ok: false, error: `Enter a cap between 0 and ${MAX_CAP_USD}, or leave it empty for no cap.` };
}
