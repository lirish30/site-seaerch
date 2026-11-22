import type { PackageKey } from "./packages";
import { SEED_SOPS } from "../sop/seeds";
import { SopTemplateInputSchema, validateTemplate, type Cadence, type MilestoneKey, type OwnerTag, type SopStep, type SopTemplate, type SopTemplateInput } from "../sop/model";

/** The problems found with a template that was refused (plain sentences). Nothing was saved. */
export class SopInputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
    this.name = "SopInputError";
  }
}

interface TemplateRow {
  id: string; key: string; name: string; kind: "project" | "recurring"; cadence: Cadence | null; cadence_day: number | null;
  applies_to: string; version: number; active: number; updated_at: string;
}
interface StepRow {
  template_id: string; key: string; phase_key: string; phase_title: string; position: number; title: string; owner: OwnerTag; est_minutes: number;
  done_when: string; doc_template: string | null; email_template: string | null; requires: string; milestone: MilestoneKey | null;
  client_summary: string | null; skippable: number;
}

const stringList = (s: string): string[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };
const toStep = (r: StepRow): SopStep => ({
  key: r.key, phaseKey: r.phase_key, phaseTitle: r.phase_title, position: r.position, title: r.title, owner: r.owner, estMinutes: r.est_minutes,
  doneWhen: r.done_when, docTemplate: r.doc_template, emailTemplate: r.email_template, requires: stringList(r.requires), milestone: r.milestone,
  clientSummary: r.client_summary, skippable: !!r.skippable,
});
const toTemplate = (r: TemplateRow, steps: SopStep[]): SopTemplate => ({
  id: r.id, key: r.key, name: r.name, kind: r.kind, cadence: r.cadence, cadenceDay: r.cadence_day, appliesTo: stringList(r.applies_to) as PackageKey[],
  version: r.version, active: !!r.active, steps, updatedAt: r.updated_at,
});

/** Templates are listed in the order they were first saved (the catalog order). `where` refers to the template as `t`. */
async function load(db: D1Database, where: string, binds: unknown[]): Promise<SopTemplate[]> {
  const rows = (await db.prepare(`SELECT t.* FROM sop_templates t ${where} ORDER BY t.rowid`).bind(...binds).all<TemplateRow>()).results;
  if (!rows.length) return [];
  const stepRows = (await db.prepare(
    `SELECT s.* FROM sop_template_steps s JOIN sop_templates t ON t.id = s.template_id ${where} ORDER BY s.template_id, s.position`,
  ).bind(...binds).all<StepRow>()).results;
  const byTemplate = new Map<string, SopStep[]>();
  for (const s of stepRows) byTemplate.set(s.template_id, [...(byTemplate.get(s.template_id) ?? []), toStep(s)]);
  return rows.map((r) => toTemplate(r, byTemplate.get(r.id) ?? []));
}

export async function listTemplates(db: D1Database, o: { includeInactive?: boolean } = {}): Promise<SopTemplate[]> {
  return load(db, o.includeInactive ? "" : "WHERE t.active = 1", []);
}

export async function getTemplate(db: D1Database, key: string): Promise<SopTemplate | null> {
  return (await load(db, "WHERE t.key = ?", [key]))[0] ?? null;
}

const nowIso = () => new Date().toISOString();

const insertStep = (db: D1Database, whereSql: string, whereBind: unknown[], s: SopStep) =>
  db.prepare(
    `INSERT INTO sop_template_steps (template_id, key, phase_key, phase_title, position, title, owner, est_minutes, done_when, doc_template, email_template, requires, milestone, client_summary, skippable)
     SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM sop_templates WHERE ${whereSql}`,
  ).bind(
    s.key, s.phaseKey, s.phaseTitle, s.position, s.title, s.owner, s.estMinutes, s.doneWhen, s.docTemplate, s.emailTemplate, JSON.stringify(s.requires), s.milestone,
    s.clientSummary, s.skippable ? 1 : 0, ...whereBind,
  );

/**
 * Saves a template in one batch: a new key is inserted at version 1; an existing key has its steps replaced and its version raised by one.
 * A template with problems is refused with a `SopInputError` and nothing changes.
 */
export async function saveTemplate(db: D1Database, input: SopTemplateInput): Promise<SopTemplate> {
  const parsed = SopTemplateInputSchema.safeParse(input);
  if (!parsed.success) throw new SopInputError(parsed.error.issues.map((i) => i.message));
  const t: SopTemplateInput = parsed.data;
  const problems = validateTemplate(t);
  if (problems.length) throw new SopInputError(problems);

  const now = nowIso();
  await db.batch([
    db.prepare(
      `INSERT INTO sop_templates (id, key, name, kind, cadence, cadence_day, applies_to, version, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET name = excluded.name, kind = excluded.kind, cadence = excluded.cadence, cadence_day = excluded.cadence_day,
         applies_to = excluded.applies_to, active = excluded.active, version = sop_templates.version + 1, updated_at = excluded.updated_at`,
    ).bind(crypto.randomUUID(), t.key, t.name, t.kind, t.cadence, t.cadenceDay, JSON.stringify(t.appliesTo), t.active ? 1 : 0, now, now),
    db.prepare(`DELETE FROM sop_template_steps WHERE template_id = (SELECT id FROM sop_templates WHERE key = ?)`).bind(t.key),
    ...t.steps.map((s) => insertStep(db, `key = ?`, [t.key], s)),
  ]);
  return (await getTemplate(db, t.key))!;
}

/** Turns a template on or off. Returns false when there is no such key. An inactive template is not offered for new projects; existing projects keep their tasks. */
export async function setTemplateActive(db: D1Database, key: string, on: boolean): Promise<boolean> {
  const res = await db.prepare(`UPDATE sop_templates SET active = ?, updated_at = ? WHERE key = ?`).bind(on ? 1 : 0, nowIso(), key).run();
  return (res.meta.changes ?? 0) === 1;
}

/** Project-kind templates that are checklists, never started as a project (CARE-5, the incident checklist a fix task copies, and CARE-3, the edit request one). */
const CHECKLIST_ONLY: readonly string[] = ["CARE-5", "CARE-3"];

/** The active project templates that apply to any of these packages, in catalog order. A checklist-only template is never one of them. */
export async function templatesForPackages(db: D1Database, keys: PackageKey[]): Promise<SopTemplate[]> {
  const want = new Set<string>(keys);
  return (await listTemplates(db)).filter((t) => t.kind === "project" && !CHECKLIST_ONLY.includes(t.key) && t.appliesTo.some((k) => want.has(k)));
}

/**
 * Inserts the built-in templates that are missing, by key. A template that exists (edited or not) is left alone. Returns how many were inserted.
 * Each template goes in as one batch whose steps are inserted only when this call's own row took, so a race cannot add them twice.
 */
export async function ensureSeedSops(db: D1Database): Promise<number> {
  let inserted = 0;
  for (const t of SEED_SOPS) {
    const id = crypto.randomUUID();
    const now = nowIso();
    const res = await db.batch([
      db.prepare(
        `INSERT INTO sop_templates (id, key, name, kind, cadence, cadence_day, applies_to, version, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (key) DO NOTHING`,
      ).bind(id, t.key, t.name, t.kind, t.cadence, t.cadenceDay, JSON.stringify(t.appliesTo), t.active ? 1 : 0, now, now),
      ...t.steps.map((s) => insertStep(db, `id = ?`, [id], s)),
    ]);
    if ((res[0].meta.changes ?? 0) === 1) inserted++;
  }
  return inserted;
}
