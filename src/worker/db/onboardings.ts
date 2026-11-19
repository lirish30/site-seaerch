import { newClientToken } from "../documents/token";

export type OnboardingKind = "build" | "light";
export type ItemKind = "text" | "files";
export type ItemStatus = "waiting" | "received" | "accepted" | "not_applicable";

export interface Onboarding {
  id: string; businessId: string; dealId: string; documentId: string; kind: OnboardingKind; test: boolean; token: string; revokedAt: string | null;
  welcomeVideoUrl: string | null; welcomeSentAt: string | null; questionnaireDueAt: string | null; questionnaireSubmittedAt: string | null; kickoffAt: string | null;
  lastClientActivityAt: string | null; closedAt: string | null; createdAt: string; updatedAt: string;
}
export interface OnboardingItem {
  id: string; onboardingId: string; key: string; label: string; instructions: string; kind: ItemKind; phase: 1 | 2; dueAt: string | null; status: ItemStatus;
  textValue: string | null; custom: boolean; position: number; updatedAt: string;
}
export type NewItem = Pick<OnboardingItem, "key" | "label" | "instructions" | "kind" | "phase">;
export interface OnboardingFile { id: string; itemId: string; r2Key: string; fileName: string; contentType: string; sizeBytes: number; uploadedAt: string }

interface Row {
  id: string; business_id: string; deal_id: string; document_id: string; kind: OnboardingKind; test: number; token: string; revoked_at: string | null;
  welcome_video_url: string | null; welcome_sent_at: string | null; questionnaire_due_at: string | null; questionnaire_submitted_at: string | null; kickoff_at: string | null;
  last_client_activity_at: string | null; closed_at: string | null; created_at: string; updated_at: string;
}
interface ItemRow {
  id: string; onboarding_id: string; key: string; label: string; instructions: string; kind: ItemKind; phase: 1 | 2; due_at: string | null; status: ItemStatus;
  text_value: string | null; custom: number; position: number; updated_at: string;
}
interface FileRow { id: string; item_id: string; r2_key: string; file_name: string; content_type: string; size_bytes: number; uploaded_at: string }

const toOnboarding = (r: Row): Onboarding => ({
  id: r.id, businessId: r.business_id, dealId: r.deal_id, documentId: r.document_id, kind: r.kind, test: !!r.test, token: r.token, revokedAt: r.revoked_at,
  welcomeVideoUrl: r.welcome_video_url, welcomeSentAt: r.welcome_sent_at, questionnaireDueAt: r.questionnaire_due_at, questionnaireSubmittedAt: r.questionnaire_submitted_at,
  kickoffAt: r.kickoff_at, lastClientActivityAt: r.last_client_activity_at, closedAt: r.closed_at, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toItem = (r: ItemRow): OnboardingItem => ({
  id: r.id, onboardingId: r.onboarding_id, key: r.key, label: r.label, instructions: r.instructions, kind: r.kind, phase: r.phase, dueAt: r.due_at, status: r.status,
  textValue: r.text_value, custom: !!r.custom, position: r.position, updatedAt: r.updated_at,
});
const toFile = (r: FileRow): OnboardingFile => ({
  id: r.id, itemId: r.item_id, r2Key: r.r2_key, fileName: r.file_name, contentType: r.content_type, sizeBytes: r.size_bytes, uploadedAt: r.uploaded_at,
});

const nowIso = () => new Date().toISOString();
/** An item the owner has accepted or marked not applicable keeps that status when the client changes what they gave. */
const KEEP_STATUS = `status IN ('accepted', 'not_applicable')`;

export async function getOnboarding(db: D1Database, id: string): Promise<Onboarding | null> {
  const r = await db.prepare(`SELECT * FROM onboardings WHERE id = ?`).bind(id).first<Row>();
  return r ? toOnboarding(r) : null;
}

/** The onboarding a client's link opens: null when the link was revoked (or never existed). */
export async function getOnboardingByToken(db: D1Database, token: string): Promise<Onboarding | null> {
  const r = await db.prepare(`SELECT * FROM onboardings WHERE token = ? AND revoked_at IS NULL`).bind(token).first<Row>();
  return r ? toOnboarding(r) : null;
}

export async function getOnboardingForDeal(db: D1Database, dealId: string): Promise<Onboarding | null> {
  const r = await db.prepare(`SELECT * FROM onboardings WHERE deal_id = ?`).bind(dealId).first<Row>();
  return r ? toOnboarding(r) : null;
}

/** Every onboarding that is not closed, oldest first. A revoked link does not take one off the list (the owner still works it). */
export async function listOpenOnboardings(db: D1Database): Promise<Onboarding[]> {
  return (await db.prepare(`SELECT * FROM onboardings WHERE closed_at IS NULL ORDER BY created_at, id`).all<Row>()).results.map(toOnboarding);
}

/** Whether the lead has an onboarding: a lead that does is archived, never deleted. */
export async function hasOnboarding(db: D1Database, businessId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM onboardings WHERE business_id = ? LIMIT 1`).bind(businessId).first());
}

export async function listItems(db: D1Database, id: string): Promise<OnboardingItem[]> {
  return (await db.prepare(`SELECT * FROM onboarding_items WHERE onboarding_id = ? ORDER BY position, id`).bind(id).all<ItemRow>()).results.map(toItem);
}

export async function listFiles(db: D1Database, itemId: string): Promise<OnboardingFile[]> {
  return (await db.prepare(`SELECT * FROM onboarding_files WHERE item_id = ? ORDER BY uploaded_at, id`).bind(itemId).all<FileRow>()).results.map(toFile);
}

/**
 * Starts the onboarding for a deal, with its items, in one batch. A deal has one: a second call returns the existing row with `created: false`
 * and adds nothing (the items are inserted only when this call's own row took, so a race cannot add them twice).
 */
export async function createOnboarding(db: D1Database, o: {
  businessId: string; dealId: string; documentId: string; kind: OnboardingKind; test: boolean; items: NewItem[];
}): Promise<{ onboarding: Onboarding; created: boolean }> {
  const id = crypto.randomUUID();
  const now = nowIso();
  const res = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO onboardings (id, business_id, deal_id, document_id, kind, test, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, o.businessId, o.dealId, o.documentId, o.kind, o.test ? 1 : 0, newClientToken(), now, now),
    ...o.items.map((it, position) =>
      db.prepare(
        `INSERT INTO onboarding_items (id, onboarding_id, key, label, instructions, kind, phase, status, custom, position, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'waiting', 0, ?, ? WHERE EXISTS (SELECT 1 FROM onboardings WHERE id = ?)`,
      ).bind(crypto.randomUUID(), id, it.key, it.label, it.instructions, it.kind, it.phase, position, now, id)),
  ]);
  if ((res[0].meta.changes ?? 0) === 1) return { onboarding: (await getOnboarding(db, id))!, created: true };
  return { onboarding: (await getOnboardingForDeal(db, o.dealId))!, created: false };
}

export async function getAnswers(db: D1Database, id: string): Promise<Record<string, string>> {
  const rows = (await db.prepare(`SELECT question_id, answer FROM onboarding_answers WHERE onboarding_id = ?`).bind(id).all<{ question_id: string; answer: string }>()).results;
  return Object.fromEntries(rows.map((r) => [r.question_id, r.answer]));
}

/** Saves the answers (one row per question, replacing an earlier answer) and notes that the client was here, in one batch. */
export async function saveAnswers(db: D1Database, id: string, answers: Record<string, string>, now: string): Promise<void> {
  await db.batch([
    ...Object.entries(answers).map(([q, a]) =>
      db.prepare(
        `INSERT INTO onboarding_answers (onboarding_id, question_id, answer, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (onboarding_id, question_id) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at`,
      ).bind(id, q, a, now)),
    db.prepare(`UPDATE onboardings SET last_client_activity_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, id),
  ]);
}

/** Marks the questionnaire handed in. "submitted" the first time, "already" after that (the first time stays on record). */
export async function submitQuestionnaire(db: D1Database, id: string, now: string): Promise<"submitted" | "already"> {
  const res = await db.prepare(
    `UPDATE onboardings SET questionnaire_submitted_at = ?, last_client_activity_at = ?, updated_at = ? WHERE id = ? AND questionnaire_submitted_at IS NULL`,
  ).bind(now, now, now, id).run();
  return (res.meta.changes ?? 0) === 1 ? "submitted" : "already";
}

/**
 * Records that the welcome email went out: when, the questionnaire's due date, and each item's due date by phase. True only the first time.
 * One batch: the items are set first, and only while the welcome is still unsent, so a second call changes nothing.
 */
export async function markWelcomeSent(db: D1Database, id: string, o: { sentAt: string; questionnaireDueAt: string; phaseDue: { 1: string; 2: string } }): Promise<boolean> {
  const unsent = `EXISTS (SELECT 1 FROM onboardings WHERE id = ? AND welcome_sent_at IS NULL)`;
  const res = await db.batch([
    ...([1, 2] as const).map((phase) =>
      db.prepare(`UPDATE onboarding_items SET due_at = ?, updated_at = ? WHERE onboarding_id = ? AND phase = ? AND ${unsent}`).bind(o.phaseDue[phase], o.sentAt, id, phase, id)),
    db.prepare(
      `UPDATE onboardings SET welcome_sent_at = ?, questionnaire_due_at = ?, last_client_activity_at = ?, updated_at = ? WHERE id = ? AND welcome_sent_at IS NULL`,
    ).bind(o.sentAt, o.questionnaireDueAt, o.sentAt, o.sentAt, id),
  ]);
  return (res[2].meta.changes ?? 0) === 1;
}

/** Stores the text as given. The item is `received` when there is text, `waiting` when it was emptied, unless the owner already accepted it or marked it not applicable. */
export async function saveItemText(db: D1Database, itemId: string, text: string, now: string): Promise<void> {
  await db.prepare(
    `UPDATE onboarding_items SET text_value = ?, updated_at = ?,
       status = CASE WHEN ${KEEP_STATUS} THEN status WHEN ? <> '' THEN 'received' ELSE 'waiting' END
     WHERE id = ?`,
  ).bind(text, now, text, itemId).run();
}

/** Records an uploaded file (the bytes are already in R2 under r2Key). The item becomes `received` unless the owner already settled it. */
export async function addFile(db: D1Database, f: Omit<OnboardingFile, "uploadedAt"> & { now: string }): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO onboarding_files (id, item_id, r2_key, file_name, content_type, size_bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(f.id, f.itemId, f.r2Key, f.fileName, f.contentType, f.sizeBytes, f.now),
    db.prepare(`UPDATE onboarding_items SET status = CASE WHEN ${KEEP_STATUS} THEN status ELSE 'received' END, updated_at = ? WHERE id = ?`).bind(f.now, f.itemId),
  ]);
}

/** Removes a file's row and returns it (so the caller can delete the R2 object). The item goes back to `waiting` when that was its last file and it was only `received`. Null when there is no such file. */
export async function removeFile(db: D1Database, fileId: string): Promise<OnboardingFile | null> {
  const r = await db.prepare(`SELECT * FROM onboarding_files WHERE id = ?`).bind(fileId).first<FileRow>();
  if (!r) return null;
  await db.batch([
    db.prepare(`DELETE FROM onboarding_files WHERE id = ?`).bind(fileId),
    db.prepare(
      `UPDATE onboarding_items SET status = 'waiting', updated_at = ?
       WHERE id = ? AND status = 'received' AND kind = 'files' AND NOT EXISTS (SELECT 1 FROM onboarding_files WHERE item_id = ?)`,
    ).bind(nowIso(), r.item_id, r.item_id),
  ]);
  return toFile(r);
}

export async function setItemStatus(db: D1Database, itemId: string, s: ItemStatus): Promise<void> {
  await db.prepare(`UPDATE onboarding_items SET status = ?, updated_at = ? WHERE id = ?`).bind(s, nowIso(), itemId).run();
}

/** An item the owner adds by hand, last in the list. The key must be new for this onboarding. */
export async function addCustomItem(db: D1Database, id: string, i: NewItem & { dueAt: string | null }): Promise<OnboardingItem> {
  const itemId = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO onboarding_items (id, onboarding_id, key, label, instructions, kind, phase, due_at, status, custom, position, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', 1, COALESCE(MAX(position), -1) + 1, ? FROM onboarding_items WHERE onboarding_id = ?`,
  ).bind(itemId, id, i.key, i.label, i.instructions, i.kind, i.phase, i.dueAt, nowIso(), id).run();
  return toItem((await db.prepare(`SELECT * FROM onboarding_items WHERE id = ?`).bind(itemId).first<ItemRow>())!);
}

/** The client was here (opened the page, saved something). */
export async function touchClient(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare(`UPDATE onboardings SET last_client_activity_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, id).run();
}

/** Sets the fields the owner edits. A field left out is not touched; null clears it. */
export async function setOwnerFields(db: D1Database, id: string, f: { welcomeVideoUrl?: string | null; kickoffAt?: string | null }): Promise<Onboarding> {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (f.welcomeVideoUrl !== undefined) { sets.push("welcome_video_url = ?"); vals.push(f.welcomeVideoUrl); }
  if (f.kickoffAt !== undefined) { sets.push("kickoff_at = ?"); vals.push(f.kickoffAt); }
  if (sets.length) await db.prepare(`UPDATE onboardings SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...vals, nowIso(), id).run();
  return (await getOnboarding(db, id))!;
}

/** Turns the client's link off (revoked_at = now) or back on (cleared). */
export async function setRevoked(db: D1Database, id: string, on: boolean, now: string): Promise<Onboarding> {
  await db.prepare(`UPDATE onboardings SET revoked_at = ?, updated_at = ? WHERE id = ?`).bind(on ? now : null, now, id).run();
  return (await getOnboarding(db, id))!;
}

/** A new link: the token is replaced (the old one is dead at once) and a revoked onboarding is live again. */
export async function newToken(db: D1Database, id: string): Promise<Onboarding> {
  await db.prepare(`UPDATE onboardings SET token = ?, revoked_at = NULL, updated_at = ? WHERE id = ?`).bind(newClientToken(), nowIso(), id).run();
  return (await getOnboarding(db, id))!;
}

/** Closes the onboarding. The first close stays on record. */
export async function closeOnboarding(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare(`UPDATE onboardings SET closed_at = ?, updated_at = ? WHERE id = ? AND closed_at IS NULL`).bind(now, now, id).run();
}

/** Claims a reminder: true only for the first insert of this (onboarding, key), so each reminder is raised once. */
export async function recordNudge(db: D1Database, id: string, key: string, now: string): Promise<boolean> {
  const res = await db.prepare(`INSERT OR IGNORE INTO onboarding_nudges (onboarding_id, key, created_at) VALUES (?, ?, ?)`).bind(id, key, now).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function attachNudgeApproval(db: D1Database, id: string, key: string, approvalId: string): Promise<void> {
  await db.prepare(`UPDATE onboarding_nudges SET approval_id = ? WHERE onboarding_id = ? AND key = ?`).bind(approvalId, id, key).run();
}

/** Drops a claimed reminder (its approval could not be raised), so a later run tries again. */
export async function forgetNudge(db: D1Database, id: string, key: string): Promise<void> {
  await db.prepare(`DELETE FROM onboarding_nudges WHERE onboarding_id = ? AND key = ?`).bind(id, key).run();
}
