import { describe, expect, it } from "vitest";
import type { Booking } from "../src/worker/db/bookings";
import type { Settings } from "../src/worker/types";
import { renderConfirmation, renderReminder } from "../src/worker/booking/mail";
import { composeOutbound } from "../src/worker/mail/send";

const settings = { booking_config: "{}", signature: "Logan", signature_json: "", physical_address: "1 Main St", opt_out_line: "Reply stop." } as Settings;
const CANCEL = "c".repeat(43), TOKEN = "t".repeat(43), BASE = "https://go.hellositeline.test";

const booking = (over: Partial<Booking> = {}): Booking => ({
  id: "b1", businessId: "biz", dealId: null, kind: "discovery", status: "confirmed", startAt: "2026-11-24T18:00:00.000Z", endAt: "2026-11-24T18:20:00.000Z",
  contactName: "Pat Jones", contactEmail: "pat@acme.test", contactPhone: null, answers: null, calendarEventId: "ev", meetUrl: "https://meet.google.com/abc-defg-hij",
  cancelToken: CANCEL, source: "visitor", createdAt: "2026-11-18T18:00:00.000Z", cancelledAt: null, ...over,
});

describe("renderConfirmation", () => {
  it("confirmation escapes a name containing script tags", () => {
    const name = `<script>alert(1)</script>`;
    const m = renderConfirmation(booking({ contactName: name }), settings, BASE, TOKEN);
    // The body is plain text: the name is there as typed, as text.
    expect(m.body).toContain(`Hi ${name},`);
    // The html is made from it by the sender: no raw tag gets through.
    const html = composeOutbound(settings, { mailbox: "main", subject: m.subject, body: m.body, includeFooter: false }).html;
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(m.subject).not.toContain("script");
  });

  it("confirmation carries the meet link and a cancel link on the outreach host", () => {
    const m = renderConfirmation(booking(), settings, `${BASE}/`, TOKEN);
    expect(m.body).toContain("https://meet.google.com/abc-defg-hij");
    expect(m.body).toContain(`${BASE}/r/${TOKEN}/book?cancel=${CANCEL}`);
    expect(m.body).not.toContain("workers.dev");
    expect(m.body).not.toContain("sitelineweb.com");
    // The time is in Pacific, with the zone's name, and is the whole of the subject's news.
    expect(m.body).toContain("Tuesday, November 24 at 10:00 AM Pacific Standard Time");
    expect(m.subject).toBe("Your call is booked for Tue, Nov 24 at 10:00 AM PST");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  it("without a usable link base it says to reply, and never invents a link", () => {
    const m = renderConfirmation(booking({ meetUrl: null }), settings, "", TOKEN);
    expect(m.body).not.toContain("http");
    expect(m.body).toContain("reply to this email");
  });

  it("a name with line breaks stays on one line", () => {
    const m = renderConfirmation(booking({ contactName: "Pat\r\nBcc: x@y.test" }), settings, BASE, TOKEN);
    expect(m.body.split("\n")[0]).toBe("Hi Pat Bcc: x@y.test,");
  });
});

describe("renderReminder", () => {
  it("reminder subject says the time left", () => {
    expect(renderReminder(booking(), 1440, settings).subject).toBe("Your call is in 24 hours");
    expect(renderReminder(booking(), 60, settings).subject).toBe("Your call is in 1 hour");
    expect(renderReminder(booking(), 10, settings).subject).toBe("Your call is in 10 minutes");
  });

  it("a reminder names the time in Pacific, carries the meet link and has no cancel link", () => {
    const m = renderReminder(booking({ startAt: "2027-03-16T17:00:00.000Z" }), 60, settings);
    expect(m.body).toContain("Tuesday, March 16 at 10:00 AM Pacific Daylight Time");
    expect(m.body).toContain("https://meet.google.com/abc-defg-hij");
    expect(m.body).not.toContain("cancel=");
  });
});
