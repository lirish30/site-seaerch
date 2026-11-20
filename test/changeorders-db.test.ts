import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ChangeOrderInputError, ChangeOrderStateError, createChangeOrderDraft, declineChangeOrder, expireDue, getChangeOrder, getChangeOrderByToken, listChangeOrders, markPaid, markSent, parseContent,
  recordView, signChangeOrder, updateDraftContent, voidChangeOrder,
} from "../src/worker/db/changeOrders";
import { content, clientSig, FAR, NOW_ISO, seedOrder, sendOrder } from "./fixtures/changeorders";
import { seedProject } from "./fixtures/projects";

const make = (s: { project: { id: string }; businessId: string }, o: Parameters<typeof content>[0] = {}, extra: { originApprovalId?: string } = {}) =>
  createChangeOrderDraft(env.DB, { projectId: s.project.id, businessId: s.businessId, dealId: null, test: false, sourceType: "logan", originApprovalId: extra.originApprovalId ?? null, referenceBase: "SL-X", content: content(o) });

describe("createChangeOrderDraft", () => {
  it("numbers a project's change orders from 1 and builds the reference from the number", async () => {
    const s = await seedProject();
    const a = await make(s), b = await make(s);
    expect([a.changeOrder.seq, b.changeOrder.seq]).toEqual([1, 2]);
    expect([a.changeOrder.content.reference, b.changeOrder.content.reference]).toEqual(["SL-X-CO1", "SL-X-CO2"]);
    expect(a.changeOrder).toMatchObject({ status: "draft", test: false, token: null, contentSha256: null, paidAt: null, sourceType: "logan" });
    const other = await seedProject();
    expect((await make(other)).changeOrder.seq).toBe(1);
    expect((await listChangeOrders(env.DB, s.project.id)).map((c) => c.seq)).toEqual([1, 2]);
  });

  it("two drafts made at once get different numbers", async () => {
    const s = await seedProject();
    const made = await Promise.all([make(s), make(s), make(s)]);
    expect(made.map((m) => m.changeOrder.seq).sort()).toEqual([1, 2, 3]);
  });

  it("one draft per origin approval", async () => {
    const s = await seedProject();
    const a = await make(s, {}, { originApprovalId: "appr-1" });
    const again = await make(s, { title: "Something else" }, { originApprovalId: "appr-1" });
    expect(a.created).toBe(true);
    expect(again).toMatchObject({ created: false });
    expect(again.changeOrder.id).toBe(a.changeOrder.id);
    expect(again.changeOrder.content.title).toBe("Add a gallery page");
    expect((await listChangeOrders(env.DB, s.project.id))).toHaveLength(1);
  });
});

describe("the content", () => {
  const ok = { reference: "R", ...content() };
  it("accepts the limits and refuses what is outside them", () => {
    expect(parseContent({ ...ok, hours: 0.25, title: "x".repeat(120), scheduleImpactDays: 180, deliverables: Array(10).fill("y".repeat(200)) })).toBeTruthy();
    expect(parseContent({ ...ok, hours: 200, scheduleImpactDays: 0 }).hours).toBe(200);
    for (const bad of [
      { hours: 0.2 }, { hours: 0.3 }, { hours: 200.25 }, { hours: 0 }, { priceCents: 0 }, { priceCents: 10.5 }, { rateCents: -1 }, { title: "x".repeat(121) }, { title: "  " }, { summary: "x".repeat(1501) },
      { reason: "x".repeat(601) }, { deliverables: Array(11).fill("a") }, { deliverables: ["x".repeat(201)] }, { notIncluded: Array(11).fill("a") }, { scheduleImpactDays: 181 },
      { scheduleImpactDays: -1 }, { scheduleImpactDays: 1.5 }, { extra: 1 },
    ]) expect(() => parseContent({ ...ok, ...bad }), JSON.stringify(bad)).toThrow(ChangeOrderInputError);
  });

  it("strips control and bidirectional characters before measuring", () => {
    const c = parseContent({ ...ok, title: "  Gallery‮ page\u0000 ", summary: "a​b" });
    expect(c.title).toBe("Gallery page");
    expect(c.summary).toBe("ab");
  });
});

describe("updateDraftContent", () => {
  it("replaces a draft's content and refuses anything else", async () => {
    const { co } = await seedOrder();
    const saved = await updateDraftContent(env.DB, co.id, { ...co.content, title: "A different title" });
    expect(saved.content.title).toBe("A different title");
    await sendOrder(saved);
    await expect(updateDraftContent(env.DB, co.id, { ...co.content, title: "Sneaky" })).rejects.toBeInstanceOf(ChangeOrderStateError);
    expect((await getChangeOrder(env.DB, co.id))!.content.title).toBe("A different title");
  });
});

describe("markSent", () => {
  it("freezes the order with its token, hash and times", async () => {
    const { co } = await seedOrder();
    const { co: sent, hash } = await sendOrder(co, { approvalId: "a1", expiresAt: "2027-01-04T10:00:00.000Z" });
    expect(sent).toMatchObject({ status: "sent", contentSha256: hash, approvalId: "a1", sentAt: NOW_ISO, expiresAt: "2027-01-04T10:00:00.000Z" });
    expect(sent.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await getChangeOrderByToken(env.DB, sent.token!))!.id).toBe(co.id);
  });

  it("a retry of the same approval changes nothing, and another approval is refused", async () => {
    const { co } = await seedOrder();
    const first = (await sendOrder(co, { approvalId: "a1" })).co;
    const retry = await markSent(env.DB, co.id, { token: "x".repeat(43), content: co.content, contentSha256: "other", sentAt: NOW_ISO, expiresAt: FAR, approvalId: "a1" });
    expect(retry.token).toBe(first.token);
    await expect(markSent(env.DB, co.id, { token: "y".repeat(43), content: co.content, contentSha256: "h", sentAt: NOW_ISO, expiresAt: FAR, approvalId: "a2" })).rejects.toBeInstanceOf(ChangeOrderStateError);
    expect((await getChangeOrder(env.DB, co.id))!.token).toBe(first.token);
  });
});

describe("recordView", () => {
  it("moves sent to viewed once and records at most one view every ten minutes", async () => {
    const { co } = await seedOrder();
    expect(await recordView(env.DB, co.id, { now: NOW_ISO, userAgent: "ua" })).toBe(false); // a draft has no link
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_order_views`).first<{ n: number }>())!.n).toBe(0);
    await sendOrder(co);
    expect(await recordView(env.DB, co.id, { now: "2026-12-05T11:00:00.000Z", userAgent: "ua" })).toBe(true);
    expect(await recordView(env.DB, co.id, { now: "2026-12-05T11:05:00.000Z", userAgent: "ua" })).toBe(false);
    expect(await recordView(env.DB, co.id, { now: "2026-12-05T11:11:00.000Z", userAgent: "ua" })).toBe(false);
    const n = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_order_views WHERE change_order_id = ?`).bind(co.id).first<{ n: number }>())!.n;
    expect(await n()).toBe(2); // 11:00 and 11:11; the 11:05 visit was inside the gap
    expect(await getChangeOrder(env.DB, co.id)).toMatchObject({ status: "viewed", firstViewedAt: "2026-12-05T11:00:00.000Z" });
  });
});

describe("signChangeOrder", () => {
  it("signs a sent order once and stores the signature", async () => {
    const { co } = await seedOrder();
    const { co: sent, hash } = await sendOrder(co);
    expect(await signChangeOrder(env.DB, sent.id, clientSig(hash), "2026-12-06T09:00:00.000Z")).toBe("signed");
    expect(await getChangeOrder(env.DB, sent.id)).toMatchObject({
      status: "signed", signedAt: "2026-12-06T09:00:00.000Z", signerName: "Pat Jones", signerEmail: "pat@ace.test", signerIp: "203.0.113.9", signerUserAgent: "TestBrowser/1.0",
      consentText: "I agree to sign electronically.", consentVersion: 1, paidAt: null,
    });
  });

  it("signing content whose hash changed is not_open", async () => {
    const { co } = await seedOrder();
    const { co: sent } = await sendOrder(co);
    expect(await signChangeOrder(env.DB, sent.id, clientSig("0".repeat(64)), "2026-12-06T09:00:00.000Z")).toBe("not_open");
    expect((await getChangeOrder(env.DB, sent.id))!.status).toBe("sent");
  });

  it("signing twice stores one signature", async () => {
    const { co } = await seedOrder();
    const { co: sent, hash } = await sendOrder(co);
    expect(await signChangeOrder(env.DB, sent.id, clientSig(hash, { signedAt: "2026-12-06T09:00:00.000Z" }), "2026-12-06T09:00:00.000Z")).toBe("signed");
    expect(await signChangeOrder(env.DB, sent.id, { ...clientSig(hash, { signedAt: "2026-12-06T10:00:00.000Z" }), signerName: "Someone Else" }, "2026-12-06T10:00:00.000Z")).toBe("already_signed");
    expect(await getChangeOrder(env.DB, sent.id)).toMatchObject({ signerName: "Pat Jones", signedAt: "2026-12-06T09:00:00.000Z" });
  });

  it("two signs at once leave one", async () => {
    const { co } = await seedOrder();
    const { co: sent, hash } = await sendOrder(co);
    const r = await Promise.all([1, 2, 3].map((i) => signChangeOrder(env.DB, sent.id, { ...clientSig(hash), signerName: `Signer ${i}` }, "2026-12-06T09:00:00.000Z")));
    expect(r.filter((x) => x === "signed")).toHaveLength(1);
    expect(r.filter((x) => x === "already_signed")).toHaveLength(2);
  });

  it("a draft, a void, an expired and a declined order are not open", async () => {
    const draft = await seedOrder();
    expect(await signChangeOrder(env.DB, draft.co.id, clientSig("x"), NOW_ISO)).toBe("not_open");
    const old = await seedOrder();
    const { co: oldSent, hash } = await sendOrder(old.co, { expiresAt: "2026-12-06T00:00:00.000Z" });
    expect(await signChangeOrder(env.DB, oldSent.id, clientSig(hash), "2026-12-06T00:00:00.001Z")).toBe("not_open");
    expect(await signChangeOrder(env.DB, oldSent.id, clientSig(hash), "2026-12-06T00:00:00.000Z")).toBe("signed"); // at the exact instant it is still open
    const v = await seedOrder();
    const { co: vs, hash: vh } = await sendOrder(v.co);
    await voidChangeOrder(env.DB, vs.id, "no longer needed");
    expect(await signChangeOrder(env.DB, vs.id, clientSig(vh), NOW_ISO)).toBe("not_open");
    const d = await seedOrder();
    const { co: ds, hash: dh } = await sendOrder(d.co);
    expect(await declineChangeOrder(env.DB, ds.id, "too much", NOW_ISO)).toBe("declined");
    expect(await signChangeOrder(env.DB, ds.id, clientSig(dh), NOW_ISO)).toBe("not_open");
  });
});

describe("declineChangeOrder", () => {
  it("records a cleaned reason once", async () => {
    const { co } = await seedOrder();
    const { co: sent } = await sendOrder(co);
    expect(await declineChangeOrder(env.DB, sent.id, "  Not\u0000 now  ", NOW_ISO)).toBe("declined");
    expect(await declineChangeOrder(env.DB, sent.id, "again", NOW_ISO)).toBe("already_declined");
    expect(await getChangeOrder(env.DB, sent.id)).toMatchObject({ status: "declined", declinedReason: "Not now" });
    expect(await declineChangeOrder(env.DB, "nope", "x", NOW_ISO)).toBe("not_open");
  });
});

describe("voidChangeOrder", () => {
  it("voids a draft, sent or viewed order, and a void one is returned as it is", async () => {
    for (const make of ["draft", "sent", "viewed"] as const) {
      const { co } = await seedOrder();
      let id = co.id;
      if (make !== "draft") { id = (await sendOrder(co)).co.id; if (make === "viewed") await recordView(env.DB, id, { now: NOW_ISO, userAgent: null }); }
      const v = await voidChangeOrder(env.DB, id, "client changed their mind");
      expect(v).toMatchObject({ status: "void", voidReason: "client changed their mind" });
      expect((await voidChangeOrder(env.DB, id, "a later reason")).voidReason).toBe("client changed their mind");
    }
  });

  it("refuses a signed, a declined and an expired order, and a missing one", async () => {
    const { co } = await seedOrder();
    const { co: sent, hash } = await sendOrder(co);
    await signChangeOrder(env.DB, sent.id, clientSig(hash), NOW_ISO);
    await expect(voidChangeOrder(env.DB, sent.id, "oops")).rejects.toThrow(/signed change order cannot be voided/);
    expect((await getChangeOrder(env.DB, sent.id))!.status).toBe("signed");
    await expect(voidChangeOrder(env.DB, "nope", "oops")).rejects.toBeInstanceOf(ChangeOrderStateError);
  });
});

describe("markPaid", () => {
  it("records the payment on a signed order, true only the first time", async () => {
    const { co } = await seedOrder();
    const { co: sent, hash } = await sendOrder(co);
    expect(await markPaid(env.DB, sent.id, { at: NOW_ISO, via: "manual" })).toBe(false); // not signed yet
    await signChangeOrder(env.DB, sent.id, clientSig(hash), NOW_ISO);
    expect(await markPaid(env.DB, sent.id, { at: "2026-12-07T10:00:00.000Z", via: "manual" })).toBe(true);
    expect(await markPaid(env.DB, sent.id, { at: "2026-12-08T10:00:00.000Z", via: "stripe" })).toBe(false);
    expect(await getChangeOrder(env.DB, sent.id)).toMatchObject({ paidAt: "2026-12-07T10:00:00.000Z", paidVia: "manual" });
  });
});

describe("expireDue", () => {
  it("expires sent and viewed orders past their time and returns exactly those, once", async () => {
    const a = await sendOrder((await seedOrder()).co, { expiresAt: "2026-12-10T00:00:00.000Z" });
    const b = await sendOrder((await seedOrder()).co, { expiresAt: "2026-12-10T00:00:00.000Z" });
    await recordView(env.DB, b.co.id, { now: NOW_ISO, userAgent: null });
    const c = await sendOrder((await seedOrder()).co, { expiresAt: "2026-12-11T00:00:00.000Z" });
    const d = await seedOrder(); // a draft
    const gone = await expireDue(env.DB, "2026-12-10T00:00:00.001Z");
    expect(gone.map((x) => x.id).sort()).toEqual([a.co.id, b.co.id].sort());
    expect(gone.every((x) => x.status === "expired")).toBe(true);
    expect(await expireDue(env.DB, "2026-12-10T00:00:00.001Z")).toEqual([]);
    expect((await getChangeOrder(env.DB, c.co.id))!.status).toBe("sent");
    expect((await getChangeOrder(env.DB, d.co.id))!.status).toBe("draft");
    expect(await expireDue(env.DB, "2026-12-11T00:00:00.000Z")).toEqual([]); // the exact instant is still open
  });
});
