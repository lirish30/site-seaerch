import { createPacer, REQUEST_GAP_MS, unloadPlan, writeOutcome, type Outcome, type PublicOnboarding, type UnloadPlan, type UnloadState, type WriteKind } from "../../onboardView";

/** Asked when the pacer lets a request go: true to send (and note that the fetch has started), false when the request was stood down. */
export type Gate = () => boolean;

/** What a request answers with when it was stood down: nothing was sent, and the caller does not act on it. */
const STOOD_DOWN: Outcome = { kind: "ok" };

/** What a file the server took looks like. */
export interface SavedFile { id: string; fileName: string; sizeBytes: number }

export interface LoadResult {
  /** 0 for a dropped connection. */
  status: number;
  page: PublicOnboarding | null;
}

/** Everything the page asks the server. One instance per link: all of its requests share one pacer, which spaces them out under the per-link limit. */
export interface OnboardApi {
  load(): Promise<LoadResult>;
  /** Same as `load`, but in the pacer's line behind whatever else is waiting. For the quiet refetch after a save. */
  refresh(): Promise<LoadResult>;
  /** `gate` is asked at the moment the pacer lets the request go: false stands the request down (nothing is fetched). It also marks the fetch as started. */
  saveAnswers(answers: Record<string, string>, gate?: Gate): Promise<Outcome>;
  submit(): Promise<Outcome>;
  saveText(itemId: string, text: string, gate?: Gate): Promise<Outcome>;
  upload(itemId: string, file: File): Promise<{ outcome: Outcome; file?: SavedFile }>;
  removeFile(fileId: string): Promise<Outcome>;
  /** What to do with the answers waiting when the tab goes away (see `unloadPlan`). */
  answersUnload(s: UnloadState<Record<string, string>>): UnloadPlan;
  /** The same for one item's text. */
  textUnload(itemId: string, s: UnloadState<string>): UnloadPlan;
  /** Sends a `keepalive` plan at once, outside the pacer: a closing or frozen tab would never get through the pacer's wait. */
  sendNow(plan: Extract<UnloadPlan, { action: "keepalive" }>, kind: "answers" | "text"): Promise<Outcome>;
}

type Body = { error?: unknown; fields?: unknown; file?: unknown } | null;

// Public pages bypass api.ts, whose 401 handling redirects to /login. No cookies are sent or needed: the link itself is the key.
async function send(url: string, init: RequestInit, kind: WriteKind): Promise<{ outcome: Outcome; body: Body }> {
  try {
    const res = await fetch(url, { ...init, credentials: "omit" });
    let body: Body = null;
    try { body = (await res.json()) as Body; } catch { /* no body */ }
    return { outcome: writeOutcome(res.status, body, res.headers.get("retry-after"), kind), body };
  } catch {
    return { outcome: writeOutcome(0, null, null, kind), body: null };
  }
}

const JSON_HEADERS = { "content-type": "application/json" };

async function fetchPage(url: string): Promise<LoadResult> {
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return { status: res.status, page: null };
    return { status: res.status, page: (await res.json()) as PublicOnboarding };
  } catch {
    return { status: 0, page: null };
  }
}

const savedFile = (b: unknown): SavedFile | undefined => {
  const f = b as Partial<SavedFile> | null;
  return f && typeof f.id === "string" && typeof f.fileName === "string" && typeof f.sizeBytes === "number" ? { id: f.id, fileName: f.fileName, sizeBytes: f.sizeBytes } : undefined;
};

export function makeApi(token: string): OnboardApi {
  const base = `/api/public/o/${token}`;
  const paced = createPacer(REQUEST_GAP_MS);
  return {
    load: () => fetchPage(base),
    refresh: () => paced(() => fetchPage(base)),
    saveAnswers: (answers, gate) => paced(async () => {
      if (gate && !gate()) return STOOD_DOWN;
      return (await send(`${base}/answers`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ answers }) }, "answers")).outcome;
    }),
    submit: () => paced(async () => (await send(`${base}/submit`, { method: "POST" }, "submit")).outcome),
    saveText: (itemId, text, gate) => paced(async () => {
      if (gate && !gate()) return STOOD_DOWN;
      return (await send(`${base}/items/${encodeURIComponent(itemId)}/text`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ text }) }, "text")).outcome;
    }),
    upload: (itemId, file) => paced(async () => {
      const form = new FormData();
      form.append("file", file);
      const { outcome, body } = await send(`${base}/items/${encodeURIComponent(itemId)}/files`, { method: "POST", body: form }, "file");
      return { outcome, file: outcome.kind === "ok" ? savedFile(body?.file) : undefined };
    }),
    removeFile: (fileId) => paced(async () => (await send(`${base}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }, "delete")).outcome),
    answersUnload: (s) => unloadPlan({ ...s, url: `${base}/answers`, bodyOf: (a) => ({ answers: a }), merge: (older, newer) => ({ ...older, ...newer }) }),
    textUnload: (itemId, s) => unloadPlan({ ...s, url: `${base}/items/${encodeURIComponent(itemId)}/text`, bodyOf: (text) => ({ text }) }),
    sendNow: async (plan, kind) => (await send(plan.url, { method: plan.method, headers: JSON_HEADERS, body: plan.body, keepalive: true }, kind)).outcome,
  };
}
