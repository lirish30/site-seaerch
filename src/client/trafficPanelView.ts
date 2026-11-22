import type { AccessKey, AccessStatus } from "../worker/db/sites";
import type { TrafficStatus } from "../worker/db/traffic";
import type { Candidates } from "../worker/traffic/link";
import type { ClientTraffic, PanelMonth, PanelSite } from "../worker/traffic/panel";
import { isGbpLocation } from "../worker/traffic/location";
import { accessWords } from "./clientView";

/** The owner's Traffic panel on a client's page: the words and the small decisions, as pure functions. No DOM, no fetch, no clock. */
export type { Candidates, ClientTraffic, PanelMonth, PanelSite };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "November 2026" for `2026-11`; anything else comes back as it is. */
export function periodLabel(period: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : period;
}

/** The month before the one `today` (`YYYY-MM-DD`, the owner's calendar day) falls in, `YYYY-MM`: what "Pull last month now" asks for. Null when `today` does not read as a date. */
export function lastMonthOf(today: string): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])-\d{2}$/.exec(today);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
}

/** The line about whose access to ask for (or what to do in Settings first). */
export function accessLine(t: Pick<ClientTraffic, "connected" | "hasScopes" | "email">, clientName: string): string {
  if (!t.connected) return "Connect your Google account in Settings first.";
  if (!t.hasScopes) return "Reconnect Google in Settings to add Search Console and Analytics.";
  return `Ask ${clientName} to add ${t.email ?? "the connected Google account"} as a viewer on their Search Console and Analytics.`;
}

/** What is linked to the site, as plain text lines: the property ids are shown as they are (the owner's page only). */
export function linkedLines(s: Pick<PanelSite, "gscProperty" | "ga4Property" | "gbpLocation">): string[] {
  const lines: string[] = [];
  if (s.gscProperty) lines.push(`Search Console: ${s.gscProperty}`);
  if (s.ga4Property) lines.push(`Analytics property: ${s.ga4Property}`);
  if (s.gbpLocation) lines.push(`Business Profile: ${s.gbpLocation}`);
  return lines;
}

/** Whether there is something to pull or unlink: the site has a property or a Business Profile location linked. */
export const hasLink = (s: Pick<PanelSite, "gscProperty" | "ga4Property" | "gbpLocation">): boolean => s.gscProperty !== null || s.ga4Property !== null || !!s.gbpLocation;

const STATUS_WORDS: Record<TrafficStatus, string> = { ok: "Read in full", partial: "Read in part", failed: "Could not be read" };
const STATUS_TONES: Record<TrafficStatus, "positive" | "warning" | "critical"> = { ok: "positive", partial: "warning", failed: "critical" };
export const statusWord = (s: TrafficStatus): string => STATUS_WORDS[s];
export const statusTone = (s: TrafficStatus): "positive" | "warning" | "critical" => STATUS_TONES[s];

const whole = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${whole(n)} ${n === 1 ? one : many}`;

/** One row of the month table. `numbers` is what Google counted (a block that was not read is not mentioned, never 0), and `error` is the plain sentence, only for a month that was not read in full. */
export interface MonthRow { period: string; label: string; status: TrafficStatus; statusWord: string; tone: "positive" | "warning" | "critical"; numbers: string; error: string }

export function monthRows(months: PanelMonth[]): MonthRow[] {
  return months.map((m) => {
    const parts: string[] = [];
    if (m.search) parts.push(`${plural(m.search.clicks, "click", "clicks")} from ${plural(m.search.impressions, "search result", "search results")}`);
    if (m.visits) parts.push(plural(m.visits.sessions, "visit", "visits"));
    if (m.profile) parts.push(`${plural(m.profile.calls, "call", "calls")} from the profile`);
    return { period: m.period, label: periodLabel(m.period), status: m.status, statusWord: statusWord(m.status), tone: statusTone(m.status), numbers: parts.join(", "), error: m.status === "ok" ? "" : m.error };
  });
}

/** The checklist's Analytics line for a site ("Analytics access on the checklist: requested"), or null when the record has no such item. */
export function analyticsAccessLine(access: { key: AccessKey; status: AccessStatus }[]): string | null {
  const item = access.find((a) => a.key === "analytics");
  return item ? `Analytics access on the checklist: ${accessWords(item.status)}` : null;
}

/** What the owner picked from the found properties: `""` for none. */
export interface Choice { gsc: string; ga4: string }

/** The body of the link call for a choice, or null when nothing is chosen. A key is only sent for something that was chosen, so one source can be added without touching the other. */
export function linkBody(c: Choice): { gscProperty?: string; ga4Property?: string } | null {
  const body: { gscProperty?: string; ga4Property?: string } = {};
  if (c.gsc) body.gscProperty = c.gsc;
  if (c.ga4) body.ga4Property = c.ga4;
  return body.gscProperty || body.ga4Property ? body : null;
}

/** What "Find properties" found, in words: nothing found says so, and what to do about it. */
export function foundLine(c: Candidates): string {
  if (c.gsc.length === 0 && c.ga4.length === 0) return "Nothing found for this site. Ask the client to add the connected Google account as a viewer, then look again.";
  return "Choose what to link.";
}

/** The panel is for a client that has at least one live site. */
export const showPanel = (data: Pick<ClientTraffic, "sites">): boolean => data.sites.length > 0;

/** The help under the Business Profile location field. */
export const PROFILE_HELP = "From your Business Profile API access (the location id looks like locations/1234567890)";
/** Where "Add the Business Profile permission" goes: the connect route with the extra consent. */
export const PROFILE_CONNECT_PATH = "/api/google/connect?profile=1";

/** The note under the location field while the connected account lacks the Business Profile permission, or null (nothing to say when Google is not connected at all: the access line says so). */
export function profileNote(t: Pick<ClientTraffic, "connected" | "hasProfileScope">): string | null {
  return t.connected && !t.hasProfileScope ? "The connected Google account does not have the Business Profile permission yet. A location can only be saved once it has." : null;
}

/** The body of the link call for a pasted location (trimmed), or null when it is blank or is not a location id. */
export function locationBody(raw: string): { gbpLocation: string } | null {
  const gbpLocation = raw.trim();
  return isGbpLocation(gbpLocation) ? { gbpLocation } : null;
}

/** Why a pasted location cannot be saved, once something was typed; null for a blank field or a good id. */
export const locationProblem = (raw: string): string | null => (raw.trim() === "" || locationBody(raw) ? null : "That is not a location id. It looks like locations/1234567890.");

/** Saving needs a new, valid location, the permission on the connection, and nothing else running. */
export const canSaveLocation = (raw: string, s: Pick<PanelSite, "gbpLocation">, busy: boolean, hasPermission: boolean): boolean => {
  const body = locationBody(raw);
  return !busy && hasPermission && body !== null && body.gbpLocation !== s.gbpLocation;
};

/** Clearing needs a saved location and nothing else running (it needs no permission). */
export const canClearLocation = (s: Pick<PanelSite, "gbpLocation">, busy: boolean): boolean => !busy && !!s.gbpLocation;

/** What a site is called on the panel. */
export const siteName = (s: Pick<PanelSite, "domain">): string => s.domain ?? "This site";

type Site = Pick<PanelSite, "domain" | "gscProperty" | "ga4Property" | "gbpLocation">;

/** A site with no domain cannot be matched to a Google property: the panel says to set it first. */
export const needsDomain = (s: Pick<PanelSite, "domain">): boolean => !s.domain;

/** Looking for properties needs the site's domain (a property is matched to it) and nothing else running. */
export const canFind = (s: Pick<PanelSite, "domain">, busy: boolean): boolean => !busy && !needsDomain(s);

/** Pulling needs a linked property, a month to ask for, and nothing else running. */
export const canPull = (s: Site, busy: boolean, period: string | null): boolean => !busy && hasLink(s) && period !== null;

/** Unlinking needs something linked and nothing else running. */
export const canUnlink = (s: Site, busy: boolean): boolean => !busy && hasLink(s);

/** Linking needs a chosen property (the body `linkBody` made) and nothing else running. */
export const canLink = (body: ReturnType<typeof linkBody>, busy: boolean): boolean => !busy && body !== null;

/** The question asked before a site is unlinked. */
export const unlinkQuestion = (s: Pick<PanelSite, "domain">): string => `Unlink ${siteName(s)} from Google? The months already pulled stay.`;

/** How the result of "Pull last month now" is shown: a month that was read in full is a plain line; anything else is a problem and says why. */
export function pullResult(r: { status: TrafficStatus; error: string }): { text: string; tone: "ok" | "error" } {
  return r.status === "ok" ? { text: "Pulled last month.", tone: "ok" } : { text: r.error || "Last month could not be read.", tone: "error" };
}
