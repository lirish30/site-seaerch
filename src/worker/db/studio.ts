// The Studio's posts (Plan 15): a before and after, an audit tip or a case study, from a draft to posted.
// Times (`now`, `createdAt`, `updatedAt`, `agreedAt`) are UTC ISO strings with milliseconds. `postedOn` is a local date (YYYY-MM-DD) the caller worked out in the booking zone.
// `source` and `copy` are JSON the callers shape; they are stored as given and read back as parsed (an unreadable value reads as `{}`).

export type StudioKind = "before_after" | "audit_tip" | "case_study";
export type StudioStatus = "draft" | "writing" | "review" | "approved" | "posted" | "discarded";

export interface StudioPost {
  id: string; kind: StudioKind; status: StudioStatus; businessId: string | null; source: unknown; anonymize: boolean; agreedAt: string | null; copy: unknown; imageKeys: string[];
  claudeTaskId: string | null; approvalId: string | null; postedOn: string | null; createdAt: string; updatedAt: string;
}

interface Row {
  id: string; kind: StudioKind; status: StudioStatus; business_id: string | null; source: string; anonymize: number; agreed_at: string | null; copy: string; image_keys: string;
  claude_task_id: string | null; approval_id: string | null; posted_on: string | null; created_at: string; updated_at: string;
}

const parseJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return {}; } };
const parseKeys = (s: string): string[] => {
  try { const v: unknown = JSON.parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};

const toPost = (r: Row): StudioPost => ({
  id: r.id, kind: r.kind, status: r.status, businessId: r.business_id, source: parseJson(r.source), anonymize: !!r.anonymize, agreedAt: r.agreed_at, copy: parseJson(r.copy), imageKeys: parseKeys(r.image_keys),
  claudeTaskId: r.claude_task_id, approvalId: r.approval_id, postedOn: r.posted_on, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Makes a post in `draft`. */
export async function createPost(db: D1Database, p: { kind: StudioKind; businessId?: string | null; source: unknown; anonymize: boolean }, now: string): Promise<StudioPost> {
  const r = await db.prepare(
    `INSERT INTO studio_posts (id, kind, business_id, source, anonymize, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(crypto.randomUUID(), p.kind, p.businessId ?? null, JSON.stringify(p.source ?? {}), p.anonymize ? 1 : 0, now, now).first<Row>();
  return toPost(r!);
}

export async function getPost(db: D1Database, id: string): Promise<StudioPost | null> {
  const r = await db.prepare(`SELECT * FROM studio_posts WHERE id = ?`).bind(id).first<Row>();
  return r ? toPost(r) : null;
}

/** The posts, newest first; `status` limits them to those states. */
export async function listPosts(db: D1Database, o: { status?: StudioStatus[] } = {}): Promise<StudioPost[]> {
  const status = o.status ?? [];
  if (o.status && status.length === 0) return [];
  const where = status.length ? ` WHERE status IN (${status.map(() => "?").join(",")})` : "";
  const rows = (await db.prepare(`SELECT * FROM studio_posts${where} ORDER BY created_at DESC, rowid DESC`).bind(...status).all<Row>()).results;
  return rows.map(toPost);
}

/** The patchable post fields and their columns; `copy` and `imageKeys` are stored as JSON, `anonymize` as 0 or 1. */
const COLUMNS = {
  status: "status", copy: "copy", imageKeys: "image_keys", claudeTaskId: "claude_task_id", approvalId: "approval_id", postedOn: "posted_on", anonymize: "anonymize", agreedAt: "agreed_at",
} as const;

/** Changes the fields in `p` (a field left out, or undefined, is not touched; null clears a nullable one) in one statement and stamps `updated_at` `now`. Null when there is no such post. */
export async function patchPost(
  db: D1Database, id: string, p: Partial<Pick<StudioPost, "status" | "copy" | "imageKeys" | "claudeTaskId" | "approvalId" | "postedOn" | "anonymize" | "agreedAt">>, now: string,
): Promise<StudioPost | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [key, col] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
    const v = p[key];
    if (v === undefined) continue;
    sets.push(`${col} = ?`);
    binds.push(key === "copy" || key === "imageKeys" ? JSON.stringify(v) : key === "anonymize" ? (v ? 1 : 0) : v);
  }
  sets.push(`updated_at = ?`);
  binds.push(now, id);
  const r = await db.prepare(`UPDATE studio_posts SET ${sets.join(", ")} WHERE id = ? RETURNING *`).bind(...binds).first<Row>();
  return r ? toPost(r) : null;
}
