import type { PublicSubscription } from "../worker/billing/checkout";
import type { ClientRecord, ClientRow } from "../worker/clients/record";
import type { AccessItem, AccessKey, AccessStatus, Site, SiteFields } from "../worker/db/sites";
import type { CareRow, IncidentView, SiteMonitoringView } from "../worker/monitoring/fleet";
import type { CareRunDetail, CareUpdateView, CareUpdatesBoard } from "../worker/care/views";
import type { CareBatch } from "../worker/db/careUpdates";
import type { PublicReport } from "../worker/care/reportPublic";
import type { PublicSeoReport } from "../worker/seo/reportPublic";
import type { EditLedger } from "../worker/care/ledger";
import type { ReportRow } from "../worker/care/reportAdmin";
export class ApiError extends Error { constructor(public status: number, message: string, public fields: string[] = [], public code = "", public body: unknown = undefined) { super(message); } }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method, credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/login")) { location.href = "/login"; throw new ApiError(401, "unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `HTTP ${res.status}`, (data as any).fields ?? [], (data as any).code ?? "", data);
  return data as T;
}

/** Sends a file as it is (a recording), not as JSON. */
async function putRaw<T>(path: string, body: Blob, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "PUT", credentials: "same-origin", headers, body });
  if (res.status === 401) { location.href = "/login"; throw new ApiError(401, "unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  putRaw,
  get: <T,>(p: string) => req<T>("GET", p),
  post: <T,>(p: string, b?: unknown) => req<T>("POST", p, b ?? {}),
  patch: <T,>(p: string, b: unknown) => req<T>("PATCH", p, b),
  put: <T,>(p: string, b: unknown) => req<T>("PUT", p, b),
  del: <T,>(p: string) => req<T>("DELETE", p),
};

/** The owner's client routes (Plan 9): the list, one client's whole record, and the site and access-checklist edits. Types only come from the worker. */
export const clientsApi = {
  /** Every client by name; `includeTest` adds the rehearsal ones (`?test=1`). */
  list: (includeTest = false) => api.get<{ clients: ClientRow[] }>(`/clients${includeTest ? "?test=1" : ""}`).then((r) => r.clients),
  get: (id: string) => api.get<{ client: ClientRecord }>(`/clients/${encodeURIComponent(id)}`).then((r) => r.client),
  /** A site added by hand (six `needed` access items come with it). A domain the client already has on a live site is a 409. */
  addSite: (id: string, fields: Partial<SiteFields> = {}) => api.post<{ site: Site; access: AccessItem[] }>(`/clients/${encodeURIComponent(id)}/sites`, fields),
  /** Only the fields given change. */
  patchSite: (id: string, siteId: string, fields: Partial<SiteFields>) => api.patch<{ site: Site }>(`/clients/${encodeURIComponent(id)}/sites/${encodeURIComponent(siteId)}`, fields),
  /** Archives the site (the server answers 204). */
  archiveSite: (id: string, siteId: string) => api.del<unknown>(`/clients/${encodeURIComponent(id)}/sites/${encodeURIComponent(siteId)}`),
  /** One checklist line: a new status, the NAME of a password manager item, or the owner note. Only the keys given change; null clears. */
  setAccess: (id: string, siteId: string, key: AccessKey, patch: { status?: AccessStatus; vaultItem?: string | null; note?: string | null }) =>
    api.put<{ item: AccessItem }>(`/clients/${encodeURIComponent(id)}/sites/${encodeURIComponent(siteId)}/access/${key}`, patch).then((r) => r.item),
};

/** The Care routes (Plan 11): the board, one client's incidents, and the monitoring switch. A site's address never comes back, only its domain. */
export const careApi = {
  /** Every client on the Care board, worst health first. */
  fleet: () => api.get<{ clients: CareRow[] }>("/care").then((r) => r.clients),
  /** One client's incidents, newest first (open and closed). */
  incidents: (businessId: string) => api.get<{ incidents: IncidentView[] }>(`/incidents?businessId=${encodeURIComponent(businessId)}`).then((r) => r.incidents),
  /** Switches monitoring on or off for one site. A site whose address can't be monitored is a 409 with a plain sentence. */
  setMonitoring: (siteId: string, enabled: boolean) => api.put<{ site: SiteMonitoringView }>(`/sites/${encodeURIComponent(siteId)}/monitoring`, { enabled }).then((r) => r.site),
  /** This week's batch and every Care site with its updates, last run and open update incident (Plan 12). */
  updates: () => api.get<CareUpdatesBoard>("/care/updates"),
  /** Hold an update back, or mark it as a security fix. Only the keys given change. */
  setUpdateFlag: (id: string, flags: { held?: boolean; security?: boolean }) => api.put<{ update: CareUpdateView }>(`/care/updates/${encodeURIComponent(id)}`, flags).then((r) => r.update),
  /** Starts this week's batch now. 409 with a plain sentence when it is already started. */
  startBatch: () => api.post<{ batch: CareBatch; queued: number }>("/care/batches"),
  /** Plans updates for one site by hand; it makes an approval. 409 with a plain sentence when the site can't take updates or has a run open. */
  runSite: (siteId: string) => api.post<{ batch: CareBatch }>(`/sites/${encodeURIComponent(siteId)}/care-run`).then((r) => r.batch),
  /** One run with its page checks and picture links. */
  run: (id: string) => api.get<{ run: CareRunDetail }>(`/care/runs/${encodeURIComponent(id)}`).then((r) => r.run),
  /** "Looks fine": Logan's own look at a page that is pending, unsure or broken. */
  pageOk: (checkId: string) => api.post<{ ok: true }>(`/care/checks/${encodeURIComponent(checkId)}/ok`),
  /** Closes an update_failed incident once Logan has dealt with it. */
  closeIncident: (id: string) => api.post<{ ok: true }>(`/incidents/${encodeURIComponent(id)}/close`),
  /** The month's reports (default last month), each with its link when it has one (Plan 13). */
  reports: (period?: string) => api.get<{ period: string; reports: ReportRow[] }>(`/care/reports${period ? `?period=${encodeURIComponent(period)}` : ""}`),
  /** One client's reports, newest month first. */
  clientReports: (businessId: string) => api.get<{ reports: ReportRow[] }>(`/care/reports?clientId=${encodeURIComponent(businessId)}`).then((r) => r.reports),
  /** Logan's own words for a ready report. A refusal comes back as a sentence. */
  editReport: (id: string, words: { summary: string; recommendation: string }) => api.put<{ report: ReportRow }>(`/care/reports/${encodeURIComponent(id)}`, words).then((r) => r.report),
  /** Takes a ready or sent report back; its link stops working. */
  revokeReport: (id: string) => api.post<{ report: ReportRow }>(`/care/reports/${encodeURIComponent(id)}/revoke`).then((r) => r.report),
  /** Starts last month's report for one client now. */
  buildReport: (businessId: string) => api.post<{ report: { id: string; status: string; period: string } }>(`/clients/${encodeURIComponent(businessId)}/care-report`).then((r) => r.report),
  /** This month's edit hours for one client; null when the client has no live Care plan. */
  ledger: (businessId: string) => api.get<{ ledger: EditLedger | null }>(`/clients/${encodeURIComponent(businessId)}/edit-ledger`).then((r) => r.ledger),
  /** Adds an edit request task to the client's Care project; a refusal is a 409 with a sentence. */
  addEditRequest: (businessId: string, title: string) => api.post<{ taskId: string }>(`/clients/${encodeURIComponent(businessId)}/edit-requests`, { title }),
};

// The client's subscription page (`/s/<token>`). Public: it deliberately bypasses `req`, whose 401 handling sends the visitor to the owner's login. No cookie is sent.

/** The page's state as the server reports it now: `{ status, page }`, `page` only for a 200. A dropped connection is `status` 0. */
export async function publicSubscription(token: string): Promise<{ status: number; page: PublicSubscription | null }> {
  try {
    const res = await fetch(`/api/public/s/${token}`, { credentials: "omit", cache: "no-store" });
    return { status: res.status, page: res.ok ? ((await res.json()) as PublicSubscription) : null };
  } catch { return { status: 0, page: null }; }
}

/** The client's monthly Care report (`/m/<token>`): `{ status, page }`, `page` only for a 200. A dropped connection is `status` 0. Public: no cookie is sent. */
export async function publicCareReport(token: string): Promise<{ status: number; page: PublicReport | null }> {
  try {
    const res = await fetch(`/api/public/m/${token}`, { credentials: "omit", cache: "no-store" });
    return { status: res.status, page: res.ok ? ((await res.json()) as PublicReport) : null };
  } catch { return { status: 0, page: null }; }
}

/** The client's monthly Local SEO report (`/l/<token>`): `{ status, page }`, `page` only for a 200. A dropped connection is `status` 0. Public: no cookie is sent. */
export async function publicSeoReport(token: string): Promise<{ status: number; page: PublicSeoReport | null }> {
  try {
    const res = await fetch(`/api/public/l/${token}`, { credentials: "omit", cache: "no-store" });
    return { status: res.status, page: res.ok ? ((await res.json()) as PublicSeoReport) : null };
  } catch { return { status: 0, page: null }; }
}

/** The click on "Set up payment": the payment page's address for this subscription, or the status that refused it. */
export async function startSubscriptionCheckout(token: string): Promise<{ status: number; url: unknown }> {
  try {
    const res = await fetch(`/api/public/s/${token}/checkout`, { method: "POST", credentials: "omit", cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { url?: unknown };
    return { status: res.status, url: res.ok ? data.url : undefined };
  } catch { return { status: 0, url: undefined }; }
}
