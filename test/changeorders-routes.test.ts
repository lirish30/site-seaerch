import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { getChangeOrder, signChangeOrder } from "../src/worker/db/changeOrders";
import { setProjectStatus } from "../src/worker/db/projects";
import { listTasks } from "../src/worker/db/tasks";
import { setMailDeps } from "../src/worker/mail/deps";
import { draftChangeOrder } from "../src/worker/changeorders/service";
import { clientSig, seal, seedOrder } from "./fixtures/changeorders";
import { readyToSend } from "./fixtures/documents";
import { resetProjectWork, seedProject } from "./fixtures/projects";

const BASE = "https://clients.hellositeline.test";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await resetProjectWork();
  await readyToSend();
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

const owner = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" } });
const json = async (method: string, path: string, body?: unknown) => { const r = await owner(method, path, body); return { status: r.status, body: await r.json<any>() }; };
const logs = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const pending = async (coId: string) => (await env.DB.prepare(`SELECT id FROM approvals WHERE kind = 'change_order.send' AND status = 'pending' AND json_extract(payload, '$.changeOrderId') = ?`).bind(coId).all<{ id: string }>()).results;

const NEW = { title: "Add a gallery page", summary: "Twelve job photos.", reason: "The client asked.", hours: 2 };

const base = { title: "Add a gallery page", summary: "Twelve job photos.", reason: "The client asked.", sourceType: "logan" as const };
/** A drafted order with one deliverable (so one locked task), made by the service. */
async function drafted() {
  const s = await seedProject();
  return { ...s, co: await draftChangeOrder(env as never, { ...base, projectId: s.project.id, hours: 2, deliverables: ["Build the page"] }) };
}
/** A drafted order, sealed (sent) with a token. */
async function sentOrder() {
  const s = await drafted();
  return { ...s, co: await seal(s.co) };
}
/** A drafted order that the client has signed (not yet paid). */
async function signedOrder() {
  const s = await sentOrder();
  expect(await signChangeOrder(env.DB, s.co.id, clientSig(s.co.contentSha256!), "2026-12-06T09:00:00.000Z")).toBe("signed");
  return s;
}

describe("change order routes", () => {
  it("every route is 401 without a session", async () => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/projects/x/change-orders"], ["POST", "/projects/x/change-orders", NEW], ["PATCH", "/change-orders/x", { title: "t" }], ["POST", "/change-orders/x/send"],
      ["POST", "/change-orders/x/void", { reason: "no longer needed" }], ["POST", "/change-orders/x/mark-paid", { confirm: true }],
    ];
    for (const [m, p, b] of calls) expect((await owner(m, p, b, false)).status, `${m} ${p}`).toBe(401);
  });

  it("an unknown project or change order is 404", async () => {
    for (const [m, p, b] of [
      ["GET", "/projects/nope/change-orders"], ["POST", "/projects/nope/change-orders", NEW], ["PATCH", "/change-orders/nope", { title: "t" }], ["POST", "/change-orders/nope/send"],
      ["POST", "/change-orders/nope/void", { reason: "no longer needed" }], ["POST", "/change-orders/nope/mark-paid", { confirm: true }],
    ] as [string, string, unknown?][]) expect((await owner(m, p, b)).status, `${m} ${p}`).toBe(404);
  });

  it("drafts a change order on a project: priced at the hourly rate, locked billable tasks, nothing sent", async () => {
    const s = await seedProject();
    const r = await json("POST", `/projects/${s.project.id}/change-orders`, { ...NEW, deliverables: ["Build the page", "Add the photos"], scheduleImpactDays: 2 });
    expect(r.status).toBe(201);
    expect(r.body.changeOrder).toMatchObject({ status: "draft", projectId: s.project.id, sourceType: "logan", link: null, content: { title: "Add a gallery page", hours: 2, scheduleImpactDays: 2, reference: "SL-ABCDEF-BUILD-CO1" } });
    expect(r.body.changeOrder.content.priceCents).toBe(Math.round(2 * r.body.changeOrder.content.rateCents));
    const tasks = (await listTasks(env.DB, s.project.id)).filter((t) => t.changeOrderId === r.body.changeOrder.id);
    expect(tasks.map((t) => [t.status, t.billable])).toEqual([["locked", true], ["locked", true]]);
    const list = await json("GET", `/projects/${s.project.id}/change-orders`);
    expect(list.body.changeOrders.map((c: any) => c.id)).toEqual([r.body.changeOrder.id]);
    // a price and a rate of the owner's choosing win
    const custom = await json("POST", `/projects/${s.project.id}/change-orders`, { ...NEW, priceCents: 20000, rateCents: 9500 });
    expect(custom.body.changeOrder.content).toMatchObject({ priceCents: 20000, rateCents: 9500 });
  });

  it("refuses a bad draft with a sentence, never a 500", async () => {
    const s = await seedProject();
    for (const bad of [{ hours: 0.1 }, { hours: 201 }, { hours: 1.1 }, { title: "" }, { title: "x".repeat(121) }, { priceCents: 0 }, { deliverables: Array(11).fill("x") }, { hours: "2" }]) {
      const r = await json("POST", `/projects/${s.project.id}/change-orders`, { ...NEW, ...bad });
      expect(r.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    const cred = await json("POST", `/projects/${s.project.id}/change-orders`, { ...NEW, summary: "password: hunter2hunter2" });
    expect(cred.status).toBe(400);
    expect(JSON.stringify(cred.body)).not.toContain("hunter2");
    expect((await json("POST", `/projects/${s.project.id}/change-orders`, { ...NEW, extra: true })).status).toBe(400);
    await setProjectStatus(env.DB, s.project.id, "cancelled");
    const closed = await json("POST", `/projects/${s.project.id}/change-orders`, NEW);
    expect(closed.status).toBe(409);
    expect(closed.body.error).toMatch(/cancelled/);
  });

  it("PATCH edits a draft and re-prices it, and refuses a sent one", async () => {
    const s = await seedOrder();
    const r = await json("PATCH", `/change-orders/${s.co.id}`, { hours: 3, rateCents: 10000, title: "Gallery and map page" });
    expect(r.status).toBe(200);
    expect(r.body.changeOrder.content).toMatchObject({ hours: 3, rateCents: 10000, priceCents: 30000, title: "Gallery and map page" });
    expect((await json("PATCH", `/change-orders/${s.co.id}`, { hours: 0 })).status).toBe(400);
    expect((await json("PATCH", `/change-orders/${s.co.id}`, { reference: "X" })).status).toBe(400);
    expect((await json("PATCH", `/change-orders/${s.co.id}`, {})).status).toBe(400);
    expect((await json("PATCH", `/change-orders/${s.co.id}`, { summary: "password: hunter2hunter2" })).status).toBe(400);
    const sent = await sentOrder();
    const frozen = await json("PATCH", `/change-orders/${sent.co.id}`, { title: "Changed after sending" });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error).toMatch(/draft/);
  });

  it("change order send creates one approval and a second call returns it", async () => {
    const s = await seedOrder();
    const a = await json("POST", `/change-orders/${s.co.id}/send`);
    expect(a.status).toBe(200);
    expect(a.body.approval).toMatchObject({ id: expect.any(String), status: "pending", kind: "change_order.send" });
    const b = await json("POST", `/change-orders/${s.co.id}/send`);
    expect(b.body.approval.id).toBe(a.body.approval.id);
    expect(await pending(s.co.id)).toHaveLength(1);
    // nothing was sent: the order is still a draft with no token
    expect(await getChangeOrder(env.DB, s.co.id)).toMatchObject({ status: "draft", token: null });
    // an edit withdraws the waiting approval; the next send makes a new one
    await json("PATCH", `/change-orders/${s.co.id}`, { hours: 3 });
    expect(await pending(s.co.id)).toHaveLength(0);
    const c = await json("POST", `/change-orders/${s.co.id}/send`);
    expect(c.body.approval.id).not.toBe(a.body.approval.id);
  });

  it("send is 409 for an order that is not a draft", async () => {
    const sent = await sentOrder();
    const r = await json("POST", `/change-orders/${sent.co.id}/send`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/not a draft/);
    expect(await pending(sent.co.id)).toHaveLength(0);
  });

  it("void needs a reason, voids a draft or sent order and skips its tasks, and a signed order is 409", async () => {
    const s = await seedOrder();
    expect((await json("POST", `/change-orders/${s.co.id}/void`, {})).status).toBe(400);
    expect((await json("POST", `/change-orders/${s.co.id}/void`, { reason: "no" })).status).toBe(400);
    const ok = await json("POST", `/change-orders/${s.co.id}/void`, { reason: "The client changed their mind" });
    expect(ok.status).toBe(200);
    expect(ok.body.changeOrder).toMatchObject({ status: "void", voidReason: "The client changed their mind" });
    expect(await logs(s.businessId, "change_order_void")).toHaveLength(1);

    const signed = await signedOrder();
    const refused = await json("POST", `/change-orders/${signed.co.id}/void`, { reason: "Oops, wrong one" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/signed/);
    expect((await getChangeOrder(env.DB, signed.co.id))!.status).toBe("signed");
  });

  it("mark-paid needs confirm and a signed order", async () => {
    const draft = await seedOrder();
    // no confirm: 400, whatever the state
    expect((await json("POST", `/change-orders/${draft.co.id}/mark-paid`, {})).status).toBe(400);
    expect((await json("POST", `/change-orders/${draft.co.id}/mark-paid`, { confirm: false })).status).toBe(400);
    expect((await json("POST", `/change-orders/${draft.co.id}/mark-paid`, { confirm: "yes" })).status).toBe(400);
    // not signed: 409
    const early = await json("POST", `/change-orders/${draft.co.id}/mark-paid`, { confirm: true });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/not been signed/);
    const sent = await sentOrder();
    expect((await json("POST", `/change-orders/${sent.co.id}/mark-paid`, { confirm: true })).status).toBe(409);

    const s = await signedOrder();
    expect((await json("POST", `/change-orders/${s.co.id}/mark-paid`, { confirm: false })).status).toBe(400);
    expect((await getChangeOrder(env.DB, s.co.id))!.paidAt).toBeNull();
    const paid = await json("POST", `/change-orders/${s.co.id}/mark-paid`, { confirm: true });
    expect(paid.status).toBe(200);
    expect(paid.body.changeOrder).toMatchObject({ status: "signed", paidVia: "manual", paidAt: expect.any(String) });
    // the service logs it ("paid (outside Stripe)"), once, and unlocks the order's tasks once
    const lines = await logs(s.businessId, "change_order_paid");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/outside Stripe/);
    expect((await listTasks(env.DB, s.project.id)).filter((t) => t.changeOrderId === s.co.id).map((t) => t.status)).toEqual(["todo"]);
    // a second press changes nothing
    expect((await json("POST", `/change-orders/${s.co.id}/mark-paid`, { confirm: true })).status).toBe(200);
    expect(await logs(s.businessId, "change_order_paid")).toHaveLength(1);
  });

  it("the owner's change orders carry a link for a sent order and never the token, address, browser or consent text", async () => {
    const s = await signedOrder();
    const sent = await sentOrder();
    const list = await json("GET", `/projects/${s.project.id}/change-orders`);
    const one = list.body.changeOrders[0];
    expect(one).toMatchObject({ id: s.co.id, status: "signed", link: null, signerName: "Pat Jones", signerEmail: "pat@ace.test" });
    for (const k of ["token", "signerIp", "signerUserAgent", "consentText"]) expect(one, k).not.toHaveProperty(k);
    const text = JSON.stringify(list.body);
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain("TestBrowser");
    expect(text).not.toContain("I agree to sign electronically");
    expect(text).not.toContain(s.co.token!);
    // a sent (or viewed) order has its client link
    const other = await json("GET", `/projects/${sent.project.id}/change-orders`);
    expect(other.body.changeOrders[0].link).toBe(`${BASE}/c/${sent.co.token}`);
    expect(JSON.stringify(other.body)).not.toContain(`"token"`);
  });
});
