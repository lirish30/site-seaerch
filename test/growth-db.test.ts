import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { describeActivity } from "../src/client/activityView";
import { countAutoApprovalsOn, listAutoApprovals, listRules, recordAutoApproval, setRule } from "../src/worker/db/autoApprove";
import { getGrades, setGrade } from "../src/worker/db/grade";
import { dueLadderRows, insertLadderRows, listLadder, setLadderLink, setLadderStatus } from "../src/worker/db/ladder";
import { createPost, getPost, listPosts, patchPost } from "../src/worker/db/studio";
import { seedClient } from "./fixtures/clients";

const T0 = "2026-12-01T10:00:00.000Z";
const T1 = "2026-12-01T11:00:00.000Z";

describe("ladder", () => {
  it("duplicate (business, step, due_on) inserts once and returns 0 the second time", async () => {
    const s = await seedClient();
    const row = { businessId: s.businessId, projectId: null, step: "review_request" as const, dueOn: "2026-12-10" };
    expect(await insertLadderRows(env.DB, [row], T0)).toBe(1);
    expect(await insertLadderRows(env.DB, [row], T1)).toBe(0);
    expect(await insertLadderRows(env.DB, [row, { ...row, step: "thank_you" }], T1)).toBe(1);
    const rows = await listLadder(env.DB, s.businessId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ businessId: s.businessId, projectId: null, step: "review_request", dueOn: "2026-12-10", status: "waiting", approvalId: null, link: null, note: "", createdAt: T0, doneAt: null });
  });

  it("dueLadderRows returns only waiting rows due on or before the day, oldest first, at most limit", async () => {
    const s = await seedClient();
    const b = s.businessId;
    await insertLadderRows(env.DB, [
      { businessId: b, projectId: null, step: "check_in", dueOn: "2026-12-05" },
      { businessId: b, projectId: null, step: "review_request", dueOn: "2026-12-02" },
      { businessId: b, projectId: null, step: "thank_you", dueOn: "2026-12-03" },
      { businessId: b, projectId: null, step: "testimonial", dueOn: "2026-12-20" },
      { businessId: b, projectId: null, step: "case_study", dueOn: "2026-12-01" },
    ], T0);
    const done = (await listLadder(env.DB, b)).find((r) => r.step === "case_study")!;
    await setLadderStatus(env.DB, done.id, "skipped", { now: T1 });
    const due = await dueLadderRows(env.DB, "2026-12-05", 10);
    expect(due.filter((r) => r.businessId === b).map((r) => r.step)).toEqual(["review_request", "thank_you", "check_in"]);
    expect((await dueLadderRows(env.DB, "2026-12-05", 2)).length).toBe(2);
  });

  it("setLadderStatus refuses nothing but only touches the row it is given", async () => {
    const s = await seedClient();
    const b = s.businessId;
    await insertLadderRows(env.DB, [
      { businessId: b, projectId: null, step: "review_request", dueOn: "2026-12-02" },
      { businessId: b, projectId: null, step: "thank_you", dueOn: "2026-12-03" },
    ], T0);
    const [a, other] = await listLadder(env.DB, b);
    expect(await setLadderStatus(env.DB, a.id, "drafted", { approvalId: "ap1", note: "queued" })).toBe(true);
    expect(await setLadderStatus(env.DB, a.id, "done", { now: T1 })).toBe(true);
    expect(await setLadderLink(env.DB, a.id, "https://g.page/r/x")).toBe(true);
    expect(await setLadderStatus(env.DB, "missing", "done", {})).toBe(false);
    expect(await setLadderLink(env.DB, "missing", null)).toBe(false);
    const rows = await listLadder(env.DB, b);
    expect(rows.find((r) => r.id === a.id)).toMatchObject({ status: "done", approvalId: "ap1", note: "queued", link: "https://g.page/r/x", doneAt: T1 });
    expect(rows.find((r) => r.id === other.id)).toMatchObject({ status: "waiting", approvalId: null, note: "", link: null, doneAt: null });
    expect(await setLadderLink(env.DB, a.id, null)).toBe(true);
    expect((await listLadder(env.DB, b)).find((r) => r.id === a.id)!.link).toBeNull();
  });
});

describe("auto-approve", () => {
  it("setRule on stamps enabled_at, setRule off clears it", async () => {
    await setRule(env.DB, "review_reply", true, T0);
    expect((await listRules(env.DB)).find((r) => r.kind === "review_reply")).toEqual({ kind: "review_reply", enabled: true, enabledAt: T0 });
    await setRule(env.DB, "review_reply", false, T1);
    expect((await listRules(env.DB)).find((r) => r.kind === "review_reply")).toEqual({ kind: "review_reply", enabled: false, enabledAt: null });
  });

  it("countAutoApprovalsOn counts one local day only", async () => {
    const base = { kind: "review_reply", businessId: null, decidedAt: T0, outcome: "sent" as const };
    await recordAutoApproval(env.DB, { ...base, approvalId: "a1", decidedOn: "2026-12-01" });
    await recordAutoApproval(env.DB, { ...base, approvalId: "a2", decidedOn: "2026-12-01" });
    await recordAutoApproval(env.DB, { ...base, approvalId: "a3", decidedOn: "2026-12-02" });
    expect(await countAutoApprovalsOn(env.DB, "2026-12-01")).toBe(2);
    expect(await countAutoApprovalsOn(env.DB, "2026-12-02")).toBe(1);
    expect(await countAutoApprovalsOn(env.DB, "2026-12-03")).toBe(0);
  });

  it("recordAutoApproval twice for one approval keeps one row (the later outcome)", async () => {
    const s = await seedClient();
    await recordAutoApproval(env.DB, { approvalId: "b1", kind: "review_reply", businessId: s.businessId, decidedAt: T0, decidedOn: "2026-12-04", outcome: "failed", error: "mail down" });
    await recordAutoApproval(env.DB, { approvalId: "b1", kind: "review_reply", businessId: s.businessId, decidedAt: T1, decidedOn: "2026-12-04", outcome: "sent" });
    expect(await countAutoApprovalsOn(env.DB, "2026-12-04")).toBe(1);
    const list = await listAutoApprovals(env.DB, 50);
    const row = list.find((r) => r.approvalId === "b1")!;
    expect(row).toMatchObject({ approvalId: "b1", kind: "review_reply", businessId: s.businessId, decidedAt: T1, outcome: "sent", error: null });
    expect(row.businessName).toBeTruthy();
  });
});

describe("grade", () => {
  it("setGrade then getGrades round-trips, setGrade null clears the grade and the set time", async () => {
    const s = await seedClient();
    const none = await getGrades(env.DB, [s.businessId]);
    expect(none.get(s.businessId)).toEqual({ grade: null, note: "", setAt: null });
    await setGrade(env.DB, s.businessId, "B", "pays late", T0);
    expect((await getGrades(env.DB, [s.businessId])).get(s.businessId)).toEqual({ grade: "B", note: "pays late", setAt: T0 });
    await setGrade(env.DB, s.businessId, null, "", T1);
    expect((await getGrades(env.DB, [s.businessId])).get(s.businessId)).toEqual({ grade: null, note: "", setAt: null });
    expect((await getGrades(env.DB, [])).size).toBe(0);
  });

  it("grade other than A, B, C is refused by the CHECK", async () => {
    const s = await seedClient();
    await expect(env.DB.prepare(`UPDATE businesses SET client_grade = 'D' WHERE id = ?`).bind(s.businessId).run()).rejects.toThrow();
  });
});

describe("studio posts", () => {
  it("createPost then patchPost round-trips JSON fields and imageKeys", async () => {
    const s = await seedClient();
    const p = await createPost(env.DB, { kind: "before_after", businessId: s.businessId, source: { before: "a", after: "b" }, anonymize: true }, T0);
    expect(p).toMatchObject({ kind: "before_after", status: "draft", businessId: s.businessId, source: { before: "a", after: "b" }, anonymize: true, agreedAt: null, copy: {}, imageKeys: [], claudeTaskId: null, approvalId: null, postedOn: null, createdAt: T0, updatedAt: T0 });
    const q = await patchPost(env.DB, p.id, { status: "review", copy: { headline: "Hi" }, imageKeys: ["k1", "k2"], claudeTaskId: "t1", anonymize: false, agreedAt: T1 }, T1);
    expect(q).toMatchObject({ status: "review", copy: { headline: "Hi" }, imageKeys: ["k1", "k2"], claudeTaskId: "t1", anonymize: false, agreedAt: T1, createdAt: T0, updatedAt: T1 });
    expect(await getPost(env.DB, p.id)).toEqual(q);
    expect(await patchPost(env.DB, "missing", { status: "posted" }, T1)).toBeNull();
    const other = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: true }, "2026-12-02T10:00:00.000Z");
    expect(other.businessId).toBeNull();
    expect((await listPosts(env.DB)).map((x) => x.id).slice(0, 2)).toEqual([other.id, p.id]);
    expect((await listPosts(env.DB, { status: ["review"] })).map((x) => x.id)).toEqual([p.id]);
  });
});

describe("growth activity kinds", () => {
  it("have labels", () => {
    expect(describeActivity({ kind: "grade_set", detail: "A" }).title).toBe("Client grade set");
    expect(describeActivity({ kind: "ladder_sent", detail: null }).title).toBe("Ladder step sent");
    expect(describeActivity({ kind: "auto_approved", detail: null }).title).toBe("Auto-approved");
    expect(describeActivity({ kind: "studio_posted", detail: null }).title).toBe("Studio post published");
  });
});
