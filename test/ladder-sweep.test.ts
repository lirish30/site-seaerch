import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { placeHold } from "../src/worker/db/holds";
import { insertLadderRows, listLadder, type LadderStep } from "../src/worker/db/ladder";
import { upsertProfile } from "../src/worker/db/seo";
import type { Env } from "../src/worker/env";
import { MAX_DRAFTS_PER_RUN, sweepLadder, tooLate } from "../src/worker/ladder/sweep";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { readyToSend } from "./fixtures/documents";
import { seedClient, type SubSpec } from "./fixtures/clients";
import { resetProjectWork } from "./fixtures/projects";

const e = env as Env;
// 10:00 on Sunday 22 November 2026 in Los Angeles.
const NOW = new Date("2026-11-22T18:00:00.000Z");
const at = (day: string) => new Date(`${day}T20:00:00.000Z`); // noon in Los Angeles
const LINK = "https://g.page/r/abc/review";
const ACTIVE: SubSpec = { monthlyCents: 12900, status: "active" };

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.batch(["ladder_steps", "billing_holds", "invoice_nudges", "invoices", "subscriptions", "seo_profiles", "do_not_contact"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`DELETE FROM approvals WHERE kind = 'ladder.mail'`).run();
  await env.DB.prepare(`DELETE FROM activity`).run();
  await resetProjectWork();
  await readyToSend();
});
afterEach(() => { vi.restoreAllMocks(); });

type Client = Awaited<ReturnType<typeof seedClient>>;
async function row(s: Client, step: LadderStep, dueOn: string, link?: string) {
  await insertLadderRows(env.DB, [{ businessId: s.businessId, projectId: s.project?.id ?? null, step, dueOn }], "2026-11-01T00:00:00.000Z");
  const r = (await listLadder(env.DB, s.businessId)).find((x) => x.step === step && x.dueOn === dueOn)!;
  if (link) await env.DB.prepare(`UPDATE ladder_steps SET link = ? WHERE id = ?`).bind(link, r.id).run();
  return r.id;
}
const rowOf = async (s: Client, id: string) => (await listLadder(env.DB, s.businessId)).find((r) => r.id === id)!;
const approvals = async () => (await env.DB.prepare(`SELECT id, title, preview, payload, status, record_type, record_id, drafted_by FROM approvals WHERE kind = 'ladder.mail' ORDER BY created_at, rowid`).all<any>()).results;

describe("sweepLadder", () => {
  it("a launch-day row drafts one ladder.mail approval and becomes drafted; running the sweep again makes none", async () => {
    const s = await seedClient();
    const id = await row(s, "review_request", "2026-11-22", LINK);
    expect(await sweepLadder(e, NOW)).toEqual({ filled: 0, drafted: 1, due: 0, skipped: 0, held: 0 });
    const r = await rowOf(s, id);
    expect(r.status).toBe("drafted");
    const [a, ...rest] = await approvals();
    expect(rest).toHaveLength(0);
    expect(r.approvalId).toBe(a.id);
    expect(a).toMatchObject({ title: "Review request for Ace Plumbing", status: "pending", record_type: "business", record_id: s.businessId });
    expect(JSON.parse(a.payload)).toEqual({ ladderId: id });
    expect(a.preview).toContain("To: Pat Jones <pat@ace.test>");
    expect(a.preview).toContain(`Subject: `);
    expect(a.preview).toContain("Hi Pat,");
    expect(a.preview).toContain(LINK);
    expect(a.preview).toContain("Thanks,"); // a saved signature follows, so the mail adds no name
    expect(await sweepLadder(e, NOW)).toEqual({ filled: 0, drafted: 0, due: 0, skipped: 0, held: 0 });
    expect(await approvals()).toHaveLength(1);
  });

  it("a build-only client (no subscription at all) is not ended: the dated steps are drafted for it", async () => {
    const s = await seedClient({ subs: [] });
    await row(s, "check_in", "2026-11-20");
    expect((await sweepLadder(e, NOW)).drafted).toBe(1);
  });

  it("a thank_you row becomes due, not an approval, and so does a case_study", async () => {
    const s = await seedClient();
    const a = await row(s, "thank_you", "2026-11-20");
    const b = await row(s, "case_study", "2026-11-21");
    expect(await sweepLadder(e, NOW)).toEqual({ filled: 0, drafted: 0, due: 2, skipped: 0, held: 0 });
    expect((await rowOf(s, a)).status).toBe("due");
    expect((await rowOf(s, b)).status).toBe("due");
    expect(await approvals()).toHaveLength(0);
  });

  it("a review_request without a place id or link becomes due with the note \"add the Google review link\"; with a link, or a place id, it drafts", async () => {
    const s = await seedClient();
    const id = await row(s, "review_request", "2026-11-22");
    expect((await sweepLadder(e, NOW)).due).toBe(1);
    expect(await rowOf(s, id)).toMatchObject({ status: "due", note: "add the Google review link" });
    expect(await approvals()).toHaveLength(0);

    const withLink = await seedClient();
    const linked = await row(withLink, "review_request", "2026-11-22", LINK);
    const withPlace = await seedClient();
    const placed = await row(withPlace, "review_request", "2026-11-22");
    await upsertProfile(env.DB, withPlace.businessId, { placeId: "ChIJace" }, "2026-11-01T00:00:00.000Z");
    expect(await sweepLadder(e, NOW)).toMatchObject({ drafted: 2, due: 0 });
    expect((await rowOf(withLink, linked)).status).toBe("drafted");
    expect((await rowOf(withPlace, placed)).status).toBe("drafted");
    expect((await approvals()).some((a) => a.preview.includes("writereview?placeid=ChIJace"))).toBe(true);
  });

  it("a row 46 days late is skipped with a note, 45 days late is not; the December letter is not late from 1 to 31 December and is skipped from January", async () => {
    const s = await seedClient();
    const late = await row(s, "thank_you", "2026-10-07"); // 46 days before 22 November
    const ok = await row(s, "thank_you", "2026-10-08"); // 45
    expect(tooLate({ step: "thank_you", dueOn: "2026-10-07" }, "2026-11-22")).toBe(true);
    expect(tooLate({ step: "thank_you", dueOn: "2026-10-08" }, "2026-11-22")).toBe(false);
    expect(await sweepLadder(e, NOW)).toMatchObject({ skipped: 1, due: 1 });
    expect(await rowOf(s, late)).toMatchObject({ status: "skipped", note: "skipped: more than 45 days late" });
    expect((await rowOf(s, late)).doneAt).not.toBeNull();
    expect((await rowOf(s, ok)).status).toBe("due");

    const live = await seedClient({ subs: [ACTIVE] });
    const dec = await row(live, "december_letter", "2026-12-01");
    for (const day of ["2026-12-01", "2026-12-20", "2026-12-31"]) expect(tooLate({ step: "december_letter", dueOn: "2026-12-01" }, day)).toBe(false);
    expect(tooLate({ step: "december_letter", dueOn: "2026-12-01" }, "2027-01-01")).toBe(true);
    expect((await sweepLadder(e, at("2026-12-31"))).skipped).toBe(0);
    expect((await rowOf(live, dec)).status).toBe("drafted");

    const missed = await seedClient({ subs: [ACTIVE] });
    const gone = await row(missed, "december_letter", "2026-12-01");
    expect((await sweepLadder(e, at("2027-01-31"))).skipped).toBe(1);
    expect(await rowOf(missed, gone)).toMatchObject({ status: "skipped", note: "skipped: the year ended before it was sent" });
  });

  it("a held, test, ended or do-not-contact client keeps its row waiting and nothing is drafted", async () => {
    const held = await seedClient({ invoice: { cents: 5000 } });
    expect(await placeHold(env.DB, { businessId: held.businessId, invoiceId: held.invoice!.id, now: NOW.toISOString() })).toBe(true);
    const test = await seedClient({ test: true });
    const ended = await seedClient({ subs: [{ monthlyCents: 100, status: "cancelled" }, { monthlyCents: 200, status: "ended" }] });
    const dnc = await seedClient();
    await addDoNotContact(env.DB, { kind: "email", value: "pat@ace.test", reason: "opt_out" });
    const ids: [Client, string][] = [];
    for (const s of [held, test, ended, dnc]) ids.push([s, await row(s, "review_request", "2026-11-22", LINK)], [s, await row(s, "thank_you", "2026-11-22")]);
    expect(await sweepLadder(e, NOW)).toEqual({ filled: 0, drafted: 0, due: 0, skipped: 0, held: 8 });
    for (const [s, id] of ids) expect((await rowOf(s, id)).status).toBe("waiting");
    expect(await approvals()).toHaveLength(0);
  });

  it("an ended client with one subscription still billing is not ended", async () => {
    const s = await seedClient({ subs: [{ monthlyCents: 100, status: "cancelled" }, ACTIVE] });
    await row(s, "check_in", "2026-11-22");
    expect((await sweepLadder(e, NOW)).drafted).toBe(1);
  });

  it("the December letter needs an active or past_due subscription: a build-only client keeps it waiting, a past_due one drafts it", async () => {
    const buildOnly = await seedClient();
    const late = await seedClient({ subs: [{ monthlyCents: 12900, status: "past_due" }] });
    const a = await row(buildOnly, "december_letter", "2026-12-01");
    const b = await row(late, "december_letter", "2026-12-01");
    expect(await sweepLadder(e, at("2026-12-02"))).toMatchObject({ drafted: 1, held: 1 });
    expect((await rowOf(buildOnly, a)).status).toBe("waiting");
    expect((await rowOf(late, b)).status).toBe("drafted");
  });

  it("a client with no contact email becomes due with a note", async () => {
    const s = await seedClient();
    await env.DB.prepare(`UPDATE people SET email = NULL WHERE business_id = ?`).bind(s.businessId).run();
    const id = await row(s, "check_in", "2026-11-22");
    expect(await sweepLadder(e, NOW)).toMatchObject({ drafted: 0, due: 1 });
    expect(await rowOf(s, id)).toMatchObject({ status: "due", note: "add a contact email" });
    const both = await seedClient();
    await env.DB.prepare(`UPDATE people SET email = NULL WHERE business_id = ?`).bind(both.businessId).run();
    const r = await row(both, "review_request", "2026-11-22");
    await sweepLadder(e, NOW);
    expect((await rowOf(both, r)).note).toBe("add the Google review link and a contact email");
  });

  it("at most 10 drafts per run, oldest first, the rest next run; a test client's older row does not use up the ten", async () => {
    expect(MAX_DRAFTS_PER_RUN).toBe(10);
    const test = await seedClient({ test: true });
    await row(test, "check_in", "2026-11-01");
    const clients: Client[] = [], ids: string[] = [];
    for (let i = 0; i < 12; i++) { const s = await seedClient(); clients.push(s); ids.push(await row(s, "check_in", `2026-11-${String(10 + i).padStart(2, "0")}`)); }
    expect(await sweepLadder(e, NOW)).toMatchObject({ drafted: 10, held: 1 });
    const statuses = await Promise.all(clients.map(async (s, i) => (await rowOf(s, ids[i])).status));
    expect(statuses).toEqual([...Array(10).fill("drafted"), "waiting", "waiting"]);
    expect(await approvals()).toHaveLength(10);
    expect(await sweepLadder(e, NOW)).toMatchObject({ drafted: 2, held: 1 });
    expect((await Promise.all(clients.map(async (s, i) => (await rowOf(s, ids[i])).status))).every((x) => x === "drafted")).toBe(true);
    expect(await approvals()).toHaveLength(12);
  });

  it("December rows are made once a year for live clients only, not before 1 December", async () => {
    const live = await seedClient({ subs: [ACTIVE] });
    const late = await seedClient({ subs: [{ monthlyCents: 12900, status: "past_due" }] });
    const buildOnly = await seedClient();
    const ended = await seedClient({ subs: [{ monthlyCents: 100, status: "cancelled" }] });
    const rehearsal = await seedClient({ test: true, subs: [ACTIVE] });
    const december = async (s: Client) => (await listLadder(env.DB, s.businessId)).filter((r) => r.step === "december_letter").map((r) => [r.dueOn, r.status]);

    expect((await sweepLadder(e, at("2026-11-30"))).filled).toBe(0);
    expect(await december(live)).toEqual([]);

    expect((await sweepLadder(e, at("2026-12-01"))).filled).toBe(2);
    expect(await december(live)).toEqual([["2026-12-01", "drafted"]]);
    expect(await december(late)).toEqual([["2026-12-01", "drafted"]]);
    for (const s of [buildOnly, ended, rehearsal]) expect(await december(s)).toEqual([]);
    expect((await approvals()).map((a) => a.title)).toEqual(["December letter for Ace Plumbing", "December letter for Ace Plumbing"]);

    expect((await sweepLadder(e, at("2026-12-15"))).filled).toBe(0); // once a year
    expect(await december(live)).toHaveLength(1);
    expect(await approvals()).toHaveLength(2);
  });

  it("calls backfillLadder first: a finished build whose hook never ran gets its steps, and its launch-day mail is drafted in the same run", async () => {
    const s = await seedClient();
    await env.DB.prepare(`UPDATE projects SET status = 'done', completed_at = ? WHERE id = ?`).bind("2026-11-22T17:00:00.000Z", s.project!.id).run();
    const r = await sweepLadder(e, NOW);
    expect(r.filled).toBe(5);
    expect((await listLadder(env.DB, s.businessId)).map((x) => [x.step, x.status])).toEqual([["review_request", "due"], ["testimonial", "waiting"], ["thank_you", "waiting"], ["check_in", "waiting"], ["case_study", "waiting"]]);
    expect(r.due).toBe(1); // no review link yet
  });

  it("is part of the daily cron and sends nothing", async () => {
    const s = await seedClient();
    await row(s, "check_in", "2026-11-22");
    const mail = await readyToSend();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runScheduled(e, DAILY_CRON, NOW);
    expect((await approvals()).length).toBe(1);
    expect(mail.sent).toHaveLength(0);
  });
});
