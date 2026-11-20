import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { createChangeOrderSendApproval } from "../src/worker/approvals/changeOrderSend";
import { getHandler } from "../src/worker/approvals/registry";
import { editDraft, draftChangeOrder, voidDraftOrSent } from "../src/worker/changeorders/service";
import { listActivity } from "../src/worker/db/activity";
import { getChangeOrder, listChangeOrders } from "../src/worker/db/changeOrders";
import { saveSettings } from "../src/worker/db/settings";
import { listTasks } from "../src/worker/db/tasks";
import { setProjectStatus } from "../src/worker/db/projects";
import { addDoNotContact, removeDoNotContact } from "../src/worker/db/doNotContact";
import { canonicalJson, sha256Hex } from "../src/worker/documents/hash";
import { setMailDeps } from "../src/worker/mail/deps";
import { linkProblem } from "../src/worker/mail/send";
import type { Env } from "../src/worker/env";
import { OWNER_EMAIL, SENT_AT, readyToSend } from "./fixtures/documents";
import { seedProject } from "./fixtures/projects";

const e = env as Env;
const BASE = "https://clients.hellositeline.test";
let mail: Awaited<ReturnType<typeof readyToSend>>;
beforeEach(async () => { mail = await readyToSend(); });
afterEach(() => setMailDeps(null));

const base = { title: "Add a gallery page", summary: "Twelve job photos.", reason: "The client asked.", sourceType: "logan" as const };
async function ready(o: { test?: boolean; hours?: number; deliverables?: string[] } = {}) {
  const s = await seedProject({ test: o.test });
  const co = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: o.hours ?? 2, deliverables: o.deliverables });
  return { ...s, co };
}
const row = (id: string) => env.DB.prepare(`SELECT status, error, decision_note FROM approvals WHERE id = ?`).bind(id).first<{ status: string; error: string | null; decision_note: string | null }>();
const pendingFor = async (coId: string) => (await env.DB.prepare(`SELECT id FROM approvals WHERE kind = 'change_order.send' AND status = 'pending' AND json_extract(payload, '$.changeOrderId') = ?`).bind(coId).all<{ id: string }>()).results;
const kinds = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");

describe("change_order.send approval", () => {
  it("one waiting send approval per order and an edit withdraws it", async () => {
    const { co } = await ready();
    const a = await createChangeOrderSendApproval(e, co);
    expect(a).toMatchObject({ kind: "change_order.send", title: "Send change order SL-ABCDEF-CO1 to Ace Plumbing", payload: { changeOrderId: co.id }, record_type: "project", record_id: co.projectId, drafted_by: "logan", status: "pending" });
    expect((await createChangeOrderSendApproval(e, co)).id).toBe(a.id);
    expect(await pendingFor(co.id)).toHaveLength(1);

    await editDraft(e, co.id, { hours: 3 });
    expect(await row(a.id)).toMatchObject({ status: "rejected", decision_note: "the change order was edited after it was sent for approval" });
    expect(await pendingFor(co.id)).toHaveLength(0);
    const b = await createChangeOrderSendApproval(e, (await getChangeOrder(env.DB, co.id))!);
    expect(b.id).not.toBe(a.id);
    expect(await pendingFor(co.id)).toHaveLength(1);
    // voiding the order withdraws the waiting one too
    await voidDraftOrSent(e, co.id, "not needed now");
    expect(await row(b.id)).toMatchObject({ status: "rejected" });
  });

  it("the preview shows who it goes to, the mail, the hours, the rate, the price and the schedule impact", async () => {
    const { co } = await ready({ hours: 2.5, deliverables: ["Build it", "Test it"] });
    await editDraft(e, co.id, { scheduleImpactDays: 3, rateCents: 12000 });
    const a = await createChangeOrderSendApproval(e, (await getChangeOrder(env.DB, co.id))!);
    expect(a.preview).toContain("To: Pat Jones <pat@ace.test>");
    expect(a.preview).toContain("Subject: Change order for Ace Plumbing: Add a gallery page");
    expect(a.preview).toContain("Hi Pat,");
    expect(a.preview).toContain("2.5 hours at $120 an hour");
    expect(a.preview).toContain("Price: $300");
    expect(a.preview).toContain("Schedule impact: 3 days");
    expect(a.preview).toContain("Nothing starts until you sign and the invoice is paid.");
    expect(a.preview).toContain("  - Build it");
    expect(a.preview).toContain(`${BASE}/c/(the link is made when you approve)`);
    expect(a.preview).toContain("countersigned as Logan Irish");
  });

  it("refuses to put a sent order up for approval", async () => {
    const { co } = await ready();
    await env.DB.prepare(`UPDATE change_orders SET status = 'sent' WHERE id = ?`).bind(co.id).run();
    await expect(createChangeOrderSendApproval(e, (await getChangeOrder(env.DB, co.id))!)).rejects.toThrow(/sent, not a draft/);
  });

  it("a real send before the legal review is refused with the Settings message and sends nothing", async () => {
    mail = await readyToSend({ reviewed: false });
    const { co } = await ready();
    const a = await createChangeOrderSendApproval(e, co);
    const r = await approve(e, a.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toMatch(/Settings > Documents/);
    expect(mail.sent).toEqual([]);
    expect(await row(a.id)).toMatchObject({ status: "pending" });
    expect((await getChangeOrder(env.DB, co.id))).toMatchObject({ status: "draft", token: null });
  });

  it("sends a real order: seals it, mails the contact the link, logs it", async () => {
    const { co, businessId } = await ready({ deliverables: ["Build it"] });
    const a = await createChangeOrderSendApproval(e, co);
    expect(await approve(e, a.id)).toEqual({ ok: true });
    const sent = (await getChangeOrder(env.DB, co.id))!;
    expect(sent).toMatchObject({ status: "sent", approvalId: a.id, sentAt: SENT_AT, expiresAt: "2026-12-31T17:00:00.000Z" });
    expect(sent.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent.contentSha256).toBe(await sha256Hex(canonicalJson(sent.content)));
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "pat@ace.test", subject: "Change order for Ace Plumbing: Add a gallery page" });
    expect(mail.sent[0].text).toContain(`${BASE}/c/${sent.token}`);
    expect(mail.sent[0].text).toContain("2 hours at $125 an hour, $250 in total.");
    expect(await kinds(businessId, "change_order_sent")).toEqual(["SL-ABCDEF-CO1 to pat@ace.test, expires 2026-12-31"]);
    // the tasks stay locked until it is signed and paid
    expect((await listTasks(env.DB, co.projectId)).filter((t) => t.changeOrderId === co.id).map((t) => t.status)).toEqual(["locked"]);
  });

  it("a test order mails only the owner with the [Test] prefix, even with the legal review not recorded", async () => {
    mail = await readyToSend({ reviewed: false });
    const { co } = await ready({ test: true });
    expect(co.test).toBe(true);
    const a = await createChangeOrderSendApproval(e, co);
    expect(a.preview).toContain(`To: Logan Irish <${OWNER_EMAIL}> (a test: nothing goes to pat@ace.test)`);
    expect(await approve(e, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(OWNER_EMAIL);
    expect(mail.sent[0].subject).toBe("[Test] Change order for Ace Plumbing: Add a gallery page");
    expect(mail.sent.some((m) => m.to === "pat@ace.test")).toBe(false);
    const sent = (await getChangeOrder(env.DB, co.id))!;
    expect(sent).toMatchObject({ status: "sent", test: true });
    expect(mail.sent[0].text).toContain(`${BASE}/c/${sent.token}`);
  });

  it("a test order with no owner email is refused", async () => {
    const { co } = await ready({ test: true });
    await saveSettings(env.DB, { contact_email: "" });
    const a = await createChangeOrderSendApproval(e, co);
    const r = await approve(e, a.id);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/contact email in Settings/);
    expect(mail.sent).toEqual([]);
  });

  it("approving twice sends once", async () => {
    const { co } = await ready();
    const a = await createChangeOrderSendApproval(e, co);
    expect(await approve(e, a.id)).toEqual({ ok: true });
    expect(await approve(e, a.id)).toMatchObject({ ok: false, status: 409 });
    // and running the handler again for the same approval (a retry) sends nothing new and keeps the token
    const token = (await getChangeOrder(env.DB, co.id))!.token;
    const handler = getHandler("change_order.send")!;
    await handler.execute(e, { changeOrderId: co.id }, { ...a, status: "approved" });
    expect(mail.sent).toHaveLength(1);
    expect((await getChangeOrder(env.DB, co.id))!.token).toBe(token);
  });

  it("a send that fails after the order is sealed is retried without a second token or a second mail", async () => {
    const { co } = await ready();
    const a = await createChangeOrderSendApproval(e, co);
    mail.failures.push(new Error("smtp is down"));
    const r = await approve(e, a.id);
    expect(r).toMatchObject({ ok: false });
    const token = (await getChangeOrder(env.DB, co.id))!.token;
    expect(token).toBeTruthy();
    expect(await row(a.id)).toMatchObject({ status: "pending" });
    expect(await approve(e, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await getChangeOrder(env.DB, co.id))!.token).toBe(token);
  });

  it("the sealed hash changes when the content changes", async () => {
    const one = await ready();
    const two = await ready();
    await editDraft(e, two.co.id, { hours: 3 });
    for (const x of [one, two]) await approve(e, (await createChangeOrderSendApproval(e, (await getChangeOrder(env.DB, x.co.id))!)).id);
    const a = (await getChangeOrder(env.DB, one.co.id))!, b = (await getChangeOrder(env.DB, two.co.id))!;
    expect(a.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.contentSha256).not.toBe(a.contentSha256);
    // the same words under a different title hash differently too
    const three = await ready();
    await editDraft(e, three.co.id, { title: "Add a different page" });
    await approve(e, (await createChangeOrderSendApproval(e, (await getChangeOrder(env.DB, three.co.id))!)).id);
    expect((await getChangeOrder(env.DB, three.co.id))!.contentSha256).not.toBe(a.contentSha256);
  });

  it("is refused for a contact who is blocked, a project that finished, a missing contact email and an order voided in the gap", async () => {
    const blocked = await ready();
    const listed = await addDoNotContact(env.DB, { kind: "email", value: "pat@ace.test", reason: "opt_out" });
    const a = await createChangeOrderSendApproval(e, blocked.co);
    expect((await approve(e, a.id) as { error: string }).error).toMatch(/Blocked/);
    await removeDoNotContact(env.DB, listed.id);

    const done = await ready();
    const b = await createChangeOrderSendApproval(e, done.co);
    await setProjectStatus(env.DB, done.project.id, "done");
    expect((await approve(e, b.id) as { error: string }).error).toMatch(/project is done/);

    const noEmail = await ready();
    await editDraft(e, noEmail.co.id, { contactEmail: "" });
    const c = await createChangeOrderSendApproval(e, (await getChangeOrder(env.DB, noEmail.co.id))!);
    expect((await approve(e, c.id) as { error: string }).error).toMatch(/no contact email/);

    const voided = await ready();
    const d = await createChangeOrderSendApproval(e, voided.co);
    await env.DB.prepare(`UPDATE change_orders SET status = 'void' WHERE id = ?`).bind(voided.co.id).run();
    expect((await approve(e, d.id) as { error: string }).error).toMatch(/is void, not a draft/);
    expect(mail.sent).toEqual([]);
  });

  it("a /c/ link is a public page, so cold email may not carry it from another host", () => {
    expect(linkProblem({ text: "see https://clients.example.com/c/tok_123", html: "" }, "outreach", "https://go.example.com")).toMatch(/clients\.example\.com/);
    expect(linkProblem({ text: "see https://go.example.com/c/tok_123", html: "" }, "outreach", "https://go.example.com")).toBeNull();
  });
});

const draftPayload = (projectId: string, o: Record<string, unknown> = {}) => ({ projectId, title: "Add a gallery page", summary: "Twelve photos.", reason: "Pat emailed.", hours: 2, source: "email", ...o });
async function propose(payload: unknown) {
  const { createApproval } = await import("../src/worker/db/approvals");
  return createApproval(env.DB, { kind: "change_order.draft", title: "Draft a change order", preview: "x", payload, drafted_by: "mcp" });
}

describe("change_order.draft approval", () => {
  it("change_order.draft creates a draft and never sends", async () => {
    const s = await seedProject();
    const a = await propose(draftPayload(s.project.id, { sourceNote: "Pat's email on Dec 3" }));
    expect(await approve(e, a.id)).toEqual({ ok: true });
    const [co] = await listChangeOrders(env.DB, s.project.id);
    expect(co).toMatchObject({ status: "draft", sourceType: "email", originApprovalId: a.id, token: null, sentAt: null, test: false, businessId: s.businessId, dealId: s.dealId });
    expect(co.content).toMatchObject({ title: "Add a gallery page", hours: 2, scheduleImpactDays: null });
    expect(co.content.rateCents).toBeGreaterThan(0);
    expect((await listTasks(env.DB, s.project.id)).filter((t) => t.changeOrderId === co.id).map((t) => t.status)).toEqual(["locked"]);
    expect(mail.sent).toEqual([]);
    expect(await pendingFor(co.id)).toEqual([]); // not even a send approval: Logan makes that himself
    expect(await kinds(s.businessId, "note")).toContain("Change order SL-ABCDEF-CO1 drafted from an email: Pat's email on Dec 3");
  });

  it("the same draft approval run twice makes one draft", async () => {
    const s = await seedProject();
    const a = await propose(draftPayload(s.project.id, { source: "meeting" }));
    expect(await approve(e, a.id)).toEqual({ ok: true });
    await getHandler("change_order.draft")!.execute(e, draftPayload(s.project.id, { source: "meeting" }), { ...a, status: "approved" });
    const all = await listChangeOrders(env.DB, s.project.id);
    expect(all).toHaveLength(1);
    expect(all[0].sourceType).toBe("meeting");
    expect((await listTasks(env.DB, s.project.id)).filter((t) => t.changeOrderId === all[0].id)).toHaveLength(1);
  });

  it("change_order.draft with an unknown project is refused", async () => {
    const a = await propose(draftPayload("no-such-project"));
    const r = await approve(e, a.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toMatch(/project was not found/);
    expect(await row(a.id)).toMatchObject({ status: "pending" });
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_orders WHERE origin_approval_id = ?`).bind(a.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("is refused for a done project", async () => {
    const s = await seedProject();
    await setProjectStatus(env.DB, s.project.id, "done");
    const r = await approve(e, (await propose(draftPayload(s.project.id))).id);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/project is done/);
  });

  it("refuses a payload that is not exactly what the kind takes", async () => {
    const s = await seedProject();
    const parse = (p: unknown) => getHandler("change_order.draft")!.parse(p);
    expect(parse(draftPayload(s.project.id))).toMatchObject({ hours: 2, source: "email" });
    for (const bad of [
      { hours: 0.2 }, { hours: 0.3 }, { hours: 40.25 }, { hours: "2" }, { title: "" }, { title: "x".repeat(121) }, { summary: "x".repeat(1501) }, { reason: "x".repeat(601) },
      { source: "logan" }, { source: "claude" }, { sourceNote: "x".repeat(301) }, { priceCents: 100 }, { rateCents: 100 }, { test: true }, { projectId: "" },
    ]) expect(() => parse(draftPayload(s.project.id, bad)), JSON.stringify(bad)).toThrow();
    expect(parse(draftPayload(s.project.id, { hours: 40, sourceNote: "x".repeat(300) })).hours).toBe(40);
    expect(() => parse(null)).toThrow();
  });

  it("an agent cannot propose a send, and the draft kind is on the list it can", async () => {
    const { buildMcpServer } = await import("../src/worker/mcp/server");
    expect(buildMcpServer(e)).toBeTruthy();
    const { registeredKinds } = await import("../src/worker/approvals/registry");
    expect(registeredKinds()).toEqual(expect.arrayContaining(["change_order.send", "change_order.draft"]));
  });
});
