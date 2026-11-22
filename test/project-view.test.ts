import { describe, expect, it } from "vitest";
import {
  blockedText, bucketCounts, decimalHours, groupByClient, kindChip, pagerOf, sinceLabel, statusChip, canTakeChangeOrder, cancelConfirm, cancelLabel, dealProjects, stepsEditable, stopControls, visibleProjects, startOffers, listProgress, timeEstimate, timeRows, kindLabel, milestoneChips, ownerBadge, phaseGroups, profitLines, projectBucket, projectProgress, projectState, taskState,
} from "../src/client/projectView";
import type { Task } from "../src/worker/db/tasks";

let n = 0;
const task = (o: Partial<Task> = {}): Task => ({
  id: `t${++n}`, projectId: "p1", businessId: "b1", isStep: true, stepKey: null, phaseKey: "1", phaseTitle: "Kickoff", position: n, title: `Step ${n}`, description: "",
  owner: "logan", status: "todo", doneWhen: "", estMinutes: 30, dueOn: null, billable: true, skippable: false, requires: [], milestone: null, clientSummary: null,
  docTemplate: null, emailTemplate: null, checklist: [], changeOrderId: null, cadenceKey: null, periodKey: null, claudeTaskId: null, reviewApprovalId: null, editRequest: false,
  startedAt: null, doneAt: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...o,
});

describe("phaseGroups", () => {
  it("phaseGroups orders phases by their first step and counts done and skipped", () => {
    const tasks = [
      task({ phaseKey: "2", phaseTitle: "Design", position: 5, status: "done" }),
      task({ phaseKey: "1", phaseTitle: "Kickoff", position: 1, status: "done" }),
      task({ phaseKey: "1", phaseTitle: "Kickoff", position: 2, status: "skipped" }),
      task({ phaseKey: "1", phaseTitle: "Kickoff", position: 3, status: "todo" }),
      task({ phaseKey: "2", phaseTitle: "Design", position: 4, status: "todo" }),
      task({ phaseKey: "extra", phaseTitle: "Extra tasks", position: 9, isStep: false }),
    ];
    const g = phaseGroups(tasks);
    expect(g.map((x) => [x.phaseKey, x.title, x.done, x.total])).toEqual([["1", "Kickoff", 2, 3], ["2", "Design", 1, 2], ["extra", "Extra tasks", 0, 1]]);
    expect(g[1].tasks.map((t) => t.position)).toEqual([4, 5]);
  });
  it("is empty for no tasks", () => expect(phaseGroups([])).toEqual([]));
});

describe("taskState", () => {
  const a = task({ stepKey: "7.2", title: "Write the copy", status: "todo" });
  it("taskState says Blocked by 7.2 and names the open requirement", () => {
    const t = task({ requires: ["7.2"] });
    expect(taskState(t, [a, t])).toEqual({ label: "Blocked by 7.2", tone: "warn", blockedBy: ["Write the copy"] });
  });
  it("is Ready once the requirement is done, or skipped and skippable", () => {
    const t = task({ requires: ["7.2"] });
    expect(taskState(t, [{ ...a, status: "done" }, t])).toEqual({ label: "Ready", tone: "neutral", blockedBy: [] });
    expect(taskState(t, [{ ...a, status: "skipped", skippable: true }, t]).label).toBe("Ready");
    expect(taskState(t, [{ ...a, status: "skipped", skippable: false }, t]).label).toBe("Blocked by 7.2");
  });
  it("names a requirement that has no task by its key and lists several", () => {
    const t = task({ requires: ["9.9", "7.2"] });
    expect(taskState(t, [a, t])).toEqual({ label: "Blocked by 9.9, 7.2", tone: "warn", blockedBy: ["9.9", "Write the copy"] });
    const many = task({ requires: ["a", "b", "c", "d", "e"] });
    expect(taskState(many, [many]).label).toBe("Blocked by a, b, c and 2 more");
  });
  it("taskState for a locked change-order task", () => {
    expect(taskState(task({ status: "locked", changeOrderId: "co1" }), [])).toEqual({ label: "Locked: change order unpaid", tone: "warn", blockedBy: [] });
  });
  it("waiting client is muted not warn", () => {
    expect(taskState(task({ status: "waiting_client" }), [])).toEqual({ label: "Waiting on client", tone: "muted", blockedBy: [] });
  });
  it("covers review, progress, done and skipped", () => {
    expect(taskState(task({ status: "in_review" }), []).label).toBe("In review");
    expect(taskState(task({ status: "in_progress" }), []).label).toBe("In progress");
    expect(taskState(task({ status: "done" }), [])).toEqual({ label: "Done", tone: "good", blockedBy: [] });
    expect(taskState(task({ status: "skipped" }), [])).toEqual({ label: "Skipped", tone: "muted", blockedBy: [] });
  });
  it("a done task is never blocked even when a requirement is open", () => {
    expect(taskState(task({ status: "done", requires: ["7.2"] }), [a]).label).toBe("Done");
  });
});

describe("owner, progress, milestones", () => {
  it("ownerBadge is short", () => {
    expect(ownerBadge("claude")).toBe("Claude");
    expect(ownerBadge("logan")).toBe("Logan");
    expect(ownerBadge("claude_drafts")).toBe("Claude drafts");
  });
  it("projectProgress counts steps and ignores extras; a project of only extras counts them", () => {
    const steps = [task({ status: "done" }), task({ status: "skipped" }), task({ status: "todo" }), task({ status: "todo" }), task({ isStep: false, status: "todo" })];
    expect(projectProgress(steps)).toEqual({ done: 2, total: 4, pct: 50 });
    expect(projectProgress([task({ isStep: false, status: "done" }), task({ isStep: false })])).toEqual({ done: 1, total: 2, pct: 50 });
    expect(projectProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
    expect(projectProgress([task({ status: "done" }), task(), task()]).pct).toBe(33);
  });
  it("milestoneChips shows both milestones, reached or not", () => {
    expect(milestoneChips([{ milestone: "design_approved", reachedAt: "2026-11-10T10:00:00.000Z" }])).toEqual([
      { key: "design_approved", label: "Design approved", reached: true, reachedAt: "2026-11-10T10:00:00.000Z" },
      { key: "site_finished", label: "Site finished", reached: false, reachedAt: null },
    ]);
    expect(milestoneChips([]).every((c) => !c.reached)).toBe(true);
  });
});

describe("profitLines", () => {
  const p = { soldCents: 400000, paidCents: 200000, costCents: 50000, marginSoldCents: 350000, marginPaidCents: 150000, effectiveHourlyCents: 8000 };
  it("with a cost rate it says paid, cost, margin and the hourly", () => {
    expect(profitLines(p, 6000)).toEqual(["Sold $4,000", "Paid $2,000, cost $500, margin $1,500, about $80 an hour"]);
  });
  it("profitLines with no cost rate", () => {
    expect(profitLines({ ...p, costCents: 0, marginPaidCents: 200000, marginSoldCents: 400000 }, 0)).toEqual(["Sold $4,000", "Paid $2,000", "Cost rate not set"]);
  });
  it("a rate with no time logged yet is not 'rate not set'", () => {
    expect(profitLines({ ...p, costCents: 0, marginPaidCents: 200000, effectiveHourlyCents: null }, 6000)[1]).toBe("Paid $2,000, cost $0, margin $2,000, no time logged yet");
  });
  it("shows a negative margin with a minus and leaves the hourly off before any time is logged", () => {
    expect(profitLines({ ...p, marginPaidCents: -4000, effectiveHourlyCents: null }, 6000)[1]).toBe("Paid $2,000, cost $500, margin -$40, no time logged yet");
  });
});

describe("project state and buckets", () => {
  const base = { status: "active" as const, kind: "build" as const, templateKey: null, waitingOnClient: false };
  const care = { kind: "care_onboarding" as const, templateKey: null, waitingOnClient: false };
  const seo = { kind: "custom" as const, templateKey: "SEO-0", waitingOnClient: false };
  it("labels each state", () => {
    expect(projectState(base)).toEqual({ label: "Active", tone: "neutral" });
    expect(projectState({ ...base, waitingOnClient: true })).toEqual({ label: "Waiting on client", tone: "muted" });
    expect(projectState({ ...base, status: "paused" })).toEqual({ label: "Paused", tone: "warn" });
    expect(projectState({ ...base, status: "done" })).toEqual({ label: "Done", tone: "good" });
    expect(projectState({ ...base, status: "cancelled" })).toEqual({ label: "Cancelled", tone: "muted" });
  });
  it("a finished Care onboarding project is live: it says its Care is running and sits in Active, not Done", () => {
    expect(projectState({ ...care, status: "done" })).toEqual({ label: "Care running", tone: "good" });
    expect(projectBucket({ ...care, status: "done" })).toBe("active");
    // a finished build or quick fix is done, and a cancelled Care project is done too
    expect(projectBucket({ ...base, status: "done" })).toBe("done");
    expect(projectBucket({ ...care, status: "cancelled" })).toBe("done");
    expect(projectState({ ...care, status: "cancelled" })).toEqual({ label: "Cancelled", tone: "muted" });
  });
  it("a finished SEO-0 project is live too, and says Local SEO is running, never Care", () => {
    expect(projectState({ ...seo, status: "done" })).toEqual({ label: "Local SEO running", tone: "good" });
    expect(projectBucket({ ...seo, status: "done" })).toBe("active");
    expect(projectState({ ...seo, status: "cancelled" })).toEqual({ label: "Cancelled", tone: "muted" });
    expect(projectBucket({ ...seo, status: "cancelled" })).toBe("done");
    // a done hand-made custom project, and a done build, stay plain Done
    expect(projectState({ ...base, kind: "custom", status: "done" })).toEqual({ label: "Done", tone: "good" });
    expect(projectBucket({ ...base, kind: "custom", status: "done" })).toBe("done");
    expect(projectState({ ...base, status: "done" })).toEqual({ label: "Done", tone: "good" });
  });
  it("buckets for the sidebar: waiting is its own, cancelled sits with done, a live Care project counts as active", () => {
    const rows = [base, { ...base, waitingOnClient: true }, { ...base, status: "paused" as const }, { ...base, status: "done" as const }, { ...base, status: "cancelled" as const }, base, { ...care, status: "done" as const }];
    expect(rows.map(projectBucket)).toEqual(["active", "waiting", "paused", "done", "done", "active", "active"]);
    expect(bucketCounts(rows)).toEqual({ active: 3, waiting: 1, paused: 1, done: 2 });
  });
  it("kindLabel", () => {
    expect([kindLabel("build"), kindLabel("quick_fix"), kindLabel("care_onboarding"), kindLabel("custom")]).toEqual(["Site build", "Quick fix", "Care setup", "Custom"]);
  });
});

describe("stop controls and what a project still takes", () => {
  const p = (status: "active" | "paused" | "done" | "cancelled", kind: "build" | "care_onboarding" | "custom" = "build", templateKey: string | null = null) => ({ status, kind, templateKey });
  it("an active project can be paused or cancelled, a paused one resumed or cancelled", () => {
    expect(stopControls(p("active"))).toEqual({ pause: true, resume: false, cancel: "project" });
    expect(stopControls(p("paused"))).toEqual({ pause: false, resume: true, cancel: "project" });
  });
  it("a finished Care project can only be cancelled, and says it stops the Care service", () => {
    expect(stopControls(p("done", "care_onboarding"))).toEqual({ pause: false, resume: false, cancel: "care" });
    expect(cancelLabel("care")).toMatch(/Care/);
    expect(cancelConfirm("Ace: Care onboarding", "care")).toMatch(/stops? .*Care/i);
    expect(cancelLabel("project")).toBe("Cancel project");
  });
  it("a finished SEO-0 project can only be cancelled, and says it stops Local SEO and leaves Care alone", () => {
    const seo = p("done", "custom", "SEO-0");
    expect(stopControls(seo)).toEqual({ pause: false, resume: false, cancel: "seo" });
    expect(cancelLabel("seo")).toBe("Stop Local SEO (cancel project)");
    expect(cancelLabel("seo")).not.toMatch(/Care/);
    expect(cancelConfirm("Ace: Local SEO onboarding", "seo")).toMatch(/stops this client's monthly Local SEO tasks/);
    expect(cancelConfirm("Ace: Local SEO onboarding", "seo")).toMatch(/does not touch Care/);
    expect(cancelConfirm("Ace: Local SEO onboarding", "seo").replace("does not touch Care", "")).not.toMatch(/Care/);
    expect(stepsEditable(seo)).toBe(true);
    // an active or paused SEO-0 is cancelled like any project; a cancelled one has no controls
    expect(stopControls(p("active", "custom", "SEO-0"))).toEqual({ pause: true, resume: false, cancel: "project" });
    expect(stopControls(p("cancelled", "custom", "SEO-0"))).toEqual({ pause: false, resume: false, cancel: null });
  });
  it("a finished hand-made custom project and a finished build keep no stop controls and cannot be edited", () => {
    expect(stopControls(p("done", "custom"))).toEqual({ pause: false, resume: false, cancel: null });
    expect(stepsEditable(p("done", "custom"))).toBe(false);
    expect(stopControls(p("done", "build", "BUILD"))).toEqual({ pause: false, resume: false, cancel: null });
  });
  it("a finished build and a cancelled project have no stop controls", () => {
    expect(stopControls(p("done"))).toEqual({ pause: false, resume: false, cancel: null });
    expect(stopControls(p("cancelled", "care_onboarding"))).toEqual({ pause: false, resume: false, cancel: null });
  });
  it("any project that is not cancelled takes a change order and has its steps edited, a live Care project included", () => {
    expect(["active", "paused", "done"].every((s) => canTakeChangeOrder(s as "done"))).toBe(true);
    expect(canTakeChangeOrder("cancelled")).toBe(false);
    expect(stepsEditable(p("active"))).toBe(true);
    expect(stepsEditable(p("paused"))).toBe(true);
    expect(stepsEditable(p("done", "care_onboarding"))).toBe(true);
    expect(stepsEditable(p("done"))).toBe(false);
    expect(stepsEditable(p("cancelled"))).toBe(false);
  });
});

describe("the project list for a lead", () => {
  const row = (id: string, businessId: string, status: "active" | "done" | "cancelled" = "active", kind: "build" | "care_onboarding" = "build") => ({ id, businessId, status, kind, templateKey: null, waitingOnClient: false });
  const rows = [row("1", "a"), row("2", "a", "done"), row("3", "b"), row("4", "a", "cancelled", "care_onboarding")];
  it("filters to one lead and then shows every one of its projects whatever the state", () => {
    expect(visibleProjects(rows, { view: "active", businessId: "a" }).map((r) => r.id)).toEqual(["1", "2", "4"]);
    expect(visibleProjects(rows, { view: "active", businessId: "none" })).toEqual([]);
  });
  it("without a lead it is the view's own bucket", () => {
    expect(visibleProjects(rows, { view: "active", businessId: null }).map((r) => r.id)).toEqual(["1", "3"]);
    expect(visibleProjects(rows, { view: "done", businessId: null }).map((r) => r.id)).toEqual(["2", "4"]);
  });
});

describe("blockedText", () => {
  it("names the steps a 409 says block it", () => {
    expect(blockedText({ error: "x", blockedBy: ["Write the copy", "Get logo"] })).toBe("Blocked by: Write the copy, Get logo");
  });
  it("is null for any other body", () => {
    expect(blockedText({ error: "x" })).toBeNull();
    expect(blockedText({ blockedBy: [] })).toBeNull();
    expect(blockedText(undefined)).toBeNull();
    expect(blockedText({ blockedBy: [1, 2] })).toBeNull();
  });
});

describe("dealProjects", () => {
  it("keeps only the projects of that deal, newest first as given", () => {
    const rows = [{ id: "a", dealId: "d1" }, { id: "b", dealId: "d2" }, { id: "c", dealId: null }, { id: "d", dealId: "d1" }];
    expect(dealProjects(rows, "d1").map((r) => r.id)).toEqual(["a", "d"]);
  });
});

describe("listProgress", () => {
  it("counts steps only, the same as the project page, and falls back to every task when there are no steps", () => {
    expect(listProgress({ openSteps: 2, doneSteps: 2, openTasks: 5, doneTasks: 2 })).toEqual({ done: 2, total: 4, pct: 50 });
    expect(listProgress({ openSteps: 0, doneSteps: 0, openTasks: 1, doneTasks: 1 })).toEqual({ done: 1, total: 2, pct: 50 });
    expect(listProgress({ openSteps: 0, doneSteps: 0, openTasks: 0, doneTasks: 0 })).toEqual({ done: 0, total: 0, pct: 0 });
  });
});

describe("time tab helpers", () => {
  const a = task({ title: "Started", estMinutes: 60, status: "in_progress", startedAt: "2026-11-02T00:00:00.000Z" });
  const b = task({ title: "Done untimed", estMinutes: 30, status: "done" });
  const c = task({ title: "Not started", estMinutes: 120, status: "todo" });
  const d = task({ title: "Skipped", estMinutes: 45, status: "skipped" });
  const minutes = { [a.id]: 90 };
  it("lists only tasks with time logged", () => {
    expect(timeRows([a, b, c, d], minutes).map((t) => t.title)).toEqual(["Started"]);
  });
  it("compares actual with the estimate of tasks that are started, done or timed, never unstarted or skipped ones", () => {
    expect(timeEstimate([a, b, c, d], minutes)).toBe(90);
    expect(timeEstimate([c, d], {})).toBe(0);
    expect(timeEstimate([c], { [c.id]: 10 })).toBe(120);
  });
});

describe("startOffers", () => {
  const doc = (status: string, test: boolean) => ({ status, test });
  it("offers Start projects for a won deal with none", () => {
    expect(startOffers({ stage: "won" }, [doc("signed", false)], [])).toEqual({ canStart: true, canStartTest: false });
  });
  it("offers nothing once the deal has a project, and Start only for a won deal", () => {
    expect(startOffers({ stage: "won" }, [doc("signed", false)], [{}])).toEqual({ canStart: false, canStartTest: false });
    expect(startOffers({ stage: "proposal" }, [doc("sent", false)], [])).toEqual({ canStart: false, canStartTest: false });
  });
  it("offers a test project when the latest signed proposal is a test copy (newest first)", () => {
    expect(startOffers({ stage: "proposal" }, [doc("void", false), doc("signed", true), doc("signed", false)], [])).toEqual({ canStart: false, canStartTest: true });
  });
  it("does not offer a test project when the latest signed one is real, or none is signed", () => {
    expect(startOffers({ stage: "proposal" }, [doc("signed", false), doc("signed", true)], []).canStartTest).toBe(false);
    expect(startOffers({ stage: "proposal" }, [doc("sent", true)], []).canStartTest).toBe(false);
    expect(startOffers({ stage: "proposal" }, [], []).canStartTest).toBe(false);
  });
});

describe("Work screen helpers", () => {
  const base = { status: "active" as const, kind: "build" as const, templateKey: null, waitingOnClient: false, pausedReason: null };
  it("names the kind chip, with a live Care setup as Monthly", () => {
    expect(kindChip(base).label).toBe("Build");
    expect(kindChip({ ...base, kind: "care_onboarding", templateKey: "CARE-0" }).key).toBe("onboarding");
    expect(kindChip({ ...base, kind: "care_onboarding", status: "done", templateKey: "CARE-0" }).key).toBe("monthly");
  });
  it("says why a project is paused and when it waits on the client", () => {
    expect(statusChip({ ...base, status: "paused", pausedReason: "Invoice overdue" })).toEqual({ label: "Paused · Invoice overdue", tone: "critical" });
    expect(statusChip({ ...base, waitingOnClient: true }).label).toBe("Waiting on client");
    expect(statusChip(base).label).toBe("On track");
  });
  it("groups rows by client name", () => {
    const g = groupByClient([{ businessId: "b", businessName: "Zed", name: "x" }, { businessId: "a", businessName: "Acme", name: "y" }, { businessId: "a", businessName: "Acme", name: "b" }]);
    expect(g.map((x) => x.name)).toEqual(["Acme", "Zed"]);
    expect(g[0].rows.map((r) => r.name)).toEqual(["b", "y"]);
  });
  it("says when something changed in plain words", () => {
    const now = new Date("2026-11-22T20:00:00Z");
    expect(sinceLabel("2026-11-22T19:30:00Z", now)).toBe("30 m ago");
    expect(sinceLabel("2026-11-22T17:00:00Z", now)).toBe("3 h ago");
    expect(sinceLabel("2026-11-21T10:00:00Z", now)).toBe("Yesterday");
    expect(sinceLabel("2026-11-14T10:00:00Z", now)).toBe("Nov 14");
  });
  it("finds the pager neighbours and the hours as decimals", () => {
    expect(pagerOf([{ id: "a" }, { id: "b" }, { id: "c" }], "b")).toEqual({ index: 2, total: 3, prev: { id: "a" }, next: { id: "c" } });
    expect(pagerOf([{ id: "a" }], "z")).toBeNull();
    expect(decimalHours(90)).toBe("1.5");
    expect(decimalHours(40)).toBe("0.7");
  });
});
