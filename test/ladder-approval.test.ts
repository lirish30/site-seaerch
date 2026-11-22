import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { getHandler } from "../src/worker/approvals/registry";
import { listActivity } from "../src/worker/db/activity";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { placeHold } from "../src/worker/db/holds";
import { insertLadderRows, listLadder, setLadderStatus, type LadderStep } from "../src/worker/db/ladder";
import { getByApproval } from "../src/worker/db/messages";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { sweepLadder } from "../src/worker/ladder/sweep";
import { readyToSend } from "./fixtures/documents";
import { seedClient, type SubSpec } from "./fixtures/clients";
import { resetProjectWork } from "./fixtures/projects";

const e = env as Env;
const NOW = new Date("2026-11-22T18:00:00.000Z");
const LINK = "https://g.page/r/abc/review";
const ACTIVE: SubSpec = { monthlyCents: 12900, status: "active" };

let mail: Awaited<ReturnType<typeof readyToSend>>;
beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.batch(["ladder_steps", "billing_holds", "invoice_nudges", "invoices", "subscriptions", "do_not_contact"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`DELETE FROM approvals WHERE kind = 'ladder.mail'`).run();
  await env.DB.prepare(`DELETE FROM activity`).run();
  await resetProjectWork();
  mail = await readyToSend();
});
afterEach(() => { vi.restoreAllMocks(); setMailDeps(null); });

/** A client with one step of the ladder, drafted by the sweep into its approval. */
async function drafted(step: LadderStep = "check_in", o: { subs?: SubSpec[]; dueOn?: string; sweepAt?: Date; invoice?: { cents: number } } = {}) {
  const s = await seedClient({ subs: o.subs, invoice: o.invoice });
  const dueOn = o.dueOn ?? "2026-11-22";
  await insertLadderRows(env.DB, [{ businessId: s.businessId, projectId: s.project!.id, step, dueOn }], "2026-11-01T00:00:00.000Z");
  const id = (await listLadder(env.DB, s.businessId))[0].id;
  if (step === "review_request") await env.DB.prepare(`UPDATE ladder_steps SET link = ? WHERE id = ?`).bind(LINK, id).run();
  expect((await sweepLadder(e, o.sweepAt ?? NOW)).drafted).toBe(1);
  const ladder = (await listLadder(env.DB, s.businessId))[0];
  expect(ladder.status).toBe("drafted");
  return { ...s, ladderId: id, approvalId: ladder.approvalId! };
}
const stateOf = async (businessId: string) => (await listLadder(env.DB, businessId))[0];
const notes = async (businessId: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === "note" || a.kind === "ladder_sent");
const approvalStatus = async (id: string) => (await env.DB.prepare(`SELECT status, error FROM approvals WHERE id = ?`).bind(id).first<{ status: string; error: string | null }>())!;

describe("ladder.mail approval", () => {
  it("is registered as Send and takes a ladder id and an optional personal line", () => {
    const h = getHandler("ladder.mail")!;
    expect(h.label).toBe("Send");
    expect(h.parse({ ladderId: "x" })).toEqual({ ladderId: "x" });
    expect(h.parse({ ladderId: "x", personalLine: "hi" })).toEqual({ ladderId: "x", personalLine: "hi" });
    expect(() => h.parse({})).toThrow();
    expect(() => h.parse({ ladderId: "x", personalLine: "x".repeat(601) })).toThrow();
  });

  it("approve sends once with the approval id as the key and marks the row done", async () => {
    const s = await drafted("review_request");
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("pat@ace.test");
    expect(mail.sent[0].text).toContain("Hi Pat,");
    expect(mail.sent[0].text).toContain(LINK);
    const m = await getByApproval(env.DB, s.approvalId);
    expect(m).toMatchObject({ status: "sent", counterpart: "pat@ace.test" });
    const r = await stateOf(s.businessId);
    expect(r.status).toBe("done");
    expect(r.doneAt).not.toBeNull();
    expect((await notes(s.businessId)).filter((a) => a.kind === "ladder_sent").map((a) => a.detail)).toEqual(["Review request sent to pat@ace.test"]);

    // A second approve is refused, and a retry of the same approval (put back to pending after a failure that came after the mail) mails nothing more.
    expect(await approve(e, s.approvalId)).toMatchObject({ ok: false, status: 409 });
    await env.DB.prepare(`UPDATE approvals SET status = 'pending' WHERE id = ?`).bind(s.approvalId).run();
    await env.DB.prepare(`UPDATE ladder_steps SET status = 'drafted', done_at = NULL WHERE id = ?`).bind(s.ladderId).run();
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await stateOf(s.businessId)).status).toBe("done");
    expect((await notes(s.businessId)).filter((a) => a.kind === "ladder_sent")).toHaveLength(1);
  });

  it("approving a row that was skipped meanwhile sends nothing", async () => {
    const s = await drafted();
    expect(await setLadderStatus(env.DB, s.ladderId, "skipped", { now: NOW.toISOString() })).toBe(true);
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
    expect((await stateOf(s.businessId)).status).toBe("skipped");
    expect((await notes(s.businessId)).map((a) => a.detail)).toEqual([expect.stringMatching(/^Check-in \(due 2026-11-22\) not sent: the step is skipped/)]);
  });

  it("approving after the client was put on hold sends nothing and says why; the step goes to due for Today", async () => {
    const s = await drafted("check_in", { invoice: { cents: 5000 } });
    expect(await placeHold(env.DB, { businessId: s.businessId, invoiceId: s.invoice!.id, now: NOW.toISOString() })).toBe(true);
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
    expect(await stateOf(s.businessId)).toMatchObject({ status: "due", note: "not sent: the client is on a billing hold" });
    expect((await notes(s.businessId)).map((a) => a.detail)).toEqual(["Check-in (due 2026-11-22) not sent: the client is on a billing hold, so nothing was mailed"]);
  });

  it("a do-not-contact client is not mailed either, and an existing-client (won) mark does not block the ladder", async () => {
    const won = await drafted(); // seedClient marks the lead won: the conflict gate's "client" source is the point of the ladder
    expect(await approve(e, won.approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    const blocked = await drafted();
    await addDoNotContact(env.DB, { kind: "email", value: "pat@ace.test", reason: "opt_out" });
    expect(await approve(e, blocked.approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await stateOf(blocked.businessId)).status).toBe("due");
    expect((await notes(blocked.businessId))[0].detail).toMatch(/not sent: blocked: .*do-not-contact/);
  });

  it("edited payload personalLine is used", async () => {
    const s = await drafted("december_letter", { subs: [ACTIVE], dueOn: "2026-12-01", sweepAt: new Date("2026-12-02T20:00:00.000Z") });
    const line = "Your fence photos from June are still my favourite.";
    expect(await approve(e, s.approvalId, { ladderId: s.ladderId, personalLine: line })).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].text.split("\n\n")).toContain(line);
    expect(mail.sent[0].subject).toContain("2026");
    expect((await stateOf(s.businessId)).status).toBe("done");
    expect(JSON.parse((await env.DB.prepare(`SELECT payload FROM approvals WHERE id = ?`).bind(s.approvalId).first<{ payload: string }>())!.payload)).toEqual({ ladderId: s.ladderId, personalLine: line });
  });

  it("without an edit, the December letter has no personal paragraph", async () => {
    const s = await drafted("december_letter", { subs: [ACTIVE], dueOn: "2026-12-01", sweepAt: new Date("2026-12-02T20:00:00.000Z") });
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent[0].text).toContain("As 2026 comes to a close");
    expect(mail.sent[0].text.split("\n\n")).toHaveLength(6); // hello, thanks, the offer, good wishes, close, and the sender's saved signature; no personal paragraph
  });

  it("a send failure leaves the approval pending with the error and the row drafted", async () => {
    const s = await drafted();
    mail.failures.push(new Error("smtp down"));
    const r = await approve(e, s.approvalId);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(await approvalStatus(s.approvalId)).toMatchObject({ status: "pending", error: expect.stringContaining("smtp down") });
    expect((await stateOf(s.businessId)).status).toBe("drafted");
    expect((await notes(s.businessId)).filter((a) => a.kind === "ladder_sent")).toHaveLength(0);
    // Approved again, it goes.
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await stateOf(s.businessId)).status).toBe("done");
  });

  it("a mailbox that cannot send, a contact email taken away, or a review link taken away puts the approval back to pending with the reason", async () => {
    const a = await drafted();
    await readyToSend({ mailbox: false });
    expect(await approve(e, a.approvalId)).toMatchObject({ ok: false, error: expect.stringContaining("main mailbox") });
    expect((await approvalStatus(a.approvalId)).status).toBe("pending");
    mail = await readyToSend();
    await env.DB.prepare(`UPDATE people SET email = NULL WHERE business_id = ?`).bind(a.businessId).run();
    expect(await approve(e, a.approvalId)).toMatchObject({ ok: false, error: expect.stringContaining("no contact email") });

    const b = await drafted("review_request");
    await env.DB.prepare(`UPDATE ladder_steps SET link = NULL WHERE id = ?`).bind(b.ladderId).run();
    expect(await approve(e, b.approvalId)).toMatchObject({ ok: false, error: expect.stringContaining("review link") });
    expect(mail.sent).toHaveLength(0);
  });
});
