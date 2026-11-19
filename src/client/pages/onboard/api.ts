import { createPacer, REQUEST_GAP_MS, unloadPlan, writeOutcome, type Outcome, type PublicOnboarding, type UnloadPlan, type WriteKind } from "../../onboardView";

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
  saveAnswers(answers: Record<string, string>): Promise<Outcome>;
  submit(): Promise<Outcome>;
  saveText(itemId: string, text: string): Promise<Outcome>;
  upload(itemId: string, file: File): Promise<{ outcome: Outcome; file?: SavedFile }>;
  removeFile(fileId: string): Promise<Outcome>;
  /** What to do with the answers waiting when the tab goes away (see `unloadPlan`). */
  answersUnload(pending: Record<string, string>, inFlight: Record<string, string> | null): UnloadPlan;
  /** The same for one item's text. */
  textUnload(itemId: string, pending: string, inFlight: string | null): UnloadPlan;
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
    saveAnswers: (answers) => paced(async () => (await send(`${base}/answers`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ answers }) }, "answers")).outcome),
    submit: () => paced(async () => (await send(`${base}/submit`, { method: "POST" }, "submit")).outcome),
    saveText: (itemId, text) =>
      paced(async () => (await send(`${base}/items/${encodeURIComponent(itemId)}/text`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ text }) }, "text")).outcome),
    upload: (itemId, file) => paced(async () => {
      const form = new FormData();
      form.append("file", file);
      const { outcome, body } = await send(`${base}/items/${encodeURIComponent(itemId)}/files`, { method: "POST", body: form }, "file");
      return { outcome, file: outcome.kind === "ok" ? savedFile(body?.file) : undefined };
    }),
    removeFile: (fileId) => paced(async () => (await send(`${base}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }, "delete")).outcome),
    answersUnload: (pending, inFlight) => unloadPlan(pending, inFlight, `${base}/answers`, (a) => ({ answers: a })),
    textUnload: (itemId, pending, inFlight) => unloadPlan(pending, inFlight, `${base}/items/${encodeURIComponent(itemId)}/text`, (text) => ({ text })),
    sendNow: async (plan, kind) => (await send(plan.url, { method: plan.method, headers: JSON_HEADERS, body: plan.body, keepalive: true }, kind)).outcome,
  };
}
