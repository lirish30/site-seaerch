import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import "../src/worker/approvals/onboardingNudge";
import { toApproval } from "../src/worker/db/approvals";
import { markPaid, signChangeOrder } from "../src/worker/db/changeOrders";
import { setProjectStatus } from "../src/worker/db/projects";
import { touchClient } from "../src/worker/db/onboardings";
import { saveSettings } from "../src/worker/db/settings";
import { insertTasks, setTaskStatus, type NewTask } from "../src/worker/db/tasks";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { sweepOnboardings } from "../src/worker/onboarding/sweep";
import { SOP_STEP_KIND } from "../src/worker/queue/sopStep";
import { buildToday } from "../src/worker/today";
import { readyToSend } from "./fixtures/documents";
import { clientSig as coSig, seedOrder, sendOrder } from "./fixtures/changeorders";
import { newTask, resetProjectWork, seedProject, seedProjectWithOnboarding } from "./fixtures/projects";

const e = env as Env;
/** Thursday 19 November 2026, 04:00 in Los Angeles. */
const NOW = new Date("2026-11-19T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

// buildToday reads every lead, so each test starts from an empty set.
beforeEach(async () => {
  await resetProjectWork();
  for (const t of ["onboarding_nudges", "onboarding_files", "onboarding_answers", "onboarding_items", "onboardings", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions", "approvals"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => setMailDeps(null));

const attention = async () => (await buildToday(env.DB, NOW)).filter((i) => i.kind === "project_attention");
const reasons = async () => (await attention()).map((i) => i.reason);

async function tasks(projectId: string, businessId: string, specs: (Partial<NewTask> & { key: string })[]) {
  return insertTasks(env.DB, specs.map(({ key, ...o }, i) => newTask(projectId, businessId, { stepKey: key, position: i, title: `Task ${key}`, ...o })));
}
/** Records `n` ended Claude jobs of `status` for the task, so the dispatcher's own count sees them. */
async function jobs(taskId: string, status: "failed" | "expired" | "pending" | "claimed" | "stale" | "done", n = 1) {
  for (let i = 0; i < n; i++)
    await env.DB.prepare(`INSERT INTO claude_tasks (id, kind, payload, status, dedupe_key, created_at, target_type, target_id) VALUES (?, ?, ?, ?, ?, ?, 'task', ?)`)
      .bind(crypto.randomUUID(), SOP_STEP_KIND, JSON.stringify({ taskId }), status, status === "pending" || status === "claimed" ? taskId : null, ago(1), taskId).run();
}
const act = (businessId: string, kind: string, createdAt: string, detail: string | null = null) => env.DB.prepare(
  `INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), businessId, kind, detail, createdAt).run();

describe("project_attention", () => {
  it("an in_review task shows a review item", async () => {
    const s = await seedProject({ bare: true });
    await tasks(s.project.id, s.businessId, [{ key: "a", owner: "claude_drafts", status: "in_review" }, { key: "b", owner: "claude_drafts", status: "in_review" }, { key: "c" }]);
    const [item] = await attention();
    expect(item).toMatchObject({ id: `project_attention:${s.businessId}`, kind: "project_attention", businessId: s.businessId, reason: "2 Claude steps to review", due: null, priority: 68 });
    await env.DB.prepare(`UPDATE tasks SET status = 'done' WHERE step_key = 'b'`).run();
    expect(await reasons()).toEqual(["1 Claude step to review"]);
  });

  it("a Claude step that automatic dispatch gave up on shows, so it is not silent", async () => {
    const s = await seedProject({ bare: true });
    const [capped, fine, busy, stale, logans] = await tasks(s.project.id, s.businessId, [
      { key: "capped", owner: "claude" }, { key: "fine", owner: "claude" }, { key: "busy", owner: "claude_drafts" }, { key: "stale", owner: "claude" }, { key: "logans", owner: "logan" },
    ]);
    await jobs(capped.id, "failed", 1);
    await jobs(capped.id, "expired", 1); // failed or expired both count
    await jobs(fine.id, "failed", 1); // below the cap
    await jobs(busy.id, "failed", 2);
    await jobs(busy.id, "pending", 1); // and queued again (Ask Claude): not stuck
    await jobs(stale.id, "stale", 3); // stale is not Claude's own failure
    await jobs(logans.id, "failed", 3); // an owner that is not Claude
    expect(await reasons()).toEqual(["1 Claude step needs you"]);
    await jobs(fine.id, "failed", 1);
    expect(await reasons()).toEqual(["2 Claude steps need you"]);
    await setTaskStatus(env.DB, capped.id, "in_progress", { now: ago(0) }); // being worked: no longer capped
    expect(await reasons()).toEqual(["1 Claude step needs you"]);
  });

  it("a signed unpaid change order shows, and stops showing once it is paid", async () => {
    const o = await seedOrder();
    const sent = await sendOrder(o.co);
    expect(await attention()).toEqual([]); // sent, not signed
    expect(await signChangeOrder(env.DB, o.co.id, coSig(sent.hash), "2026-11-18T09:00:00.000Z")).toBe("signed");
    expect(await reasons()).toEqual(["Change order signed: waiting for payment"]);
    expect(await markPaid(env.DB, o.co.id, { at: ago(0), via: "manual" })).toBe(true);
    expect(await attention()).toEqual([]);
  });

  it("an overdue Logan task shows and a future one does not", async () => {
    const s = await seedProject({ bare: true });
    await tasks(s.project.id, s.businessId, [{ key: "late", dueOn: "2026-11-10" }]);
    expect(await reasons()).toEqual(["1 task due"]);
    await tasks(s.project.id, s.businessId, [{ key: "today", dueOn: "2026-11-19", position: 5 }, { key: "soon", dueOn: "2026-11-20", position: 6 }, { key: "undated", position: 7 }]);
    expect(await reasons()).toEqual(["2 tasks due"]); // the late one and the one due today, not tomorrow's or the undated
  });

  it("only Logan's ready tasks count: not Claude's, not blocked ones, not finished ones", async () => {
    const s = await seedProject({ bare: true });
    await tasks(s.project.id, s.businessId, [
      { key: "first" }, // Logan's, undated, still to do
      { key: "blocked", requires: ["first"], dueOn: "2026-11-10" },
      { key: "claudes", owner: "claude", dueOn: "2026-11-10" },
      { key: "done", dueOn: "2026-11-10", status: "done" },
      { key: "skipped", dueOn: "2026-11-10", status: "skipped" },
      { key: "waiting", dueOn: "2026-11-10", status: "waiting_client" },
    ]);
    expect(await attention()).toEqual([]);
    await tasks(s.project.id, s.businessId, [{ key: "started", dueOn: "2026-11-10", status: "in_progress", position: 9 }]);
    expect(await reasons()).toEqual(["1 task due"]);
  });

  it("today is the day in the booking time zone", async () => {
    const s = await seedProject({ bare: true });
    await tasks(s.project.id, s.businessId, [{ key: "a", dueOn: "2026-11-20" }]);
    const lateWednesdayInLa = new Date("2026-11-20T03:00:00.000Z"); // still 19 November in Los Angeles
    expect((await buildToday(env.DB, lateWednesdayInLa)).filter((i) => i.kind === "project_attention")).toEqual([]);
    await saveSettings(env.DB, { booking_config: JSON.stringify({ timezone: "UTC" }) });
    expect((await buildToday(env.DB, lateWednesdayInLa)).filter((i) => i.kind === "project_attention")).toHaveLength(1);
    await saveSettings(env.DB, { booking_config: JSON.stringify({ timezone: "Mars/Olympus" }) }); // an unreadable zone falls back to Los Angeles
    expect((await buildToday(env.DB, lateWednesdayInLa)).filter((i) => i.kind === "project_attention")).toEqual([]);
    await saveSettings(env.DB, { booking_config: "{}" });
  });

  it("one reason per lead, the first that applies: review, then a capped step, then payment, then due tasks", async () => {
    const o = await seedOrder();
    const sent = await sendOrder(o.co);
    await signChangeOrder(env.DB, o.co.id, coSig(sent.hash), "2026-11-18T09:00:00.000Z");
    const [capped, review, due] = await tasks(o.project.id, o.businessId, [{ key: "capped", owner: "claude" }, { key: "review", owner: "claude_drafts", status: "in_review" }, { key: "due", dueOn: "2026-11-01" }]);
    await jobs(capped.id, "failed", 2);
    expect(await reasons()).toEqual(["1 Claude step to review"]);
    await setTaskStatus(env.DB, review.id, "done", { now: ago(0) });
    expect(await reasons()).toEqual(["1 Claude step needs you"]);
    await setTaskStatus(env.DB, capped.id, "done", { now: ago(0) });
    expect(await reasons()).toEqual(["Change order signed: waiting for payment"]);
    await markPaid(env.DB, o.co.id, { at: ago(0), via: "manual" });
    expect(await reasons()).toEqual(["1 task due"]);
    await setTaskStatus(env.DB, due.id, "done", { now: ago(0) });
    expect(await attention()).toEqual([]);
  });

  it("a lead with two projects still gets one item, counting both", async () => {
    const a = await seedProject({ bare: true });
    await tasks(a.project.id, a.businessId, [{ key: "a", owner: "claude_drafts", status: "in_review" }]);
    const { createProject } = await import("../src/worker/db/projects");
    const { project: b } = await createProject(env.DB, { businessId: a.businessId, dealId: null, documentId: null, onboardingId: null, kind: "care_onboarding", name: "Care", test: false, templateKey: "CARE-0", templateVersion: 1, careDeferred: false, startedAt: ago(1) });
    await tasks(b.id, a.businessId, [{ key: "b", owner: "claude_drafts", status: "in_review" }]);
    expect(await reasons()).toEqual(["2 Claude steps to review"]);
  });

  it("a test project shows nothing, whatever is waiting in it", async () => {
    const t = await seedProject({ bare: true, test: true });
    const [, capped] = await tasks(t.project.id, t.businessId, [{ key: "r", owner: "claude_drafts", status: "in_review" }, { key: "capped", owner: "claude" }, { key: "late", dueOn: "2026-11-01" }]);
    await jobs(capped.id, "failed", 2);
    const o = await seedOrder({ test: true });
    const sent = await sendOrder(o.co);
    await signChangeOrder(env.DB, o.co.id, coSig(sent.hash), "2026-11-18T09:00:00.000Z");
    expect(await attention()).toEqual([]);
    expect((await buildToday(env.DB, NOW)).map((i) => i.businessId)).not.toContain(t.businessId);
  });

  it("a paused, done or cancelled project shows nothing", async () => {
    for (const status of ["paused", "done", "cancelled"] as const) {
      const s = await seedProject({ bare: true });
      await tasks(s.project.id, s.businessId, [{ key: "r", owner: "claude_drafts", status: "in_review" }, { key: "late", dueOn: "2026-11-01" }]);
      await setProjectStatus(env.DB, s.project.id, status);
    }
    expect(await attention()).toEqual([]);
  });

  it("done and snooze work like the other kinds, per kind", async () => {
    const s = await seedProject({ bare: true });
    await tasks(s.project.id, s.businessId, [{ key: "a", dueOn: "2026-11-01" }]);
    expect(await attention()).toHaveLength(1);
    await act(s.businessId, "today_done", ago(3), "project_attention");
    expect(await attention()).toEqual([]);
    await act(s.businessId, "today_done", ago(8), "project_attention"); // an older done does not override the newer one
    expect(await attention()).toEqual([]);
    await env.DB.prepare(`DELETE FROM activity`).run();
    await act(s.businessId, "today_done", ago(8), "project_attention"); // a done older than 7 days has worn off
    expect(await attention()).toHaveLength(1);
    await act(s.businessId, "snoozed", ago(1), `project_attention|${new Date(NOW.getTime() + DAY).toISOString()}`);
    expect(await attention()).toEqual([]);
    await act(s.businessId, "snoozed", ago(0.5), `project_attention|${ago(0.1)}`);
    expect(await attention()).toHaveLength(1);
  });

  it("sits between a proposal follow-up (65) and onboarding attention (70) in the queue", async () => {
    const s = await seedProject({ bare: true });
    await tasks(s.project.id, s.businessId, [{ key: "a", dueOn: "2026-11-01" }]);
    expect((await attention())[0].priority).toBe(68);
  });

  it("project activity does not count as contact with the prospect", async () => {
    const s = await seedProject({ bare: true });
    await tasks(s.project.id, s.businessId, [{ key: "a", dueOn: "2026-11-01" }]);
    await act(s.businessId, "project_started", ago(1));
    expect((await buildToday(env.DB, NOW)).map((i) => i.kind)).toEqual(["project_attention"]);
  });
});

describe("the Friday email", () => {
  /** A client with a real project and a Friday-due onboarding; the welcome went out 8 days before the Friday. */
  async function client() {
    await readyToSend();
    const s = await seedProjectWithOnboarding({ sentAt: "2026-11-12T17:00:00.000Z" });
    await touchClient(env.DB, s.onboarding.id, "2026-11-19T22:00:00.000Z"); // the client wrote yesterday: no reminder is due, only the Friday update
    await tasks(s.project.id, s.businessId, [
      { key: "a", title: "Internal: pull the update list", clientSummary: null, status: "done" },
      { key: "b", title: "Internal: build the home page", clientSummary: "Your home page is built", status: "done" },
      { key: "c", title: "Internal: QA the forms", clientSummary: "Testing your contact form" },
      { key: "d", title: "Internal: check redirects", clientSummary: null },
    ]);
    await env.DB.prepare(`UPDATE tasks SET done_at = ? WHERE project_id = ? AND status = 'done'`).bind("2026-11-18T20:00:00.000Z", s.project.id).run();
    return s;
  }
  const FRIDAY = new Date("2026-11-20T17:00:00.000Z");
  const preview = async (dealId: string) => {
    const row = await env.DB.prepare(`SELECT * FROM approvals WHERE kind = 'onboarding.nudge' AND record_id = ?`).bind(dealId).first<Parameters<typeof toApproval>[0]>();
    return row ? toApproval(row).preview : null;
  };

  it("the Friday email carries the done and next lines", async () => {
    const s = await client();
    expect(await sweepOnboardings(e, FRIDAY)).toEqual({ reminders: 0, fridays: 1, waiting: 0 });
    const p = (await preview(s.dealId))!;
    expect(p).toContain("Done this week:\n- Your home page is built");
    expect(p).toContain("Coming up next:\n- Testing your contact form");
  });

  it("no internal task title ever reaches the Friday email", async () => {
    const s = await client();
    await sweepOnboardings(e, FRIDAY);
    const p = (await preview(s.dealId))!;
    expect(p).not.toContain("Internal");
    expect(p).not.toContain("pull the update list");
    // Sending it (the approval) builds the mail again from the project as it is then: still no internal title.
    const sent: string[] = [];
    setMailDeps({ smtp: async (_mb, _pw, msg) => { sent.push(msg.text ?? ""); }, now: () => FRIDAY });
    const a = (await env.DB.prepare(`SELECT id FROM approvals WHERE kind = 'onboarding.nudge'`).first<{ id: string }>())!;
    await approve(e, a.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Your home page is built");
    expect(sent[0]).not.toContain("Internal");
  });

  it("omits both sections when there is nothing client-visible, and a test project adds none", async () => {
    await readyToSend();
    const s = await seedProjectWithOnboarding({ sentAt: "2026-11-12T17:00:00.000Z" });
    await touchClient(env.DB, s.onboarding.id, "2026-11-19T22:00:00.000Z");
    await tasks(s.project.id, s.businessId, [{ key: "a", title: "Internal only", clientSummary: null, status: "done" }, { key: "b", title: "Internal two", clientSummary: null }]);
    await sweepOnboardings(e, FRIDAY);
    const p = (await preview(s.dealId))!;
    expect(p).not.toContain("Done this week");
    expect(p).not.toContain("Coming up next");
    expect(p).not.toContain("Internal");
    expect(p).toContain("Your questionnaire is not in yet");
  });

  it("a project that cannot be read does not stop the Friday email", async () => {
    const s = await client();
    const broken = { ...e, DB: new Proxy(env.DB, {
      get(t, p) {
        if (p === "prepare") return (sql: string) => { if (/FROM projects/.test(sql) && /business_id/.test(sql) && !/documents/.test(sql)) throw new Error("projects down"); return t.prepare(sql); };
        const v = (t as never)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) } as Env;
    expect(await sweepOnboardings(broken, FRIDAY)).toEqual({ reminders: 0, fridays: 1, waiting: 0 });
    expect(await preview(s.dealId)).not.toContain("Done this week");
  });
});
