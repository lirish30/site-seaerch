import { describe, expect, it } from "vitest";
import { checklistText, donePercent, dueText, firstOpenTask, isLate, minutesText, progressLine, statusWords, workThroughHref } from "../src/client/batchesView";
import type { BatchTask } from "../src/worker/batches/groups";

const task = (id: string, o: Partial<BatchTask> = {}): BatchTask => ({
  taskId: id, businessId: `b-${id}`, client: id, grade: null, status: "todo", dueOn: "2026-11-18", estMinutes: 10, checklistDone: 0, checklistTotal: 0, held: false, ...o,
});

describe("batches view", () => {
  it("says the progress in hours and minutes", () => {
    expect(minutesText(260)).toBe("4 h 20 m");
    expect(minutesText(45)).toBe("45 m");
    expect(minutesText(120)).toBe("2 h");
    expect(minutesText(0)).toBe("0 m");
    expect(progressLine({ open: 8, done: 3, estMinutes: 260 })).toBe("3 of 11 done, about 4 h 20 m left");
    expect(progressLine({ open: 0, done: 4, estMinutes: 0 })).toBe("All 4 done");
    expect(progressLine({ open: 0, done: 0, estMinutes: 0 })).toBe("Nothing to do");
    expect(donePercent({ open: 8, done: 3 })).toBe(27);
    expect(donePercent({ open: 0, done: 0 })).toBe(0);
  });

  it("Work through goes to the first open task in the order shown, skipping finished, skipped and held ones", () => {
    const tasks = [task("a", { status: "done" }), task("b", { status: "skipped" }), task("c", { held: true }), task("d", { status: "in_progress" }), task("e")];
    expect(firstOpenTask({ tasks })?.taskId).toBe("d");
    expect(workThroughHref({ tasks })).toBe("/tasks/d");
    expect(workThroughHref({ tasks: [task("a", { status: "done" }), task("c", { held: true })] })).toBeNull();
    expect(workThroughHref({ tasks: [] })).toBeNull();
    expect(workThroughHref({ tasks: [task("a/b")] })).toBe("/tasks/a%2Fb");
  });

  it("words for dates, status, lateness and the checklist", () => {
    expect(dueText("2026-11-18")).toBe("Wed, Nov 18");
    expect(dueText(null)).toBe("No due date");
    expect(statusWords("waiting_client")).toBe("Waiting on client");
    expect(isLate({ dueOn: "2026-11-18", open: 2 }, "2026-11-19")).toBe(true);
    expect(isLate({ dueOn: "2026-11-18", open: 2 }, "2026-11-18")).toBe(false);
    expect(isLate({ dueOn: "2026-11-18", open: 0 }, "2026-11-19")).toBe(false);
    expect(isLate({ dueOn: null, open: 2 }, "2026-11-19")).toBe(false);
    expect(checklistText({ checklistDone: 2, checklistTotal: 5 })).toBe("2 of 5 steps");
    expect(checklistText({ checklistDone: 0, checklistTotal: 1 })).toBe("0 of 1 step");
    expect(checklistText({ checklistDone: 0, checklistTotal: 0 })).toBeNull();
  });
});
