import { describe, expect, it } from "vitest";
import type { Task } from "../src/worker/db/tasks";
import { currentPhase, readyClaudeTasks } from "../src/worker/sop/ready";

const ACTIVE = { projectActive: true, waiting: false };

/** A step task with only the fields readiness looks at (the rest is filled in so the type holds). */
function mk(key: string, o: Partial<Task> = {}): Task {
  return {
    id: `id-${key}`, projectId: "p", businessId: "b", isStep: true, stepKey: key, phaseKey: "p1", phaseTitle: "Phase one", position: 0, title: `Step ${key}`, description: "", owner: "claude",
    status: "todo", doneWhen: "", estMinutes: 15, dueOn: null, billable: false, skippable: false, requires: [], milestone: null, clientSummary: null, docTemplate: null, emailTemplate: null,
    checklist: [], changeOrderId: null, cadenceKey: null, periodKey: null, claudeTaskId: null, reviewApprovalId: null, startedAt: null, doneAt: null, createdAt: "", updatedAt: "", ...o,
  };
}
const keys = (ts: Task[]) => ts.map((t) => t.stepKey);

describe("currentPhase", () => {
  it("is the first phase, counted from zero in step order, that still has an open step", () => {
    const ts = [mk("a", { position: 0, status: "done" }), mk("b", { position: 1, phaseKey: "p2", status: "todo" }), mk("c", { position: 2, phaseKey: "p3" })];
    expect(currentPhase(ts)).toBe(1);
    expect(currentPhase([mk("a", { status: "todo" }), ...ts.slice(1)])).toBe(0);
  });

  it("treats a skipped step as finished but an in-progress, in-review, waiting or locked one as open", () => {
    expect(currentPhase([mk("a", { status: "skipped" })])).toBeNull();
    for (const status of ["in_progress", "in_review", "waiting_client", "locked"] as const) expect(currentPhase([mk("a", { status })])).toBe(0);
  });

  it("is null when every step is finished or there are none, and ignores tasks that are not steps", () => {
    expect(currentPhase([])).toBeNull();
    expect(currentPhase([mk("a", { status: "done" }), mk("x", { isStep: false, stepKey: null, phaseKey: "extra", position: 5, status: "todo" })])).toBeNull();
  });

  it("orders phases by their lowest position, whatever order the tasks come in", () => {
    const ts = [mk("b", { position: 3, phaseKey: "p2" }), mk("a", { position: 0, phaseKey: "p1", status: "done" })];
    expect(currentPhase(ts)).toBe(1);
  });
});

describe("readyClaudeTasks", () => {
  it("only the current phase's claude steps are ready", () => {
    const ts = [
      mk("a", { position: 0 }), mk("l", { position: 1, owner: "logan" }),
      mk("c", { position: 2, phaseKey: "p2" }), mk("d", { position: 3, phaseKey: "p3", owner: "claude_drafts" }),
    ];
    expect(keys(readyClaudeTasks(ts, ACTIVE))).toEqual(["a"]);
    // The phase is not over until Logan's step in it is done as well.
    const afterA = [{ ...ts[0], status: "done" as const }, ...ts.slice(1)];
    expect(keys(readyClaudeTasks(afterA, ACTIVE))).toEqual([]);
    const phaseOneDone = [{ ...ts[0], status: "done" as const }, { ...ts[1], status: "done" as const }, ...ts.slice(2)];
    expect(keys(readyClaudeTasks(phaseOneDone, ACTIVE))).toEqual(["c"]);
  });

  it("a phase is placed by its first step, so a late step keyed to an early phase keeps the project there", () => {
    const ts = [mk("a", { position: 0, status: "skipped" }), mk("b", { position: 1, phaseKey: "p2", owner: "logan" }), mk("c", { position: 2, phaseKey: "p2" }), mk("e", { position: 3 })];
    // "e" sits in phase one by key but later by position; phase one is the current phase until it is done, so c (phase two) waits.
    expect(keys(readyClaudeTasks(ts, ACTIVE))).toEqual(["e"]);
  });

  it("a claude_drafts step is ready like a claude one, and they come back in step order", () => {
    const ts = [mk("b", { position: 1, owner: "claude_drafts" }), mk("a", { position: 0 })];
    expect(keys(readyClaudeTasks(ts, ACTIVE))).toEqual(["a", "b"]);
  });

  it("a step with an unmet requires is not ready", () => {
    const ts = [mk("x", { position: 0, owner: "logan" }), mk("a", { position: 1, requires: ["x"] })];
    expect(readyClaudeTasks(ts, ACTIVE)).toEqual([]);
    expect(keys(readyClaudeTasks([{ ...ts[0], status: "done" }, ts[1]], ACTIVE))).toEqual(["a"]);
    // A skipped step satisfies only when it is marked skippable.
    expect(readyClaudeTasks([{ ...ts[0], status: "skipped" }, ts[1]], ACTIVE)).toEqual([]);
    expect(keys(readyClaudeTasks([{ ...ts[0], status: "skipped", skippable: true }, ts[1]], ACTIVE))).toEqual(["a"]);
    // A requirement with no task is unmet.
    expect(readyClaudeTasks([mk("a", { requires: ["ghost"] })], ACTIVE)).toEqual([]);
  });

  it("a logan step is never ready for Claude", () => {
    expect(readyClaudeTasks([mk("a", { owner: "logan" })], ACTIVE)).toEqual([]);
  });

  it("only a todo step is ready: under way, in review, waiting, done, skipped and locked are not", () => {
    for (const status of ["in_progress", "in_review", "waiting_client", "done", "skipped", "locked"] as const) expect(readyClaudeTasks([mk("a", { status })], ACTIVE)).toEqual([]);
  });

  it("a locked change-order task is not ready, and an unlocked one is", () => {
    const locked = mk("co", { isStep: false, stepKey: null, phaseKey: "co", position: 9, changeOrderId: "co1", status: "locked" });
    expect(readyClaudeTasks([mk("a", { status: "done" }), locked], ACTIVE)).toEqual([]);
    expect(readyClaudeTasks([mk("a", { status: "done" }), { ...locked, status: "todo" }], ACTIVE).map((t) => t.id)).toEqual(["id-co"]);
  });

  it("a task that is not a step is not held back by the phases", () => {
    const extra = mk("x", { isStep: false, stepKey: null, phaseKey: "extra", position: 9 });
    expect(readyClaudeTasks([mk("a", { owner: "logan" }), extra], ACTIVE).map((t) => t.id)).toEqual(["id-x"]);
  });

  it("nothing is ready for a project that is not active or is waiting on the client", () => {
    const ts = [mk("a")];
    expect(readyClaudeTasks(ts, { projectActive: false, waiting: false })).toEqual([]);
    expect(readyClaudeTasks(ts, { projectActive: true, waiting: true })).toEqual([]);
  });
});
