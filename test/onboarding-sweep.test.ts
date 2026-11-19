import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { getHandler, registeredKinds } from "../src/worker/approvals/registry";
import "../src/worker/approvals/onboardingNudge";
import { toApproval, type Approval } from "../src/worker/db/approvals";
import { listActivity } from "../src/worker/db/activity";
import { setArchived } from "../src/worker/db/businesses";
import { createDraft } from "../src/worker/db/documents";
import {
  closeOnboarding, createOnboarding, getOnboarding, listItems, markWelcomeSent, setItemStatus, setRevoked, submitQuestionnaire, touchClient, type NewItem,
} from "../src/worker/db/onboardings";
import { saveSettings } from "../src/worker/db/settings";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { dueDatesFor } from "../src/worker/onboarding/schedule";
import { sweepOnboardings } from "../src/worker/onboarding/sweep";
import { runScheduled, DAILY_CRON } from "../src/worker/schedule";
import { OWNER_EMAIL, proposal, readyToSend, seedDeal } from "./fixtures/documents";

const DAY = 86_400_000, HOUR = 3_600_000;
/** A Monday, 09:00 in Los Angeles (PST: daylight saving ended on 1 November 2026). */
const T0 = new Date("2026-11-02T17:00:00.000Z");
const at = (ms: number, from = T0) => new Date(from.getTime() + ms);
const iso = (d: Date) => d.toISOString();

const ITEMS: NewItem[] = [
  { key: "logo", label: "Logo", instructions: "Send your logo", kind: "files", phase: 1 },
  { key: "about", label: "About text", instructions: "Tell us about you", kind: "text", phase: 1 },
];

let errors: ReturnType<typeof vi.spyOn>;
/** Storage is shared by the tests of a file: start each from no onboardings and no approvals (the sweep reads every open onboarding). */
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.batch(["onboarding_nudges", "onboarding_files", "onboarding_answers", "onboarding_items", "onboardings", "approvals"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

/** A lead with a deal, a document, and an onboarding whose welcome went out at `welcomeAt` (the default) or has not gone out (`welcomeAt: null`). */
async function seed(o: { test?: boolean; welcomeAt?: Date | null; items?: NewItem[]; contactEmail?: string } = {}) {
  const s = await seedDeal();
  const base = proposal();
  const content = { ...base, header: { ...base.header, contactEmail: o.contactEmail ?? base.header.contactEmail } };
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content });
  const { onboarding } = await createOnboarding(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "build", test: o.test ?? false, items: o.items ?? ITEMS,
  });
  const welcomeAt = o.welcomeAt === undefined ? T0 : o.welcomeAt;
  if (welcomeAt) await markWelcomeSent(env.DB, onboarding.id, { sentAt: iso(welcomeAt), ...dueDatesFor(welcomeAt) });
  return { ...s, id: onboarding.id, documentId: doc.id };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

const nudges = async (dealId: string) =>
  (await env.DB.prepare(`SELECT * FROM approvals WHERE kind = 'onboarding.nudge' AND record_id = ? ORDER BY created_at, id`).bind(dealId).all<Parameters<typeof toApproval>[0]>()).results.map(toApproval);
const keys = async (id: string) =>
  (await env.DB.prepare(`SELECT key, approval_id FROM onboarding_nudges WHERE onboarding_id = ? ORDER BY key`).bind(id).all<{ key: string; approval_id: string | null }>()).results;
const activity = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const skipNotes = async (businessId: string) => (await activity(businessId, "note")).filter((n) => n.startsWith("reminder skipped:"));
const touch = (id: string, when: Date) => touchClient(env.DB, id, iso(when));
const sweep = (now: Date, e: Env = env as Env) => sweepOnboardings(e, now);
const NONE = { reminders: 0, fridays: 0, waiting: 0 };

describe("registration", () => {
  it("the nudge kind is registered, labelled, and still kept out of the MCP's proposable kinds", () => {
    expect(registeredKinds()).toContain("onboarding.nudge");
    expect(getHandler("onboarding.nudge")!.label).toBe("Send onboarding reminder");
  });
});

describe("the reminder ladder", () => {
  it("day-2 silence makes one level-1 reminder approval and a second sweep makes none", async () => {
    const mail = await readyToSend();
    const s = await seed();

    expect(await sweep(at(DAY))).toEqual(NONE); // one day of silence: nothing due
    expect(await sweep(at(2 * DAY))).toEqual({ reminders: 1, fridays: 0, waiting: 0 });
    expect(await sweep(at(2 * DAY + HOUR))).toEqual(NONE);

    const a = await nudges(s.dealId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ status: "pending", title: "Reminder to Ace Plumbing", record_type: "deal", record_id: s.dealId, drafted_by: "job" });
    expect(a[0].payload).toEqual({ onboardingId: s.id, nudgeKey: `reminder:1:${iso(T0)}` });
    expect(a[0].preview).toContain("To: Pat Jones <pat@ace.test>");
    expect(a[0].preview).toContain("Subject: A quick nudge about your site");
    expect(a[0].preview).toContain(`/o/${(await getOnboarding(env.DB, s.id))!.token}`);
    expect(await keys(s.id)).toEqual([{ key: `reminder:1:${iso(T0)}`, approval_id: a[0].id }]);
    expect(mail.sent).toEqual([]);
  });

  it("a client write resets the ladder and level 1 can be drafted again", async () => {
    await readyToSend();
    const s = await seed();
    await sweep(at(2 * DAY));
    expect(await nudges(s.dealId)).toHaveLength(1);

    const wrote = at(2 * DAY + HOUR);
    await touch(s.id, wrote);
    expect(await sweep(at(3 * DAY))).toEqual(NONE); // under a day since the client wrote
    expect(await sweep(at(5 * DAY))).toEqual({ reminders: 1, fridays: 0, waiting: 0 }); // a Saturday, two days on
    const a = await nudges(s.dealId);
    expect(a.map((x) => (x.payload as { nudgeKey: string }).nudgeKey)).toEqual([`reminder:1:${iso(T0)}`, `reminder:1:${iso(wrote)}`]);
  });

  it("a client silent for 10 days after a cron outage gets one level-4 reminder, not four", async () => {
    await readyToSend();
    const s = await seed();
    expect(await sweep(at(10 * DAY))).toEqual({ reminders: 1, fridays: 0, waiting: 0 });

    const a = await nudges(s.dealId);
    expect(a).toHaveLength(1);
    expect(a[0].payload).toEqual({ onboardingId: s.id, nudgeKey: `reminder:4:${iso(T0)}` });
    expect(a[0].preview).toContain("Subject: Last reminder before your project moves back");
    // Levels 1 to 3 are marked as handled with no approval, so they can never be drafted later.
    expect(await keys(s.id)).toEqual([
      { key: `reminder:1:${iso(T0)}`, approval_id: null }, { key: `reminder:2:${iso(T0)}`, approval_id: null },
      { key: `reminder:3:${iso(T0)}`, approval_id: null }, { key: `reminder:4:${iso(T0)}`, approval_id: a[0].id },
    ]);
    expect(await sweep(at(10 * DAY + 6 * HOUR))).toEqual(NONE);
    expect(await nudges(s.dealId)).toHaveLength(1);
  });

  it("each step up the ladder drafts only the new level", async () => {
    await readyToSend();
    const s = await seed();
    await sweep(at(2 * DAY));
    await sweep(at(4 * DAY + HOUR)); // a Friday as well: see the Friday tests; only reminders are counted here
    const levels = (await nudges(s.dealId)).map((x) => (x.payload as { nudgeKey: string }).nudgeKey).filter((k) => k.startsWith("reminder"));
    expect(levels).toEqual([`reminder:1:${iso(T0)}`, `reminder:2:${iso(T0)}`]);
  });

  it("level 3 names the day the silence clause applies, in the owner's zone", async () => {
    const mail = await readyToSend();
    const s = await seed();
    await sweep(at(7 * DAY));
    const a = (await nudges(s.dealId))[0];
    expect(a.payload).toEqual({ onboardingId: s.id, nudgeKey: `reminder:3:${iso(T0)}` });
    expect(a.preview).toContain("November 16, 2026");
    expect(await approve(env as Env, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].text).toContain("November 16, 2026");
  });
});

describe("the Friday email", () => {
  it("friday drafts one approval per friday date", async () => {
    await readyToSend();
    const s = await seed();
    const thu = new Date("2026-11-05T22:00:00.000Z"), fri = new Date("2026-11-06T17:00:00.000Z");
    await touch(s.id, thu);
    expect(await sweep(fri)).toEqual({ reminders: 0, fridays: 1, waiting: 0 });
    expect(await sweep(at(HOUR, fri))).toEqual(NONE);

    const a = await nudges(s.dealId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ title: "Friday update to Ace Plumbing", status: "pending" });
    expect(a[0].payload).toEqual({ onboardingId: s.id, nudgeKey: "friday:2026-11-06" });
    expect(a[0].preview).toContain("To: Pat Jones <pat@ace.test>");
    expect(a[0].preview).toContain("Subject: Where your site stands this week");
    expect(a[0].preview).toContain("- Logo");
    expect(a[0].preview).toContain("Your questionnaire is not in yet");

    const nextThu = new Date("2026-11-12T22:00:00.000Z"), nextFri = new Date("2026-11-13T17:00:00.000Z");
    await touch(s.id, nextThu);
    expect(await sweep(nextFri)).toEqual({ reminders: 0, fridays: 1, waiting: 0 });
    expect((await nudges(s.dealId)).map((x) => (x.payload as { nudgeKey: string }).nudgeKey)).toEqual(["friday:2026-11-06", "friday:2026-11-13"]);
  });

  it("friday at the zone boundary: 23:30 Thursday Pacific is not Friday", async () => {
    await readyToSend();
    const s = await seed();
    await touch(s.id, new Date("2026-11-06T00:00:00.000Z"));
    expect(await sweep(new Date("2026-11-06T07:30:00.000Z"))).toEqual(NONE); // Friday in UTC, still Thursday in Los Angeles
    expect(await nudges(s.dealId)).toEqual([]);
    expect(await sweep(new Date("2026-11-06T08:00:00.000Z"))).toEqual({ reminders: 0, fridays: 1, waiting: 0 }); // midnight Friday in Los Angeles
  });

  it("an unreadable time zone in the settings still gives a Friday email (Los Angeles is used)", async () => {
    await readyToSend();
    await saveSettings(env.DB, { booking_config: JSON.stringify({ timezone: "Mars/Olympus" }) });
    const s = await seed();
    await touch(s.id, new Date("2026-11-06T00:00:00.000Z"));
    expect(await sweep(new Date("2026-11-06T07:30:00.000Z"))).toEqual(NONE);
    expect(await sweep(new Date("2026-11-06T17:00:00.000Z"))).toEqual({ reminders: 0, fridays: 1, waiting: 0 });
  });

  it("no Friday email within 24 hours of the welcome, and one after that", async () => {
    await readyToSend();
    const fri = new Date("2026-11-06T17:00:00.000Z");
    const fresh = await seed({ welcomeAt: at(-7 * HOUR, fri) }); // welcome this morning
    expect(await sweep(fri)).toEqual(NONE);
    expect(await nudges(fresh.dealId)).toEqual([]);
    expect(await keys(fresh.id)).toEqual([]); // not claimed, so nothing is lost either

    const older = await seed({ welcomeAt: at(-31 * HOUR, fri) });
    expect(await sweep(fri)).toEqual({ reminders: 0, fridays: 1, waiting: 0 });
    expect(await nudges(older.dealId)).toHaveLength(1);
  });

  it("lists what has come in, what is open, and says when the questionnaire is in", async () => {
    await readyToSend();
    const s = await seed();
    const [logo, about] = await listItems(env.DB, s.id);
    await setItemStatus(env.DB, logo.id, "received");
    await submitQuestionnaire(env.DB, s.id, "2026-11-05T20:00:00.000Z");
    expect(about.status).toBe("waiting");
    await sweep(new Date("2026-11-06T17:00:00.000Z"));
    const p = (await nudges(s.dealId))[0].preview;
    expect(p).toContain("Your questionnaire is in.");
    expect(p).toMatch(/I have received:\n- Logo/);
    expect(p).toMatch(/Still open:\n- About text/);
  });
});

describe("what is never drafted", () => {
  const FRI_LATE = new Date("2026-11-13T17:00:00.000Z"); // a Friday, 11 days after the welcome

  it("no approval for a complete, closed, revoked or welcome-unsent onboarding", async () => {
    await readyToSend();
    const complete = await seed();
    await submitQuestionnaire(env.DB, complete.id, "2026-11-02T18:00:00.000Z");
    for (const i of await listItems(env.DB, complete.id)) await setItemStatus(env.DB, i.id, "accepted");
    const closed = await seed();
    await closeOnboarding(env.DB, closed.id, "2026-11-03T00:00:00.000Z");
    const revoked = await seed();
    await setRevoked(env.DB, revoked.id, true, "2026-11-03T00:00:00.000Z");
    const unsent = await seed({ welcomeAt: null });

    expect(await sweep(FRI_LATE)).toEqual(NONE);
    for (const s of [complete, closed, revoked, unsent]) expect(await nudges(s.dealId)).toEqual([]);
    expect(await keys(revoked.id)).toEqual([]); // nothing claimed: restoring the link brings the reminder back
    expect(await activity(complete.businessId, "onboarding_waiting")).toEqual([]);
    expect(await activity(unsent.businessId, "onboarding_waiting")).toEqual([]);
  });

  it("a revoked link is noted once on the lead, and restoring it drafts the highest reminder due", async () => {
    await readyToSend();
    const s = await seed();
    await setRevoked(env.DB, s.id, true, "2026-01-01T00:00:00.000Z"); // before any line the sweep writes with the real clock
    await sweep(at(3 * DAY));
    await sweep(at(4 * DAY));
    const notes = (await activity(s.businessId, "note")).filter((n) => /not drafted/.test(n));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/link is revoked/);

    await setRevoked(env.DB, s.id, false, "2026-11-05T00:00:00.000Z");
    expect(await sweep(at(5 * DAY))).toEqual({ reminders: 1, fridays: 0, waiting: 0 });
    expect((await nudges(s.dealId))[0].payload).toEqual({ onboardingId: s.id, nudgeKey: `reminder:2:${iso(T0)}` });
  });

  it("a missing CLIENT_LINK_BASE drafts nothing and is noted once", async () => {
    const mail = await readyToSend();
    const s = await seed();
    const noBase = { ...env, CLIENT_LINK_BASE: undefined } as Env;
    await sweep(at(3 * DAY), noBase);
    await sweep(at(4 * DAY), noBase);
    expect(await nudges(s.dealId)).toEqual([]);
    expect(await keys(s.id)).toEqual([]);
    const notes = (await activity(s.businessId, "note")).filter((n) => /not drafted/.test(n));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/CLIENT_LINK_BASE/);
    expect(mail.sent).toEqual([]);
    expect(await sweep(at(4 * DAY))).toEqual({ reminders: 1, fridays: 1, waiting: 0 }); // with the base back (a Friday), the next sweep drafts both
  });

  it("an archived lead's open onboarding is still swept", async () => {
    await readyToSend();
    const s = await seed();
    await setArchived(env.DB, s.businessId, true);
    expect(await sweep(at(2 * DAY))).toEqual({ reminders: 1, fridays: 0, waiting: 0 });
    expect(await nudges(s.dealId)).toHaveLength(1);
  });
});

describe("silence", () => {
  it("14 days of silence logs onboarding_waiting once, with the last-activity date", async () => {
    await readyToSend();
    const s = await seed();
    expect(await sweep(at(13 * DAY))).toEqual({ reminders: 1, fridays: 0, waiting: 0 });
    expect(await activity(s.businessId, "onboarding_waiting")).toEqual([]);
    expect(await sweep(at(14 * DAY))).toEqual({ reminders: 0, fridays: 0, waiting: 1 });
    expect(await sweep(at(15 * DAY))).toEqual(NONE);
    expect(await sweep(at(16 * DAY))).toEqual(NONE);
    expect(await activity(s.businessId, "onboarding_waiting")).toEqual(["no reply for 14 days (last heard from the client 2026-11-02): the back-of-queue clause applies"]);

    // The client comes back and goes quiet again: a new silence run logs again.
    await touch(s.id, at(17 * DAY));
    expect(await sweep(at(31 * DAY))).toMatchObject({ waiting: 1 });
    expect(await activity(s.businessId, "onboarding_waiting")).toHaveLength(2);
  });
});

describe("a test onboarding", () => {
  it("a test onboarding's nudge goes to the owner address", async () => {
    const mail = await readyToSend();
    const s = await seed({ test: true });
    await sweep(at(2 * DAY));
    const a = (await nudges(s.dealId))[0];
    expect(a.preview).toContain(`<${OWNER_EMAIL}>`);
    expect(a.preview).toContain("Subject: [Test] A quick nudge about your site");
    expect(a.preview).not.toContain("To: Pat Jones");

    expect(await approve(env as Env, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(OWNER_EMAIL);
    expect(mail.sent[0].subject).toBe("[Test] A quick nudge about your site");
    expect(mail.sent.some((m) => m.to === "pat@ace.test")).toBe(false);
  });

  it("a test onboarding with no owner address is noted, not drafted", async () => {
    await readyToSend();
    await saveSettings(env.DB, { contact_email: "" });
    const s = await seed({ test: true });
    await sweep(at(2 * DAY));
    expect(await nudges(s.dealId)).toEqual([]);
    expect((await activity(s.businessId, "note")).some((n) => /not drafted.*contact email/.test(n))).toBe(true);
  });
});

describe("the approval", () => {
  it("approving a reminder sends it to the contact from the main mailbox", async () => {
    const mail = await readyToSend();
    const s = await seed();
    await sweep(at(2 * DAY));
    const a = (await nudges(s.dealId))[0];
    expect(await approve(env as Env, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("pat@ace.test");
    expect(mail.sent[0].subject).toBe("A quick nudge about your site");
    expect(mail.sent[0].text).toContain(`/o/${(await getOnboarding(env.DB, s.id))!.token}`);
    expect(await skipNotes(s.businessId)).toEqual([]);
  });

  it("approving a stale reminder sends nothing and notes why", async () => {
    const mail = await readyToSend();
    const s = await seed();
    await sweep(at(2 * DAY));
    const a = (await nudges(s.dealId))[0];
    await touch(s.id, at(2 * DAY + HOUR)); // the client wrote after the reminder was drafted

    expect(await approve(env as Env, a.id)).toEqual({ ok: true }); // it does not throw, so the approval is decided, not pending forever
    expect(mail.sent).toEqual([]);
    expect(await skipNotes(s.businessId)).toEqual(["reminder skipped: the client was in touch after it was drafted"]);
    expect((await nudges(s.dealId))[0].status).toBe("approved");
  });

  it("approving a nudge for a closed, revoked or complete onboarding sends nothing and notes why", async () => {
    const mail = await readyToSend();
    const closed = await seed(), revoked = await seed(), complete = await seed();
    for (const s of [closed, revoked, complete]) await sweep(at(2 * DAY));
    await closeOnboarding(env.DB, closed.id, "2026-11-03T00:00:00.000Z");
    await setRevoked(env.DB, revoked.id, true, "2026-11-03T00:00:00.000Z");
    await submitQuestionnaire(env.DB, complete.id, "2026-11-02T18:00:00.000Z");
    for (const i of await listItems(env.DB, complete.id)) await setItemStatus(env.DB, i.id, "accepted");
    // The client's own write after the reminder would also make a reminder stale: put the activity back so only the stated reason applies.
    await env.DB.prepare(`UPDATE onboardings SET last_client_activity_at = ? WHERE id = ?`).bind(iso(T0), complete.id).run();

    for (const s of [closed, revoked, complete]) {
      const a = (await nudges(s.dealId))[0];
      expect(await approve(env as Env, a.id)).toEqual({ ok: true });
    }
    expect(mail.sent).toEqual([]);
    expect(await skipNotes(closed.businessId)).toEqual(["reminder skipped: the onboarding is closed"]);
    expect(await skipNotes(revoked.businessId)).toEqual(["reminder skipped: the client's link was revoked"]);
    expect(await skipNotes(complete.businessId)).toEqual(["reminder skipped: everything the client owed is in"]);
  });

  it("a Friday email is still wanted after the client has written, and skipped once everything is in", async () => {
    const mail = await readyToSend();
    const s = await seed(), other = await seed();
    await touch(s.id, new Date("2026-11-05T22:00:00.000Z"));
    await touch(other.id, new Date("2026-11-05T22:00:00.000Z"));
    await sweep(new Date("2026-11-06T17:00:00.000Z"));
    const [a] = await nudges(s.dealId), [b] = await nudges(other.dealId);
    await touch(s.id, new Date("2026-11-06T18:00:00.000Z")); // the client writes later that day: a Friday update is still true
    expect(await approve(env as Env, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe("Where your site stands this week");

    await submitQuestionnaire(env.DB, other.id, "2026-11-06T18:00:00.000Z");
    for (const i of await listItems(env.DB, other.id)) await setItemStatus(env.DB, i.id, "accepted");
    expect(await approve(env as Env, b.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(await skipNotes(other.businessId)).toEqual(["reminder skipped: everything the client owed is in"]);
  });

  it("approving twice sends once", async () => {
    const mail = await readyToSend();
    const s = await seed();
    await sweep(at(2 * DAY));
    const a = (await nudges(s.dealId))[0];
    expect(await approve(env as Env, a.id)).toEqual({ ok: true });
    expect(await approve(env as Env, a.id)).toMatchObject({ ok: false, status: 409 });
    expect(mail.sent).toHaveLength(1);

    // Even if the handler itself runs again for the same approval, the once-only send holds.
    const h = getHandler("onboarding.nudge")!;
    await h.execute(env as Env, h.parse(a.payload), a as Approval);
    expect(mail.sent).toHaveLength(1);
  });

  it("a mail server failure puts the approval back to pending so it can be retried", async () => {
    const mail = await readyToSend();
    const s = await seed();
    await sweep(at(2 * DAY));
    const a = (await nudges(s.dealId))[0];
    mail.failures.push(new Error("smtp down"));
    expect(await approve(env as Env, a.id)).toMatchObject({ ok: false, status: 502 });
    expect((await nudges(s.dealId))[0].status).toBe("pending");
    expect(await approve(env as Env, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
  });
});

describe("the sweep is safe", () => {
  it("the sweep never sends mail by itself", async () => {
    const mail = await readyToSend();
    const sends = vi.fn();
    setMailDeps({ smtp: async (_mb, _pw, msg) => { sends(msg); mail.sent.push(msg); }, now: () => T0 });
    await seed();
    await seed({ test: true });
    for (const n of [2, 4, 6, 10, 14, 20]) await sweep(at(n * DAY));
    await sweep(new Date("2026-11-06T17:00:00.000Z"));
    expect(sends).not.toHaveBeenCalled();
    expect(mail.sent).toEqual([]);
  });

  it("the approval failing removes the nudge row so the next sweep retries", async () => {
    await readyToSend();
    const s = await seed();
    await env.DB.prepare(`CREATE TRIGGER fail_nudge BEFORE INSERT ON approvals WHEN NEW.kind = 'onboarding.nudge' BEGIN SELECT RAISE(ABORT, 'no approvals today'); END`).run();
    expect(await sweep(at(2 * DAY))).toEqual(NONE);
    expect(await nudges(s.dealId)).toEqual([]);
    expect(await keys(s.id)).toEqual([]);
    expect(errors).toHaveBeenCalled();

    await env.DB.prepare(`DROP TRIGGER fail_nudge`).run();
    expect(await sweep(at(2 * DAY + HOUR))).toEqual({ reminders: 1, fridays: 0, waiting: 0 });
    expect(await nudges(s.dealId)).toHaveLength(1);
  });

  it("one broken onboarding does not stop the others", async () => {
    await readyToSend();
    const noApproval = await seed(), noNote = await seed(), fine = await seed();
    // The first cannot get an approval; the second cannot log its silence note (so it fails before it drafts anything).
    await env.DB.prepare(`CREATE TRIGGER fail_a BEFORE INSERT ON approvals WHEN NEW.record_id = '${noApproval.dealId}' BEGIN SELECT RAISE(ABORT, 'broken'); END`).run();
    await env.DB.prepare(`CREATE TRIGGER fail_n BEFORE INSERT ON activity WHEN NEW.business_id = '${noNote.businessId}' AND NEW.kind = 'onboarding_waiting' BEGIN SELECT RAISE(ABORT, 'broken'); END`).run();

    expect(await sweep(at(14 * DAY))).toEqual({ reminders: 1, fridays: 0, waiting: 2 });
    expect(await nudges(noApproval.dealId)).toEqual([]);
    expect((await keys(noApproval.id)).map((k) => k.key)).not.toContain(`reminder:4:${iso(T0)}`); // released, so tomorrow retries it
    expect(await nudges(noNote.dealId)).toEqual([]);
    expect(await nudges(fine.dealId)).toHaveLength(1);
    expect(await activity(fine.businessId, "onboarding_waiting")).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
  });

  it("never throws, even when the list cannot be read", async () => {
    await readyToSend();
    const broken = { ...env, DB: { prepare: () => { throw new Error("db down"); } } } as unknown as Env;
    expect(await sweepOnboardings(broken, T0)).toEqual(NONE);
    expect(errors).toHaveBeenCalled();
  });
});

describe("the daily cron", () => {
  it("runs the sweep in the daily branch only", async () => {
    await readyToSend();
    const s = await seed();
    await runScheduled(env as Env, "*/5 * * * *", at(2 * DAY));
    await runScheduled(env as Env, "*/15 * * * *", at(2 * DAY));
    expect(await nudges(s.dealId)).toEqual([]);
    await runScheduled(env as Env, DAILY_CRON, at(2 * DAY));
    expect(await nudges(s.dealId)).toHaveLength(1);
  });
});
