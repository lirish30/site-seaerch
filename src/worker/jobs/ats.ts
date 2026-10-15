import type { Fetcher } from "../crawler/crawl";
import type { Ats, RawPosting } from "../types";

export class AtsError extends Error {
  constructor(public kind: "not_found" | "http" | "bad_json", message: string) { super(message); }
}

/** A board token is put into a URL path, so it is limited to what real boards use: no slash, dot-dot, query, space or leading dash. */
export const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_POSTINGS = 500, MAX_TITLE = 120;

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
// Role links are rendered as <a href> and quoted in an AI prompt: only https, and no whitespace or control characters (real URLs are percent-encoded).
const link = (v: unknown): string | null => { const s = str(v); return s && /^https:\/\//i.test(s) && !/[\s\x00-\x1f\x7f]/.test(s) ? s : null; };
const why = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, " ").slice(0, 100);
// Titles are third-party text that ends up in an AI prompt: one line, bounded.
const title = (v: unknown): string | null => { const s = str(v)?.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE).trim(); return s || null; };
const iso = (v: unknown): string | null => {
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
};
const need = (v: unknown, what: string): unknown[] => { if (!Array.isArray(v)) throw new AtsError("bad_json", `${what}: unexpected response shape`); return v; };

function greenhouse(json: unknown): RawPosting[] {
  return need(rec(json)?.jobs, "greenhouse").flatMap((j) => {
    const o = rec(j), id = o?.id, t = title(o?.title), url = link(o?.absolute_url);
    if (!o || (typeof id !== "number" && typeof id !== "string") || !t || !url) return [];
    return [{ externalId: String(id), title: t, url, location: str(rec(o.location)?.name), department: null, postedAt: iso(o.first_published) }];
  });
}
function lever(json: unknown): RawPosting[] {
  return need(json, "lever").flatMap((j) => {
    const o = rec(j), id = str(o?.id), t = title(o?.text), url = link(o?.hostedUrl);
    if (!o || !id || !t || !url) return [];
    const c = rec(o.categories);
    return [{ externalId: id, title: t, url, location: str(c?.location), department: str(c?.department) ?? str(c?.team), postedAt: iso(o.createdAt) }];
  });
}
function ashby(json: unknown): RawPosting[] {
  return need(rec(json)?.jobs, "ashby").flatMap((j) => {
    const o = rec(j), id = str(o?.id), t = title(o?.title), url = link(o?.jobUrl);
    if (!o || !id || !t || !url || o.isListed === false) return [];
    return [{ externalId: id, title: t, url, location: str(o.location), department: str(o.department) ?? str(o.team), postedAt: iso(o.publishedAt) }];
  });
}

const ENDPOINT: Record<Ats, (token: string) => string> = {
  greenhouse: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
  lever: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
  ashby: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
};
const PARSE: Record<Ats, (json: unknown) => RawPosting[]> = { greenhouse, lever, ashby };

/** Every public role on a board. Throws AtsError: not_found (no such board), http (any other failure), bad_json (not the shape we expect). */
export async function fetchPostings(ats: Ats, token: string, f: Fetcher, userAgent: string): Promise<RawPosting[]> {
  if (!TOKEN_RE.test(token)) throw new AtsError("not_found", "not a valid board name");
  let res: Response;
  try { res = await f(ENDPOINT[ats](token), { headers: { "user-agent": userAgent, accept: "application/json" }, signal: AbortSignal.timeout(10_000) }); }
  catch (e) { throw new AtsError("http", `${ats} request failed: ${why(e)}`); }
  if (res.status === 404) { await res.body?.cancel().catch(() => {}); throw new AtsError("not_found", `${ats} board "${token}" not found`); }
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new AtsError("http", `${ats} answered ${res.status}`); }
  // Reading the body can time out or drop (http); a body that arrives but does not parse is bad_json.
  let text: string;
  try { text = await res.text(); } catch (e) { throw new AtsError("http", `${ats} body read failed: ${why(e)}`); }
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new AtsError("bad_json", `${ats} did not return JSON`); }
  return PARSE[ats](json).slice(0, MAX_POSTINGS);
}
