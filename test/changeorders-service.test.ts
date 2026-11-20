import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { ChangeOrderInputError, ChangeOrderStateError, declineChangeOrder, getChangeOrder, signChangeOrder, expireDue } from "../src/worker/db/changeOrders";
import { getPackage, savePackage } from "../src/worker/db/packages";
import { setProjectStatus } from "../src/worker/db/projects";
import { listComments, listTasks } from "../src/worker/db/tasks";
import {
  afterSigned, changeOrderLink, draftChangeOrder, editDraft, markChangeOrderPaid, unlockIfReady, voidDraftOrSent,
} from "../src/worker/changeorders/service";
import { clearProjectHooksForTests, onTasksChanged } from "../src/worker/projects/hooks";
import type { Env } from "../src/worker/env";
import { clientSig, seal, secondProject, NOW_ISO } from "./fixtures/changeorders";
import { seedProject } from "./fixtures/projects";
import { readyToSend } from "./fixtures/documents";

const e = env as Env;
const NOW = new Date("2026-12-06T12:00:00.000Z");

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => { clearProjectHooksForTests(); errors = vi.spyOn(console, "error").mockImplementation(() => {}); await readyToSend(); });
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); });

const base = { title: "Add a gallery page", summary: "Twelve job photos.", reason: "The client asked.", sourceType: "logan" as const };
const tasksOf = async (projectId: string, coId: string) => (await listTasks(env.DB, projectId)).filter((t) => t.changeOrderId === coId);
const logs = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");

/** A drafted order with two deliverables, signed by the client (not yet paid). */
async function signedOrder(o: { test?: boolean } = {}) {
  const s = await seedProject({ test: o.test });
  const draft = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 2, deliverables: ["Build the page", "Add the photos"] });
  const sent = await seal(draft);
  expect(await signChangeOrder(env.DB, sent.id, clientSig(sent.contentSha256!), NOW.toISOString())).toBe("signed");
  return { ...s, id: sent.id };
}

describe("draftChangeOrder", () => {
  it("drafting prices hours at the hourly rate and rounds to cents", async () => {
    const s = await seedProject();
    const hourly = (await getPackage(env.DB, "hourly"))!;
    const co = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1.75 });
    expect(co.content).toMatchObject({ hours: 1.75, rateCents: hourly.priceCents, priceCents: Math.round(1.75 * hourly.priceCents) });
    expect(Number.isInteger(co.content.priceCents)).toBe(true);
    // 0.25 h at $99.99 an hour is 2499.75 cents: it rounds, it is never a fraction
    expect((await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 0.25, rateCents: 9999 })).content.priceCents).toBe(2500);
    // the rate is the catalog's rate NOW
    await savePackage(env.DB, "hourly", { priceCents: hourly.priceCents + 1000 });
    expect((await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 })).content.rateCents).toBe(hourly.priceCents + 1000);
  });

  it("a client name with line breaks is one line on the order", async () => {
    const s = await seedProject({ bare: true });
    await env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind("Ace\n\n  Plumbing\r\nCo", s.businessId).run();
    const co = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 });
    expect(co.content.clientName).toBe("Ace Plumbing Co");
  });

  it("a custom price is kept", async () => {
    const s = await seedProject();
    const co = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 3, priceCents: 20000 });
    expect(co.content).toMatchObject({ hours: 3, priceCents: 20000 });
  });

  it("copies the deal, the test flag and the client's details from the project", async () => {
    const real = await seedProject();
    const co = await draftChangeOrder(e, { ...base, projectId: real.project.id, hours: 1 });
    expect(co).toMatchObject({ status: "draft", projectId: real.project.id, businessId: real.businessId, dealId: real.dealId, test: false, seq: 1, sourceType: "logan", originApprovalId: null });
    expect(co.content).toMatchObject({ reference: "SL-ABCDEF-BUILD-CO1", clientName: "Ace Plumbing", contactName: "Pat Jones", contactEmail: "pat@ace.test", scheduleImpactDays: null });
    const test = await seedProject({ test: true });
    expect((await draftChangeOrder(e, { ...base, projectId: test.project.id, hours: 1 })).test).toBe(true);
  });

  it("a done project refuses a change order, and so do a cancelled and an unknown one", async () => {
    const done = await seedProject();
    await setProjectStatus(env.DB, done.project.id, "done");
    await expect(draftChangeOrder(e, { ...base, projectId: done.project.id, hours: 1 })).rejects.toThrow(/project is done/);
    const gone = await seedProject();
    await setProjectStatus(env.DB, gone.project.id, "cancelled");
    await expect(draftChangeOrder(e, { ...base, projectId: gone.project.id, hours: 1 })).rejects.toBeInstanceOf(ChangeOrderStateError);
    await expect(draftChangeOrder(e, { ...base, projectId: "nope", hours: 1 })).rejects.toThrow(/no such project/);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_orders WHERE project_id IN (?, ?)`).bind(done.project.id, gone.project.id).first<{ n: number }>()).toEqual({ n: 0 });
    // a paused project is still a project: the client can ask while it waits
    const paused = await seedProject();
    await setProjectStatus(env.DB, paused.project.id, "paused", { reason: "invoice overdue" });
    expect((await draftChangeOrder(e, { ...base, projectId: paused.project.id, hours: 1 })).status).toBe("draft");
  });

  it("refuses bad hours, an empty title and text that reads like a login", async () => {
    const s = await seedProject();
    await expect(draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 0.3 })).rejects.toBeInstanceOf(ChangeOrderInputError);
    await expect(draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1, title: "  " })).rejects.toBeInstanceOf(ChangeOrderInputError);
    await expect(draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1, summary: "the password: hunter2" })).rejects.toThrow(/login or password/);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_orders WHERE project_id = ?`).bind(s.project.id).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("a draft's tasks are locked, billable and on the project", async () => {
    const s = await seedProject();
    const before = await listTasks(env.DB, s.project.id);
    const co = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 2.5, deliverables: ["Build the page", "Add the photos", "Test it on a phone"] });
    const mine = await tasksOf(s.project.id, co.id);
    expect(mine.map((t) => t.title)).toEqual(["Build the page", "Add the photos", "Test it on a phone"]);
    for (const t of mine) {
      expect(t).toMatchObject({ projectId: s.project.id, businessId: s.businessId, status: "locked", billable: true, isStep: false, stepKey: null, changeOrderId: co.id, owner: "logan" });
    }
    expect(mine.reduce((n, t) => n + t.estMinutes, 0)).toBe(150);
    expect(Math.min(...mine.map((t) => t.position))).toBeGreaterThan(before.reduce((m, t) => Math.max(m, t.position), -1));
  });

  it("no deliverables makes one task named after the change order", async () => {
    const s = await seedProject();
    const co = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1.5 });
    const mine = await tasksOf(s.project.id, co.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: "Add a gallery page", status: "locked", billable: true, estMinutes: 90 });
  });

  it("the same drafting approval makes one order and one set of tasks", async () => {
    const s = await seedProject();
    const a = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1, deliverables: ["One", "Two"], originApprovalId: "appr-1" });
    const b = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1, deliverables: ["One", "Two"], originApprovalId: "appr-1" });
    expect(b.id).toBe(a.id);
    expect(await tasksOf(s.project.id, a.id)).toHaveLength(2);
    // a replay heals an order whose tasks were never made
    await env.DB.prepare(`DELETE FROM tasks WHERE change_order_id = ?`).bind(a.id).run();
    await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1, deliverables: ["One", "Two"], originApprovalId: "appr-1" });
    expect(await tasksOf(s.project.id, a.id)).toHaveLength(2);
  });
});

describe("editDraft", () => {
  it("re-prices when the hours change, keeps a price set by hand, and follows the deliverables", async () => {
    const s = await seedProject();
    const co = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 2, rateCents: 10000 });
    const more = await editDraft(e, co.id, { hours: 3 });
    expect(more.content).toMatchObject({ hours: 3, priceCents: 30000 });
    const hand = await editDraft(e, co.id, { priceCents: 25000 });
    expect(hand.content.priceCents).toBe(25000);
    expect((await editDraft(e, co.id, { hours: 4 })).content.priceCents).toBe(25000); // the hand-set price stays
    const withTasks = await editDraft(e, co.id, { deliverables: ["A", "B"] });
    expect((await tasksOf(s.project.id, withTasks.id)).map((t) => t.title)).toEqual(["A", "B"]);
    await editDraft(e, co.id, { deliverables: ["A"], title: undefined });
    expect((await tasksOf(s.project.id, co.id)).map((t) => t.title)).toEqual(["A"]);
    await expect(editDraft(e, co.id, { hours: 0.3 })).rejects.toBeInstanceOf(ChangeOrderInputError);
  });

  it("refuses a sent order", async () => {
    const s = await seedProject();
    const sent = await seal(await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 }));
    await expect(editDraft(e, sent.id, { title: "Sneaky" })).rejects.toThrow(/Only a draft can be edited/);
    expect((await getChangeOrder(env.DB, sent.id))!.content.title).toBe("Add a gallery page");
  });
});

describe("unlocking", () => {
  it("signed alone does not unlock", async () => {
    const s = await signedOrder();
    await afterSigned(e, s.id, NOW);
    expect((await tasksOf(s.project.id, s.id)).map((t) => t.status)).toEqual(["locked", "locked"]);
    expect(await unlockIfReady(e, s.id, NOW)).toBe(0);
    expect(await logs(s.businessId, "change_order_signed")).toEqual([`SL-ABCDEF-BUILD-CO1 (${s.id.slice(0, 8)}) signed by Pat Jones`]);
  });

  it("afterSigned logs once however often it runs", async () => {
    const s = await signedOrder();
    await afterSigned(e, s.id, NOW);
    await afterSigned(e, s.id, NOW);
    expect(await logs(s.businessId, "change_order_signed")).toHaveLength(1);
  });

  it("afterSigned does nothing for an order that is not signed", async () => {
    const s = await seedProject();
    const sent = await seal(await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 }));
    await afterSigned(e, sent.id, NOW);
    expect(await logs(s.businessId, "change_order_signed")).toEqual([]);
  });

  it("paid alone before signing is a 409", async () => {
    const s = await seedProject();
    const sent = await seal(await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 }));
    await expect(markChangeOrderPaid(e, sent.id, { via: "manual", now: NOW })).rejects.toBeInstanceOf(ChangeOrderStateError);
    await expect(markChangeOrderPaid(e, sent.id, { via: "manual", now: NOW })).rejects.toThrow(/not been signed/);
    const draft = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 });
    await expect(markChangeOrderPaid(e, draft.id, { via: "stripe", now: NOW })).rejects.toBeInstanceOf(ChangeOrderStateError);
    expect((await getChangeOrder(env.DB, sent.id))!.paidAt).toBeNull();
    expect(await logs(s.businessId, "change_order_paid")).toEqual([]);
    await expect(markChangeOrderPaid(e, "nope", { via: "manual", now: NOW })).rejects.toBeInstanceOf(ChangeOrderStateError);
  });

  it("signed then paid unlocks the locked tasks once, and a replayed paid unlocks none", async () => {
    const changed: string[] = [];
    onTasksChanged(async (_env, id) => { changed.push(id); });
    const s = await signedOrder();
    await afterSigned(e, s.id, NOW);
    const paid = await markChangeOrderPaid(e, s.id, { via: "manual", now: NOW });
    expect(paid).toMatchObject({ status: "signed", paidAt: NOW.toISOString(), paidVia: "manual" });
    const mine = await tasksOf(s.project.id, s.id);
    expect(mine.map((t) => t.status)).toEqual(["todo", "todo"]);
    expect(changed).toEqual([s.project.id]);
    expect((await listComments(env.DB, mine[0].id)).map((c) => [c.author, c.body])).toEqual([["system", "Unlocked: the change order is signed and paid."]]);

    // replays: nothing more is unlocked, logged or fired, and the first payment stands
    const again = await markChangeOrderPaid(e, s.id, { via: "stripe", now: new Date("2026-12-07T00:00:00.000Z") });
    expect(again).toMatchObject({ paidAt: NOW.toISOString(), paidVia: "manual" });
    expect(await unlockIfReady(e, s.id, NOW)).toBe(0);
    expect(changed).toEqual([s.project.id]);
    expect(await logs(s.businessId, "change_order_paid")).toEqual([`SL-ABCDEF-BUILD-CO1 (${s.id.slice(0, 8)}) paid (outside Stripe)`]);
    expect((await listComments(env.DB, mine[0].id))).toHaveLength(1);
  });

  it("a task someone has already moved on is not touched again", async () => {
    const s = await signedOrder();
    await markChangeOrderPaid(e, s.id, { via: "stripe", now: NOW });
    const [first] = await tasksOf(s.project.id, s.id);
    await env.DB.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).bind(first.id).run();
    expect(await unlockIfReady(e, s.id, NOW)).toBe(0);
    expect((await tasksOf(s.project.id, s.id))[0].status).toBe("in_progress");
  });

  it("a call that died after recording the payment is repaired by repeating it", async () => {
    const s = await signedOrder();
    await env.DB.prepare(`UPDATE change_orders SET paid_at = ?, paid_via = 'manual' WHERE id = ?`).bind(NOW.toISOString(), s.id).run();
    expect((await tasksOf(s.project.id, s.id)).map((t) => t.status)).toEqual(["locked", "locked"]);
    await markChangeOrderPaid(e, s.id, { via: "manual", now: NOW });
    expect((await tasksOf(s.project.id, s.id)).map((t) => t.status)).toEqual(["todo", "todo"]);
  });

  it("two payments at once unlock each task once and log once", async () => {
    const s = await signedOrder();
    await Promise.all([1, 2, 3].map(() => markChangeOrderPaid(e, s.id, { via: "stripe", now: NOW })));
    expect((await tasksOf(s.project.id, s.id)).map((t) => t.status)).toEqual(["todo", "todo"]);
    expect(await logs(s.businessId, "change_order_paid")).toHaveLength(1);
    for (const t of await tasksOf(s.project.id, s.id)) expect(await listComments(env.DB, t.id)).toHaveLength(1);
  });
});

describe("voiding", () => {
  it("voiding a signed order is refused", async () => {
    const s = await signedOrder();
    await expect(voidDraftOrSent(e, s.id, "changed my mind", NOW)).rejects.toBeInstanceOf(ChangeOrderStateError);
    expect((await getChangeOrder(env.DB, s.id))!.status).toBe("signed");
    expect((await tasksOf(s.project.id, s.id)).map((t) => t.status)).toEqual(["locked", "locked"]);
  });

  it("voiding a sent order skips its tasks", async () => {
    const s = await seedProject();
    const sent = await seal(await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 2, deliverables: ["One", "Two"] }));
    const voided = await voidDraftOrSent(e, sent.id, "client changed their mind", NOW);
    expect(voided).toMatchObject({ status: "void", voidReason: "client changed their mind" });
    const mine = await tasksOf(s.project.id, sent.id);
    expect(mine.map((t) => t.status)).toEqual(["skipped", "skipped"]);
    expect((await listComments(env.DB, mine[0].id)).map((c) => [c.author, c.body])).toEqual([["system", "Skipped: the change order was voided (client changed their mind)"]]);
    expect(await logs(s.businessId, "change_order_void")).toEqual([`SL-ABCDEF-BUILD-CO1 (${sent.id.slice(0, 8)}) voided: client changed their mind`]);
    // repeating it changes and logs nothing more
    await voidDraftOrSent(e, sent.id, "client changed their mind", NOW);
    expect(await logs(s.businessId, "change_order_void")).toHaveLength(1);
    expect(await listComments(env.DB, mine[0].id)).toHaveLength(1);
  });

  it("a void that died before the tasks were skipped is repaired by repeating it", async () => {
    const s = await seedProject();
    const sent = await seal(await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 }));
    await env.DB.prepare(`UPDATE change_orders SET status = 'void', void_reason = 'x' WHERE id = ?`).bind(sent.id).run();
    await voidDraftOrSent(e, sent.id, "x again", NOW);
    expect((await tasksOf(s.project.id, sent.id)).map((t) => t.status)).toEqual(["skipped"]);
  });

  it("voids a draft and needs a plain reason", async () => {
    const s = await seedProject();
    const d = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 });
    await expect(voidDraftOrSent(e, d.id, "ok", NOW)).rejects.toBeInstanceOf(ChangeOrderInputError);
    await expect(voidDraftOrSent(e, d.id, "password: abc", NOW)).rejects.toThrow(/login or password/);
    expect((await voidDraftOrSent(e, d.id, "not needed", NOW)).status).toBe("void");
    expect((await tasksOf(s.project.id, d.id)).map((t) => t.status)).toEqual(["skipped"]);
  });
});

describe("expiry", () => {
  it("expireDue expires a sent order past expiresAt and its tasks stay locked", async () => {
    const s = await seedProject();
    const sent = await seal(await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1, deliverables: ["One", "Two"] }), new Date(NOW_ISO));
    expect(sent.expiresAt).toBe("2027-01-04T10:00:00.000Z"); // the 30 days the settings give
    const gone = await expireDue(env.DB, "2027-01-04T10:00:00.001Z");
    expect(gone.map((x) => x.id)).toContain(sent.id); // (orders other tests left open are due too)
    expect((await getChangeOrder(env.DB, sent.id))!.status).toBe("expired");
    expect((await tasksOf(s.project.id, sent.id)).map((t) => t.status)).toEqual(["locked", "locked"]);
    expect(await unlockIfReady(e, sent.id, NOW)).toBe(0);
  });
});

describe("changeOrderLink", () => {
  it("is the client base and the token, and null without a token", async () => {
    const s = await seedProject();
    const draft = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 });
    expect(changeOrderLink(e, draft)).toBeNull();
    const sent = await seal(draft);
    expect(changeOrderLink(e, sent)).toBe(`https://clients.hellositeline.test/c/${sent.token}`);
    expect(changeOrderLink({ ...e, CLIENT_LINK_BASE: "" } as Env, sent)).toBeNull();
    expect(changeOrderLink({ ...e, CLIENT_LINK_BASE: "https://x.workers.dev" } as Env, sent)).toBeNull();
  });
});

describe("references are unique across a sale's projects", () => {
  it("two projects from one proposal each draft an order with their own reference, and both signed lines survive", async () => {
    const build = await seedProject();
    const care = await secondProject(build, { templateKey: "CARE-0", kind: "care_onboarding" });
    const custom = await secondProject(build, { templateKey: null, kind: "custom" });
    const a = await draftChangeOrder(e, { ...base, projectId: build.project.id, hours: 1 });
    const b = await draftChangeOrder(e, { ...base, projectId: care.id, hours: 1 });
    const c = await draftChangeOrder(e, { ...base, projectId: custom.id, hours: 1 });
    expect([a, b, c].map((x) => x.content.reference)).toEqual(["SL-ABCDEF-BUILD-CO1", "SL-ABCDEF-CARE0-CO1", "SL-ABCDEF-CUSTOM-CO1"]);
    expect([a, b, c].map((x) => x.seq)).toEqual([1, 1, 1]);
    for (const x of [a, b]) {
      const sent = await seal(x);
      expect(await signChangeOrder(env.DB, sent.id, clientSig(sent.contentSha256!), NOW.toISOString())).toBe("signed");
      await afterSigned(e, sent.id, NOW);
      await markChangeOrderPaid(e, sent.id, { via: "manual", now: NOW });
    }
    const signed = await logs(build.businessId, "change_order_signed");
    expect(signed.filter((l) => l.startsWith("SL-ABCDEF-BUILD-CO1"))).toHaveLength(1);
    expect(signed.filter((l) => l.startsWith("SL-ABCDEF-CARE0-CO1"))).toHaveLength(1);
    const paid = await logs(build.businessId, "change_order_paid");
    expect(paid.filter((l) => /CARE0-CO1|BUILD-CO1/.test(l))).toHaveLength(2);
  });

  it("two orders with the same reference text can still not merge: the order's id is in every line", async () => {
    const s = await seedProject();
    const a = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 });
    const b = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 });
    expect(a.content.reference).not.toBe(b.content.reference);
    await env.DB.prepare(`UPDATE change_orders SET content = ? WHERE id = ?`).bind(JSON.stringify(a.content), b.id).run(); // force the same reference text
    for (const x of [a, b]) {
      const sent = await seal((await getChangeOrder(env.DB, x.id))!);
      await signChangeOrder(env.DB, sent.id, clientSig(sent.contentSha256!), NOW.toISOString());
      await afterSigned(e, sent.id, NOW);
    }
    expect(await logs(s.businessId, "change_order_signed")).toHaveLength(2);
  });
});

describe("voiding a dead end", () => {
  it("a declined order can be voided and its locked tasks are skipped with a note", async () => {
    const s = await seedProject();
    const sent = await seal(await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1, deliverables: ["One", "Two"] }));
    expect(await declineChangeOrder(env.DB, sent.id, "too much", NOW.toISOString())).toBe("declined");
    expect((await tasksOf(s.project.id, sent.id)).map((t) => t.status)).toEqual(["locked", "locked"]);
    expect((await voidDraftOrSent(e, sent.id, "client said no", NOW)).status).toBe("void");
    const mine = await tasksOf(s.project.id, sent.id);
    expect(mine.map((t) => t.status)).toEqual(["skipped", "skipped"]);
    expect((await listComments(env.DB, mine[0].id)).map((c) => c.body)).toEqual(["Skipped: the change order was voided (client said no)"]);
  });

  it("an expired order can be voided, and until then its tasks stay locked", async () => {
    const s = await seedProject();
    const sent = await seal(await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 }), new Date(NOW_ISO));
    await expireDue(env.DB, "2027-02-01T00:00:00.000Z");
    expect((await tasksOf(s.project.id, sent.id)).map((t) => t.status)).toEqual(["locked"]);
    expect((await voidDraftOrSent(e, sent.id, "it lapsed", NOW)).status).toBe("void");
    expect((await tasksOf(s.project.id, sent.id)).map((t) => t.status)).toEqual(["skipped"]);
  });
});
