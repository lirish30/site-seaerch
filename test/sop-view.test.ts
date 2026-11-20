import { describe, expect, it } from "vitest";
import {
  addPhase, addStep, diffDetails, diffSummary, flattenPhases, keyProblem, movePhase, moveStep, nextStepKey, parseEstimate, removePhase, removeStep, requiresChoices, setPhaseTitle, stepRows, stepsFromTaskRows, templateProblems, totalEstimate,
} from "../src/client/sopView";
import type { SopStep, SopTemplate, SopTemplateInput } from "../src/worker/sop/model";
import { stepsFromTasks } from "../src/worker/sop/instantiate";
import type { Task } from "../src/worker/db/tasks";

let pos = 0;
const step = (key: string, o: Partial<SopStep> = {}): SopStep => ({
  key, phaseKey: "1", phaseTitle: "Kickoff", position: ++pos, title: `Step ${key}`, owner: "logan", estMinutes: 30, doneWhen: "", docTemplate: null, emailTemplate: null,
  requires: [], milestone: null, clientSummary: null, skippable: false, ...o,
});
const input = (steps: SopStep[], o: Partial<SopTemplateInput> = {}): SopTemplateInput => ({
  key: "BUILD", name: "Site build", kind: "project", cadence: null, cadenceDay: null, appliesTo: ["starter_site"], active: true, steps, ...o,
});
const template = (steps: SopStep[]): SopTemplate => ({ ...input(steps), id: "t1", version: 3, updatedAt: "2026-11-01T00:00:00.000Z" });

describe("templateProblems", () => {
  it("templateProblems names a requires cycle in plain words", () => {
    const t = input([step("1.1", { requires: ["1.2"] }), step("1.2", { requires: ["1.1"] })]);
    expect(templateProblems(t)).toEqual(["Steps wait on each other in a loop: 1.1 → 1.2 → 1.1."]);
  });
  it("is empty for a template that can be saved", () => expect(templateProblems(input([step("1.1"), step("1.2", { requires: ["1.1"] })]))).toEqual([]));
  it("names a step that requires itself, one that is not there, and a repeated key", () => {
    const p = templateProblems(input([step("1.1", { requires: ["1.1", "9.9"] }), step("1.1")]));
    expect(p).toContain("Step 1.1 requires itself.");
    expect(p).toContain("Step 1.1 requires 9.9, which is not a step in this template.");
    expect(p).toContain("The step key 1.1 is used twice.");
  });
  it("also says what the save would refuse about a field, once", () => {
    const p = templateProblems(input([step("1.1", { title: "" }), step("1.2", { clientSummary: "x".repeat(81) })]));
    expect(p).toEqual(["A step needs a title.", "A client summary is at most 80 characters."]);
  });
  it("names a recurring template with no cadence once, not twice", () => {
    expect(templateProblems(input([step("1.1")], { kind: "recurring" }))).toEqual(["A recurring template needs a cadence (weekly, monthly, quarterly or annual)."]);
  });
});

describe("stepRows", () => {
  it("stepRows groups by phase in order", () => {
    const t = input([
      step("2.1", { phaseKey: "2", phaseTitle: "Design", position: 4 }), step("1.2", { position: 2 }), step("1.1", { position: 1 }), step("2.2", { phaseKey: "2", phaseTitle: "Design", position: 5 }),
    ]);
    const rows = stepRows(t);
    expect(rows.map((r) => [r.phaseTitle, r.steps.map((s) => s.key)])).toEqual([["Kickoff", ["1.1", "1.2"]], ["Design", ["2.1", "2.2"]]]);
  });
  it("is empty for no steps", () => expect(stepRows(input([]))).toEqual([]));
});

describe("totalEstimate", () => {
  it("totalEstimate sums minutes", () => {
    expect(totalEstimate(input([step("a", { estMinutes: 600 }), step("b", { estMinutes: 600 }), step("c", { estMinutes: 600 }), step("d", { estMinutes: 600 }), step("e", { estMinutes: 120 })]))).toBe("about 42 hours");
  });
  it("reads small and empty totals plainly", () => {
    expect(totalEstimate(input([]))).toBe("no estimate yet");
    expect(totalEstimate(input([step("a", { estMinutes: 45 })]))).toBe("about 45 minutes");
    expect(totalEstimate(input([step("a", { estMinutes: 60 })]))).toBe("about 1 hour");
    expect(totalEstimate(input([step("a", { estMinutes: 450 })]))).toBe("about 7.5 hours");
  });
});

describe("diffSummary", () => {
  const before = template([step("1.1"), step("1.2"), step("1.3"), step("1.4")]);
  it("diffSummary counts added, removed and changed", () => {
    const after = input([step("1.1", { title: "Renamed" }), step("1.2", { estMinutes: 90 }), step("1.3"), step("1.5"), step("1.6"), step("1.7")]);
    expect(diffSummary(before, after)).toEqual(["3 steps added", "1 removed", "2 changed"]);
  });
  it("says so when nothing differs, and ignores position numbers alone", () => {
    expect(diffSummary(before, input(before.steps.map((s, i) => ({ ...s, position: 100 + i }))))).toEqual(["no change to the steps"]);
  });
  it("says one step in the singular and notices a reorder", () => {
    expect(diffSummary(before, input([step("1.1"), step("1.2"), step("1.3"), step("1.4"), step("1.9")]))).toEqual(["1 step added"]);
    const [a, b, c, d] = before.steps;
    expect(diffSummary(before, input([b, a, c, d].map((s, i) => ({ ...s, position: i }))))).toEqual(["the order changed"]);
  });
  it("counts a requires or owner edit as a change", () => {
    expect(diffSummary(before, input([{ ...before.steps[0], requires: ["1.2"] }, ...before.steps.slice(1)]))).toEqual(["1 step changed"]);
  });
  it("names what moved, a few at a time", () => {
    const after = input([step("1.1", { title: "Renamed" }), step("1.2"), step("1.3"), step("1.8", { title: "Brand new" })]);
    expect(diffDetails(before, after)).toEqual(["Added: Brand new", "Removed: Step 1.4", "Changed: Renamed"]);
  });
});

describe("editor helpers", () => {
  const t = input([step("1.1", { position: 1 }), step("1.2", { position: 2, requires: ["1.1"] }), step("2.1", { phaseKey: "2", phaseTitle: "Design", position: 3, requires: ["1.2"] })]);
  it("offers only the other steps to require", () => expect(requiresChoices(t, "1.2").map((s) => s.key)).toEqual(["1.1", "2.1"]));
  it("makes the next key in the phase that is not taken", () => {
    expect(nextStepKey(t.steps, "1")).toBe("1.3");
    expect(nextStepKey(t.steps, "2")).toBe("2.2");
    expect(nextStepKey([], "7")).toBe("7.1");
  });
  it("removing a step also stops other steps waiting on it", () => {
    const next = removeStep(t.steps, "1.2");
    expect(next.map((s) => s.key)).toEqual(["1.1", "2.1"]);
    expect(next[1].requires).toEqual([]);
    expect(templateProblems(input(next))).toEqual([]);
  });
  it("moves a step within its phase and renumbers positions from zero", () => {
    const moved = moveStep(t.steps, "1.2", -1);
    expect(moved.map((s) => [s.key, s.position])).toEqual([["1.2", 0], ["1.1", 1], ["2.1", 2]]);
    expect(moveStep(t.steps, "1.1", -1).map((s) => s.key)).toEqual(["1.1", "1.2", "2.1"]);
    expect(moveStep(t.steps, "1.2", 1).map((s) => s.key)).toEqual(["1.1", "1.2", "2.1"]);
  });
  it("adds a step to a phase after its last one, and a new phase at the end", () => {
    const added = addStep(t.steps, "1");
    expect(added.map((s) => s.key)).toEqual(["1.1", "1.2", "1.3", "2.1"]);
    expect(added[2]).toMatchObject({ phaseKey: "1", phaseTitle: "Kickoff", owner: "logan", estMinutes: 30, requires: [], milestone: null, clientSummary: null, skippable: false });
    const phased = addPhase(t.steps);
    expect(phased.at(-1)).toMatchObject({ phaseKey: "3", phaseTitle: "New phase", key: "3.1" });
  });
  it("removes a phase with its steps and the requirements on them", () => {
    const next = removePhase(t.steps, "1");
    expect(next.map((s) => s.key)).toEqual(["2.1"]);
    expect(next[0].requires).toEqual([]);
  });
  it("moves a whole phase and keeps its steps together", () => {
    expect(movePhase(t.steps, "2", -1).map((s) => [s.key, s.position])).toEqual([["2.1", 0], ["1.1", 1], ["1.2", 2]]);
    expect(movePhase(t.steps, "2", 1).map((s) => s.key)).toEqual(["1.1", "1.2", "2.1"]);
    expect(setPhaseTitle(t.steps, "2", "Build").map((s) => s.phaseTitle)).toEqual(["Kickoff", "Kickoff", "Build"]);
  });
  it("flattens phases back into steps with whole, rising positions", () => {
    expect(flattenPhases(stepRows(t)).map((s) => s.position)).toEqual([0, 1, 2]);
  });
});

describe("stepsFromTaskRows", () => {
  it("builds the same steps the worker's push does (parity)", () => {
    const base = { projectId: "p", businessId: "b", description: "", status: "todo", dueOn: null, billable: false, changeOrderId: null, cadenceKey: null, periodKey: null, claudeTaskId: null, reviewApprovalId: null, startedAt: null, doneAt: null, createdAt: "", updatedAt: "", checklist: [] };
    const tasks = [
      { ...base, id: "a", isStep: true, stepKey: "1.2", phaseKey: "1", phaseTitle: "Kickoff", position: 2, title: "B", owner: "claude", doneWhen: "x", estMinutes: 20, skippable: true, requires: ["1.1"], milestone: null, clientSummary: "hi", docTemplate: "d", emailTemplate: null },
      { ...base, id: "x", isStep: false, stepKey: null, phaseKey: "extra", phaseTitle: "Extra tasks", position: 9, title: "adhoc", owner: "logan", doneWhen: "", estMinutes: 5, skippable: false, requires: [], milestone: null, clientSummary: null, docTemplate: null, emailTemplate: null },
      { ...base, id: "b", isStep: true, stepKey: "1.1", phaseKey: "1", phaseTitle: "Kickoff", position: 1, title: "A", owner: "logan", doneWhen: "", estMinutes: 10, skippable: false, requires: [], milestone: "design_approved", clientSummary: null, docTemplate: null, emailTemplate: "e" },
    ] as unknown as Task[];
    expect(stepsFromTaskRows(tasks)).toEqual(stepsFromTasks(tasks));
    expect(stepsFromTaskRows(tasks).map((s) => s.key)).toEqual(["1.1", "1.2"]);
  });
});

describe("parseEstimate", () => {
  it("reads minutes and hours, and zero", () => {
    expect(["45", "45m", "1h 30m", "1:30", "1.5h", "0", "0m", "10h"].map(parseEstimate)).toEqual([45, 45, 90, 90, 90, 0, 0, 600]);
  });
  it("refuses blanks, nonsense and more than the 600 minutes a step can have", () => {
    expect(["", "abc", "-5", "601", "11h"].map(parseEstimate)).toEqual([null, null, null, null, null]);
  });
});

describe("keyProblem", () => {
  it("is null for a free key", () => expect(keyProblem("NEW1", ["BUILD", "QUICKFIX"])).toBeNull());
  it("names a key that is taken, whatever its case", () => {
    expect(keyProblem("BUILD", ["BUILD"])).toBe("A template with the key BUILD already exists. Open it from the list to edit it.");
    expect(keyProblem("build", ["BUILD"])).toBe("A template with the key BUILD already exists. Open it from the list to edit it.");
  });
  it("is null for a blank key (the other checks say so)", () => expect(keyProblem("  ", ["BUILD"])).toBeNull());
});
