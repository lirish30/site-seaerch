import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedBusiness } from "./fixtures/cro";

const T = "2026-12-03T10:00:00.000Z";

async function project(businessId: string, o: { documentId?: string | null; templateKey?: string | null } = {}) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO projects (id, business_id, document_id, kind, name, template_key, started_at, created_at, updated_at) VALUES (?, ?, ?, 'build', 'Site', ?, ?, ?, ?)`,
  ).bind(id, businessId, o.documentId ?? null, o.templateKey ?? null, T, T, T).run();
  return id;
}
async function task(projectId: string, businessId: string, o: { stepKey?: string | null; cadenceKey?: string | null; periodKey?: string | null } = {}) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO tasks (id, project_id, business_id, step_key, position, title, owner, cadence_key, period_key, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'T', 'claude', ?, ?, ?, ?)`,
  ).bind(id, projectId, businessId, o.stepKey ?? null, o.cadenceKey ?? null, o.periodKey ?? null, T, T).run();
  return id;
}
const entry = (taskId: string, projectId: string, businessId: string, source: "timer" | "manual", endedAt: string | null) =>
  env.DB.prepare(
    `INSERT INTO time_entries (id, task_id, project_id, business_id, started_at, ended_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), taskId, projectId, businessId, T, endedAt, source, T).run();

describe("the projects migration", () => {
  it("claude_tasks is indexed by the step a job is about, for failedJobCount, Today's capped count and the queue's close-by-target (M5)", async () => {
    const idx = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_claude_tasks_target'`).first<{ sql: string }>();
    expect(idx!.sql).toMatch(/claude_tasks\(target_id, target_type\)/);
    for (const sql of [
      `SELECT COUNT(*) FROM claude_tasks WHERE kind = ? AND target_id = ? AND status IN ('failed', 'expired')`,
      `SELECT 1 FROM claude_tasks c WHERE c.kind = ? AND c.target_id = ? AND c.status IN ('pending', 'claimed')`,
      `UPDATE claude_tasks SET status = 'stale' WHERE target_type = ? AND target_id = ? AND status IN ('pending', 'claimed')`,
    ]) {
      const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind("task", "x").all<{ detail: string }>()).results.map((r) => r.detail).join(" ");
      expect(plan, sql).toContain("idx_claude_tasks_target");
    }
  });

  it("settings gets work_config with the empty-object default", async () => {
    const r = await env.DB.prepare(`SELECT work_config FROM settings WHERE id = 1`).first<{ work_config: string }>();
    expect(r!.work_config).toBe("{}");
  });

  it("a project is unique per document and template, and hand-made ones are not limited", async () => {
    const b = await seedBusiness();
    // Without a real document the foreign key refuses, so the per-document guard is checked on the index definition below; hand-made projects (null document) repeat freely.
    await project(b.id);
    await project(b.id);
    const idx = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE name = 'uq_projects_document_template'`).first<{ sql: string }>();
    expect(idx!.sql).toMatch(/projects\(document_id, template_key\)/);
    await expect(project(b.id, { documentId: "no-such-document" })).rejects.toThrow();
  });

  it("only one timer can run, and stopped entries are unlimited", async () => {
    const b = await seedBusiness();
    const p = await project(b.id);
    const t = await task(p, b.id);
    await entry(t, p, b.id, "timer", T);
    await entry(t, p, b.id, "timer", T);
    await entry(t, p, b.id, "timer", null);
    await expect(entry(t, p, b.id, "timer", null)).rejects.toThrow();
  });

  it("a manual entry must have an end, so it can never hold the running-timer slot", async () => {
    const b = await seedBusiness();
    const p = await project(b.id);
    const t = await task(p, b.id);
    await env.DB.prepare(`DELETE FROM time_entries WHERE ended_at IS NULL`).run();
    await expect(entry(t, p, b.id, "manual", null)).rejects.toThrow(/CHECK constraint/i);
    await entry(t, p, b.id, "manual", T);
    await entry(t, p, b.id, "manual", T);
    // The slot stays free for a real timer.
    await entry(t, p, b.id, "timer", null);
    await env.DB.prepare(`DELETE FROM time_entries WHERE ended_at IS NULL`).run();
  });

  it("a step key and a cadence period each name one task per project", async () => {
    const b = await seedBusiness();
    const p = await project(b.id);
    await task(p, b.id, { stepKey: "1.1" });
    await expect(task(p, b.id, { stepKey: "1.1" })).rejects.toThrow();
    await task(p, b.id);
    await task(p, b.id);
    await task(p, b.id, { cadenceKey: "CARE-4", periodKey: "2026-11" });
    await expect(task(p, b.id, { cadenceKey: "CARE-4", periodKey: "2026-11" })).rejects.toThrow();
    await task(p, b.id, { cadenceKey: "CARE-4", periodKey: "2026-12" });
    const other = await project(b.id);
    await task(other, b.id, { stepKey: "1.1" });
  });

  it("a change order has one token, one origin approval, one number per project, and a paid time needs a way", async () => {
    const b = await seedBusiness();
    const p = await project(b.id);
    const co = (o: { seq: number; token?: string | null; origin?: string | null; paidAt?: string | null; paidVia?: string | null }) =>
      env.DB.prepare(
        `INSERT INTO change_orders (id, project_id, business_id, seq, status, content, token, source_type, origin_approval_id, paid_at, paid_via, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', '{}', ?, 'logan', ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), p, b.id, o.seq, o.token ?? null, o.origin ?? null, o.paidAt ?? null, o.paidVia ?? null, T, T).run();
    await co({ seq: 1 });
    await co({ seq: 2 });
    await co({ seq: 3, token: "tok-a", origin: "appr-a" });
    await expect(co({ seq: 4, token: "tok-a" })).rejects.toThrow();
    await expect(co({ seq: 4, origin: "appr-a" })).rejects.toThrow();
    await expect(co({ seq: 3 })).rejects.toThrow();
    await expect(co({ seq: 4, paidAt: T })).rejects.toThrow();
    await co({ seq: 4, paidAt: T, paidVia: "manual" });
  });

  it("a recurring template must have a cadence and a project template must not", async () => {
    const ins = (kind: string, cadence: string | null) =>
      env.DB.prepare(`INSERT INTO sop_templates (id, key, name, kind, cadence, created_at, updated_at) VALUES (?, ?, 'n', ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), crypto.randomUUID().slice(0, 8), kind, cadence, T, T).run();
    await ins("project", null);
    await ins("recurring", "weekly");
    await expect(ins("recurring", null)).rejects.toThrow();
    await expect(ins("project", "weekly")).rejects.toThrow();
  });
});
