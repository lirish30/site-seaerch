import { describe, expect, it } from "vitest";
import {
  dailyLimitFor, mailboxTitle, secretCommand, secretName, syncLine, syncSummaryLine, testResultLines, warmupLine,
} from "../src/client/mailboxView";
import { dailyLimit } from "../src/worker/mail/limits";

const DAY = 86_400_000;
const START = "2026-11-18T09:30:00.000Z";
const at = (days: number) => new Date(Date.parse(START) + days * DAY + 3_600_000);

describe("warmupLine", () => {
  it("says so when the clock has not started (or the stamp is unreadable)", () => {
    expect(warmupLine({ warmup_started_at: null }, at(0))).toBe("Warm-up not started");
    expect(warmupLine({ warmup_started_at: "not a date" }, at(0))).toBe("Warm-up not started");
  });
  it("counts days from 1 and names the unlock date in UTC", () => {
    expect(warmupLine({ warmup_started_at: START }, at(0))).toBe("Warm-up day 1 of 30. Cold sends unlock on Dec 18");
    expect(warmupLine({ warmup_started_at: START }, at(14))).toBe("Warm-up day 15 of 30. Cold sends unlock on Dec 18");
    expect(warmupLine({ warmup_started_at: START }, at(29))).toBe("Warm-up day 30 of 30. Cold sends unlock on Dec 18");
  });
  it("uses the UTC date even when the stamp is late in the evening there", () => {
    expect(warmupLine({ warmup_started_at: "2026-01-01T23:59:59.000Z" }, new Date("2026-01-02T00:00:00.000Z")))
      .toBe("Warm-up day 1 of 30. Cold sends unlock on Jan 31");
  });
  it("reports the daily limit once the 30 days are up", () => {
    expect(warmupLine({ warmup_started_at: START }, at(30))).toBe("Warm-up complete. Up to 5 a day");
    expect(warmupLine({ warmup_started_at: START }, at(44))).toBe("Warm-up complete. Up to 5 a day");
    expect(warmupLine({ warmup_started_at: START }, at(45))).toBe("Warm-up complete. Up to 10 a day");
    expect(warmupLine({ warmup_started_at: START }, at(60))).toBe("Warm-up complete. Up to 20 a day");
  });
});

describe("dailyLimitFor mirrors the worker's dailyLimit", () => {
  it("agrees on every boundary day and when not started", () => {
    for (const d of [0, 1, 29, 30, 44, 45, 59, 60, 200]) {
      const now = new Date(Date.parse(START) + d * DAY + 1000);
      expect(dailyLimitFor({ warmup_started_at: START }, now), `day ${d}`).toBe(dailyLimit({ warmup_started_at: START }, now));
    }
    expect(dailyLimitFor({ warmup_started_at: null }, new Date())).toBe(dailyLimit({ warmup_started_at: null }, new Date()));
  });
});

describe("syncLine", () => {
  const now = new Date("2026-11-18T12:00:00.000Z");
  it("shows the failure first", () => {
    expect(syncLine({ last_sync_at: "2026-11-18T11:59:00.000Z", last_sync_error: "login failed" }, now)).toBe("Last check failed: login failed");
    expect(syncLine({ last_sync_at: null, last_sync_error: "no route" }, now)).toBe("Last check failed: no route");
  });
  it("shows the sync's own notes as a note on a successful check, not as a failure", () => {
    expect(syncLine({ last_sync_at: "2026-11-18T11:57:00.000Z", last_sync_error: "mailbox UID validity changed; baseline reset" }, now))
      .toBe("Checked 3 min ago. Note: mailbox UID validity changed; baseline reset");
    expect(syncLine({ last_sync_at: "2026-11-18T11:59:30.000Z", last_sync_error: "skipped 2 oversized message(s): uids 4, 9" }, now))
      .toBe("Checked just now. Note: skipped 2 oversized message(s): uids 4, 9");
    expect(syncLine({ last_sync_at: "2026-11-18T11:57:00.000Z", last_sync_error: "skipped 1 oversized message(s): uids 4; gave up on uid 7 after 5 attempts: boom" }, now))
      .toBe("Checked 3 min ago. Note: skipped 1 oversized message(s): uids 4; gave up on uid 7 after 5 attempts: boom");
    // anything else, including a message that only mentions these words, is still a failure
    expect(syncLine({ last_sync_at: "2026-11-18T11:57:00.000Z", last_sync_error: "failed on uid 3: skipped" }, now)).toBe("Last check failed: failed on uid 3: skipped");
    expect(syncLine({ last_sync_at: "2026-11-18T11:57:00.000Z", last_sync_error: "gave up on uid 7 after 5 attempts: boom" }, now)).toBe("Last check failed: gave up on uid 7 after 5 attempts: boom");
  });
  it("says it has never been checked", () => {
    expect(syncLine({ last_sync_at: null, last_sync_error: null }, now)).toBe("Not checked yet");
  });
  it("counts whole minutes, and says just now under one", () => {
    expect(syncLine({ last_sync_at: "2026-11-18T11:56:40.000Z", last_sync_error: null }, now)).toBe("Checked 3 min ago");
    expect(syncLine({ last_sync_at: "2026-11-18T11:59:30.000Z", last_sync_error: null }, now)).toBe("Checked just now");
    expect(syncLine({ last_sync_at: "2026-11-18T12:00:30.000Z", last_sync_error: null }, now)).toBe("Checked just now");
  });
});

describe("mailbox labels and the password secret", () => {
  it("titles the two mailboxes", () => {
    expect(mailboxTitle("outreach")).toBe("Outreach mailbox");
    expect(mailboxTitle("main")).toBe("Main mailbox");
  });
  it("builds the secret name and the one-line command from the key", () => {
    expect(secretName("outreach")).toBe("MAILBOX_OUTREACH_PASSWORD");
    expect(secretName("main")).toBe("MAILBOX_MAIN_PASSWORD");
    expect(secretCommand("outreach")).toBe("wrangler secret put MAILBOX_OUTREACH_PASSWORD");
  });
});

describe("test results as sentences", () => {
  it("words each probe and the SPF record", () => {
    expect(testResultLines({ smtp: { ok: true }, imap: { ok: true }, spf: true })).toEqual(["SMTP: ok", "IMAP: ok", "SPF: yes"]);
    expect(testResultLines({ smtp: { ok: false, error: "bad auth" }, imap: { ok: false, error: "timeout" }, spf: false }))
      .toEqual(["SMTP: error (bad auth)", "IMAP: error (timeout)", "SPF: no"]);
    expect(testResultLines({ smtp: { ok: true }, imap: { ok: true }, spf: null })[2]).toBe("SPF: unknown");
  });
  it("summarises a sync run", () => {
    expect(syncSummaryLine({ fetched: 4, matched: 2, replies: 1, stopped: 1, bounced: 0 })).toBe("Checked: 4 new messages, 2 matched, 1 reply, 1 stopped, 0 bounced.");
    expect(syncSummaryLine({ fetched: 1, matched: 0, replies: 0, stopped: 0, bounced: 0 })).toBe("Checked: 1 new message, 0 matched, 0 replies, 0 stopped, 0 bounced.");
    expect(syncSummaryLine({ fetched: 0, matched: 0, replies: 0, stopped: 0, bounced: 0, error: "boom" })).toBe("Check failed: boom");
  });
});
