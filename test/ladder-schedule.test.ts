import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listLadder } from "../src/worker/db/ladder";
import { getProject, markProjectDone, type Project } from "../src/worker/db/projects";
import type { Env } from "../src/worker/env";
import { backfillLadder, ladderDoneHook } from "../src/worker/ladder/hooks";
import { decemberRow, LADDER_OFFSETS, ladderRowsFor } from "../src/worker/ladder/schedule";
import { clearProjectHooksForTests, onProjectDone, runProjectDone } from "../src/worker/projects/hooks";
import { resetProjectWork, seedProject } from "./fixtures/projects";

const e = env as Env;
const BIZ = { businessId: "b1", projectId: "p1" };

beforeEach(async () => { await env.DB.prepare(`DELETE FROM ladder_steps`).run(); await resetProjectWork(); clearProjectHooksForTests(); });
afterEach(() => { clearProjectHooksForTests(); vi.restoreAllMocks(); });

const finish = async (id: string, at: string): Promise<Project> => {
  expect(await markProjectDone(env.DB, id, at)).toBe(true);
  return (await getProject(env.DB, id))!;
};

describe("ladder schedule", () => {
  it("ladderRowsFor(\"2026-11-22\") gives 2026-11-22, 12-02, 12-22, 2027-02-20, 2027-03-22 in order", () => {
    const rows = ladderRowsFor("2026-11-22", BIZ);
    expect(rows.map((r) => r.step)).toEqual(["review_request", "testimonial", "thank_you", "check_in", "case_study"]);
    expect(rows.map((r) => r.dueOn)).toEqual(["2026-11-22", "2026-12-02", "2026-12-22", "2027-02-20", "2027-03-22"]);
    expect(rows.every((r) => r.businessId === "b1" && r.projectId === "p1")).toBe(true);
    expect(LADDER_OFFSETS).toEqual({ review_request: 0, testimonial: 10, thank_you: 30, check_in: 90, case_study: 120 });
  });

  it("a month-end launch adds days, not months", () => {
    expect(ladderRowsFor("2026-01-31", BIZ).map((r) => r.dueOn)).toEqual(["2026-01-31", "2026-02-10", "2026-03-02", "2026-05-01", "2026-05-31"]);
  });

  it("decemberRow is the first of December", () => {
    expect(decemberRow("b1", 2026)).toEqual({ businessId: "b1", projectId: null, step: "december_letter", dueOn: "2026-12-01" });
    expect(decemberRow("b1", 2027).dueOn).toBe("2027-12-01");
  });
});

describe("ladder hook", () => {
  it("finishing a build project inserts five rows; running the hook a second time for the same project (a replay) inserts none", async () => {
    const s = await seedProject();
    onProjectDone(ladderDoneHook);
    // 05:00 UTC on 3 Dec is still 2 Dec in the booking zone: the launch date is the local day.
    const done = await finish(s.project.id, "2026-12-03T05:00:00.000Z");
    await runProjectDone(e, done);
    const rows = await listLadder(env.DB, s.businessId);
    expect(rows.map((r) => [r.step, r.dueOn, r.status, r.projectId])).toEqual([
      ["review_request", "2026-12-02", "waiting", s.project.id],
      ["testimonial", "2026-12-12", "waiting", s.project.id],
      ["thank_you", "2027-01-01", "waiting", s.project.id],
      ["check_in", "2027-03-02", "waiting", s.project.id],
      ["case_study", "2027-04-01", "waiting", s.project.id],
    ]);
    await runProjectDone(e, done);
    expect(await listLadder(env.DB, s.businessId)).toHaveLength(5);
  });

  it("does nothing for a project that is not done, and logs instead of throwing", async () => {
    const s = await seedProject();
    await ladderDoneHook(e, s.project);
    expect(await listLadder(env.DB, s.businessId)).toHaveLength(0);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const done = await finish(s.project.id, "2026-12-03T18:00:00.000Z");
    const broken = { ...e, DB: { prepare: () => { throw new Error("db down"); } } } as unknown as Env;
    await expect(ladderDoneHook(broken, done)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("a quick_fix, care_onboarding, custom or test project inserts nothing", async () => {
    for (const kind of ["quick_fix", "care_onboarding", "custom"] as const) {
      const s = await seedProject({ kind });
      await ladderDoneHook(e, await finish(s.project.id, "2026-12-03T18:00:00.000Z"));
      expect(await listLadder(env.DB, s.businessId)).toHaveLength(0);
    }
    const t = await seedProject({ test: true });
    await ladderDoneHook(e, await finish(t.project.id, "2026-12-03T18:00:00.000Z"));
    expect(await listLadder(env.DB, t.businessId)).toHaveLength(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ladder_steps`).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("backfillLadder", () => {
  const NOW = new Date("2026-12-10T18:00:00.000Z");

  it("inserts rows from the done date, skips a project with rows, skips one done more than 180 days ago, and is idempotent", async () => {
    const fresh = await seedProject();
    await finish(fresh.project.id, "2026-12-01T05:00:00.000Z"); // 30 Nov in the booking zone
    const withRows = await seedProject();
    await ladderDoneHook(e, await finish(withRows.project.id, "2026-12-05T18:00:00.000Z"));
    const old = await seedProject();
    await finish(old.project.id, "2026-05-01T18:00:00.000Z"); // 223 days before NOW
    const quick = await seedProject({ kind: "quick_fix" });
    await finish(quick.project.id, "2026-12-02T18:00:00.000Z");
    const test = await seedProject({ test: true });
    await finish(test.project.id, "2026-12-02T18:00:00.000Z");
    const active = await seedProject();
    expect(active.project.status).toBe("active");

    expect(await backfillLadder(e, NOW)).toBe(5);
    expect((await listLadder(env.DB, fresh.businessId)).map((r) => r.dueOn)).toEqual(["2026-11-30", "2026-12-10", "2026-12-30", "2027-02-28", "2027-03-30"]);
    expect(await listLadder(env.DB, withRows.businessId)).toHaveLength(5);
    for (const s of [old, quick, test, active]) expect(await listLadder(env.DB, s.businessId)).toHaveLength(0);

    expect(await backfillLadder(e, NOW)).toBe(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ladder_steps`).first<{ n: number }>())!.n).toBe(10);
  });
});
