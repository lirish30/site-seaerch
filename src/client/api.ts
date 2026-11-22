import type { PublicSubscription } from "../worker/billing/checkout";
import type { GradeView } from "../worker/clients/grade";
import type { ClientRecord, ClientRow } from "../worker/clients/record";
import type { Grade } from "../worker/db/grade";
import type { AccessItem, AccessKey, AccessStatus, Site, SiteFields } from "../worker/db/sites";
import type { CareRow, IncidentView, SiteMonitoringView } from "../worker/monitoring/fleet";
import type { BatchGroup } from "../worker/batches/groups";
import type { CareRunDetail, CareUpdateView, CareUpdatesBoard } from "../worker/care/views";
import type { CareBatch } from "../worker/db/careUpdates";
import type { PublicReport } from "../worker/care/reportPublic";
import type { PublicSeoReport } from "../worker/seo/reportPublic";
import type { EditLedger } from "../worker/care/ledger";
import type { ReportRow } from "../worker/care/reportAdmin";
import type { Citation, CitationStatus, ContentItem, GbpSnapshot, SeoKeyword, SeoProfile, SeoReview } from "../worker/db/seo";
import type { NapResult } from "../worker/seo/nap";
import type { GridRow } from "../worker/seo/overview";
import type { PlaceCandidate } from "../worker/seo/places";
import type { SeoReportRow } from "../worker/seo/reportAdmin";
import type { LadderRow } from "../worker/db/ladder";
import type { SiteLink, TrafficStatus } from "../worker/db/traffic";
import type { Candidates } from "../worker/traffic/link";
import type { ClientTraffic } from "../worker/traffic/panel";
import type { MemoRow } from "../worker/strategy/admin";
import type { PublicMemo } from "../worker/strategy/public";
import type { AutoApproveState } from "../worker/routes/autoApprove";
import type { StudioCopy, StudioPost } from "./studioView";
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

/** Sends a form (a file upload) as it is: the browser sets the multipart header itself. */
async function postForm<T>(path: string, body: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "POST", credentials: "same-origin", body });
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
  /** Sets the grade (A, B or C, with a note of at most 300 characters), or clears it with null (which clears the note too). */
  setGrade: (id: string, grade: Grade | null, note = "") => api.put<GradeView>(`/clients/${encodeURIComponent(id)}/grade`, { grade, note }),
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

/** The Studio (Plan 15): social posts from a draft to posted. A post comes back with how many pictures it has, never where they are kept; a picture is `imageUrl`. Nothing here posts anywhere. */
export const studioApi = {
  list: () => api.get<{ posts: StudioPost[] }>("/studio").then((r) => r.posts),
  create: (body: Record<string, unknown>) => api.post<StudioPost>("/studio", body),
  write: (id: string) => api.post<StudioPost>(`/studio/${encodeURIComponent(id)}/write`),
  upload: (id: string, slot: "before" | "after", file: File) => { const f = new FormData(); f.set("file", file); return postForm<StudioPost>(`/studio/${encodeURIComponent(id)}/upload/${slot}`, f); },
  render: (id: string) => api.post<StudioPost>(`/studio/${encodeURIComponent(id)}/render`),
  saveCopy: (id: string, copy: StudioCopy) => api.put<StudioPost>(`/studio/${encodeURIComponent(id)}/copy`, copy),
  posted: (id: string) => api.post<StudioPost>(`/studio/${encodeURIComponent(id)}/posted`),
  discard: (id: string) => api.post<StudioPost>(`/studio/${encodeURIComponent(id)}/discard`),
  /** The picture behind the session; `v` changes when the post does, so a redrawn picture is fetched again. */
  imageUrl: (id: string, n: number, v: string) => `/api/studio/${encodeURIComponent(id)}/image/${n}?v=${encodeURIComponent(v)}`,
};

/** The batch board (Plan 15): each recurring job's current period across live clients. Read only. */
export const batchesApi = {
  list: () => api.get<{ groups: BatchGroup[] }>("/batches").then((r) => r.groups),
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

/** Everything about one client's Local SEO in one answer (`GET /clients/:id/seo`). A client with no setup yet gets nulls and empty lists; the profile never carries the checker's raw text. */
export interface SeoOverview {
  profile: (Omit<SeoProfile, "napResult"> & { napResult?: undefined }) | null;
  keywords: SeoKeyword[];
  latestGrid: GridRow[];
  snapshot: GbpSnapshot | null;
  nap: NapResult | null;
  reviews: SeoReview[];
  content: ContentItem[];
  citations: Citation[];
}
/** One client's row on the /seo board: what to do next in a sentence, what waits, and last month's report. */
export interface SeoBoardRow {
  clientId: string; client: string; next: string; draftsWaiting: number; flaggedReviews: number;
  report: { id: string; period: string; status: SeoReportRow["status"] } | null;
}
export interface SeoProfileInput { placeId: string; trade: string; towns: string[]; gridKm: number; siteId?: string }
export interface SeoContentEdit { title?: string; metaTitle?: string; metaDescription?: string; body?: string }

/** The owner's Traffic panel routes (Plan 16): what is linked and pulled for a client's sites, and finding, linking and pulling. Google is only read, never written to. */
export const trafficApi = {
  get: (clientId: string) => api.get<ClientTraffic>(`/clients/${encodeURIComponent(clientId)}/traffic`),
  /** The Search Console entries and Analytics properties of the connected Google account that belong to the site. Nothing is linked. */
  find: (siteId: string) => api.post<Candidates>(`/traffic/site/${encodeURIComponent(siteId)}/find`),
  link: (siteId: string, body: { gscProperty?: string | null; ga4Property?: string | null; gbpLocation?: string | null }) => api.put<SiteLink>(`/traffic/site/${encodeURIComponent(siteId)}/link`, body),
  /** Removes both links; the months already pulled stay (the server answers 204). */
  unlink: (siteId: string) => api.del<unknown>(`/traffic/site/${encodeURIComponent(siteId)}/link`),
  /** Pulls a finished month now. The answer is the month's status and its plain sentence. */
  pull: (siteId: string, period: string) => api.post<{ status: TrafficStatus; error: string }>(`/traffic/site/${encodeURIComponent(siteId)}/pull`, { period }),
};

/** The owner's strategy memo routes (Plan 16). Starting one only freezes the facts and asks Claude; the mail goes out only when its approval is approved. */
export const strategyApi = {
  /** The client's memos, newest first. */
  list: (clientId: string) => api.get<{ memos: MemoRow[] }>(`/clients/${encodeURIComponent(clientId)}/strategy-memos`).then((r) => r.memos),
  /** Starts a memo, or answers the one already open. A 409 carries a plain sentence (a lead, or nothing measured yet). */
  start: (clientId: string) => api.post<{ memoId: string; status: string; created: boolean }>(`/clients/${encodeURIComponent(clientId)}/strategy-memo`),
  /** Cancels a memo that has not gone out. */
  cancel: (clientId: string, memoId: string) => api.post<{ memo: MemoRow }>(`/clients/${encodeURIComponent(clientId)}/strategy-memos/${encodeURIComponent(memoId)}/cancel`).then((r) => r.memo),
  /** Takes a ready or sent memo back: its link stops working. */
  revoke: (clientId: string, memoId: string) => api.post<{ memo: MemoRow }>(`/clients/${encodeURIComponent(clientId)}/strategy-memos/${encodeURIComponent(memoId)}/revoke`).then((r) => r.memo),
};

/** The post-launch ladder routes (Plan 15). Nothing here sends mail: a mail goes out only when its approval is approved. */
export const ladderApi = {
  list: (clientId: string) => api.get<{ rows: LadderRow[] }>(`/clients/${encodeURIComponent(clientId)}/ladder`).then((r) => r.rows),
  done: (id: string) => api.post<{ row: LadderRow }>(`/ladder/${encodeURIComponent(id)}/done`).then((r) => r.row),
  skip: (id: string, note = "") => api.post<{ row: LadderRow }>(`/ladder/${encodeURIComponent(id)}/skip`, { note }).then((r) => r.row),
  /** Sets the https link a step carries, or clears it with null. */
  setLink: (id: string, link: string | null) => api.put<{ row: LadderRow }>(`/ladder/${encodeURIComponent(id)}/link`, { link }).then((r) => r.row),
  /** Starts a case study post for the client in the Studio (Plan 15, Task 9). */
  startCaseStudy: (businessId: string) => api.post<unknown>(`/studio`, { kind: "case_study", businessId }),
};

/** The auto-approve routes (Plan 15): which two fixed reminders may go without a click, and what went. Switching a rule answers with the whole page's data. */
export const autoApproveApi = {
  get: () => api.get<AutoApproveState>("/auto-approve"),
  set: (kind: string, enabled: boolean) => api.put<AutoApproveState>(`/auto-approve/${encodeURIComponent(kind)}`, { enabled }),
};

/** The Local SEO routes (Plan 14). A refusal is an ApiError whose message is a plain sentence; nothing here ever posts or publishes anywhere. Types only come from the worker. */
export const seoApi = {
  overview: (clientId: string) => api.get<SeoOverview>(`/clients/${encodeURIComponent(clientId)}/seo`),
  /** Google's best matches (five at most) for a business name and address. The owner picks one. */
  placeSearch: (clientId: string, name: string, address: string) => api.post<{ candidates: PlaceCandidate[] }>(`/clients/${encodeURIComponent(clientId)}/seo/place-search`, { name, address }).then((r) => r.candidates),
  saveProfile: (clientId: string, input: SeoProfileInput) => api.put<{ profile: SeoOverview["profile"]; citations: Citation[] }>(`/clients/${encodeURIComponent(clientId)}/seo/profile`, input),
  addKeyword: (clientId: string, term: string, town: string) => api.post<{ keyword: SeoKeyword; created: boolean }>(`/clients/${encodeURIComponent(clientId)}/seo/keywords`, { term, town }).then((r) => r.keyword),
  /** Switches a keyword off; its past rank checks stay. */
  switchOffKeyword: (clientId: string, keywordId: string) => api.del<{ keyword: SeoKeyword }>(`/clients/${encodeURIComponent(clientId)}/seo/keywords/${encodeURIComponent(keywordId)}`).then((r) => r.keyword),
  setCitation: (clientId: string, directory: string, patch: { status: CitationStatus; url?: string; note?: string }) =>
    api.put<{ citation: Citation; citations: Citation[] }>(`/clients/${encodeURIComponent(clientId)}/seo/citations/${encodeURIComponent(directory)}`, patch).then((r) => r.citations),
  napCheck: (clientId: string) => api.post<{ nap: NapResult }>(`/clients/${encodeURIComponent(clientId)}/seo/nap-check`).then((r) => r.nap),
  baseline: (clientId: string) => api.post<{ snapshot: GbpSnapshot | null; nap: NapResult | null; napNote: string | null; ranked: number }>(`/clients/${encodeURIComponent(clientId)}/seo/baseline`),
  rankCheck: (clientId: string) => api.post<{ checked: number; unmeasured: number }>(`/clients/${encodeURIComponent(clientId)}/seo/rank-check`),
  /** Starts last month's report now. 409 with a plain sentence when there is no usable rank check yet. */
  buildReport: (clientId: string) => api.post<{ report: { id: string; status: string; period: string } }>(`/clients/${encodeURIComponent(clientId)}/seo/report`).then((r) => r.report),
  /** Logan's own words as the reply; nothing is sent anywhere. */
  saveDraft: (reviewId: string, draft: string) => api.put<{ review: SeoReview }>(`/seo/reviews/${encodeURIComponent(reviewId)}/draft`, { draft }).then((r) => r.review),
  /** "I posted it": Logan says he put the reply on Google himself. */
  markPosted: (reviewId: string) => api.post<{ review: SeoReview }>(`/seo/reviews/${encodeURIComponent(reviewId)}/posted`).then((r) => r.review),
  skipReview: (reviewId: string) => api.post<{ review: SeoReview }>(`/seo/reviews/${encodeURIComponent(reviewId)}/skip`).then((r) => r.review),
  editContent: (id: string, words: SeoContentEdit) => api.put<{ content: ContentItem }>(`/seo/content/${encodeURIComponent(id)}`, words).then((r) => r.content),
  approveContent: (id: string) => api.post<{ content: ContentItem }>(`/seo/content/${encodeURIComponent(id)}/approve`).then((r) => r.content),
  /** "I put it on the site": the app publishes nothing. The address is optional and must be https. */
  markPublished: (id: string, url?: string) => api.post<{ content: ContentItem }>(`/seo/content/${encodeURIComponent(id)}/published`, url ? { url } : {}).then((r) => r.content),
  rejectContent: (id: string, reason: string) => api.post<{ content: ContentItem }>(`/seo/content/${encodeURIComponent(id)}/reject`, { reason }).then((r) => r.content),
  /** One client's reports, newest month first, each with its link when it has one. */
  clientReports: (clientId: string) => api.get<{ reports: SeoReportRow[] }>(`/seo/reports?clientId=${encodeURIComponent(clientId)}`).then((r) => r.reports),
  editReport: (id: string, words: { summary: string; recommendation: string; priorities: string[] }) => api.put<{ report: SeoReportRow }>(`/seo/reports/${encodeURIComponent(id)}`, words).then((r) => r.report),
  revokeReport: (id: string) => api.post<{ report: SeoReportRow }>(`/seo/reports/${encodeURIComponent(id)}/revoke`).then((r) => r.report),
  board: () => api.get<{ period: string; rows: SeoBoardRow[] }>("/seo/board"),
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

/** The client's strategy memo (`/y/<token>`): `{ status, page }`, `page` only for a 200. A dropped connection is `status` 0. Public: no cookie is sent. */
export async function publicStrategyMemo(token: string): Promise<{ status: number; page: PublicMemo | null }> {
  try {
    const res = await fetch(`/api/public/y/${token}`, { credentials: "omit", cache: "no-store" });
    return { status: res.status, page: res.ok ? ((await res.json()) as PublicMemo) : null };
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
