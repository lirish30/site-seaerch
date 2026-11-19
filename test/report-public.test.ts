import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { publicReport } from "../src/worker/db/reports";
import { saveSettings } from "../src/worker/db/settings";
import { setVideoStatus } from "../src/worker/db/videoAudits";
import { CAL_SCOPE, WEEKDAY_WINDOWS, connectGoogle, resetBookingTables, seedLead, setBookingConfig } from "./fixtures/booking";
import { renderedVideo } from "./fixtures/video";

const pub = async (token: string) => (await SELF.fetch(`https://x/api/public/report/${token}`)).json<any>();
const BASE = "https://go.hellositeline.test";

beforeEach(async () => {
  await resetBookingTables();
  await env.DB.prepare(`DELETE FROM video_audits`).run();
});

describe("bookingUrl", () => {
  it("bookingUrl is the per-lead page when booking is on, the old link otherwise", async () => {
    await saveSettings(env.DB, { booking_url: "https://cal.example.com/me" });
    const { token } = await seedLead();
    // Off: Google not connected, so no video means no link at all (the old rule).
    await setBookingConfig({ windows: WEEKDAY_WINDOWS });
    expect((await pub(token)).bookingUrl).toBe("");

    // On: Google connected with both calendar scopes and at least one window. No video needed.
    await connectGoogle();
    expect((await pub(token)).bookingUrl).toBe(`${BASE}/r/${token}/book`);

    // Still off when there are no windows, or when only one calendar scope was granted.
    await setBookingConfig({ windows: [] });
    expect((await pub(token)).bookingUrl).toBe("");
    await setBookingConfig({ windows: WEEKDAY_WINDOWS });
    await connectGoogle("openid email https://www.googleapis.com/auth/calendar.events");
    expect((await pub(token)).bookingUrl).toBe("");
    await connectGoogle(null);
    expect((await pub(token)).bookingUrl).toBe("");
  });

  it("the old booking_url rule still applies when booking is off, and the per-lead page wins when it is on", async () => {
    await saveSettings(env.DB, { booking_url: "https://cal.example.com/me" });
    const { v, token } = await renderedVideo();
    await setVideoStatus(env.DB, v.id, "published");
    // Booking off (no Google): the Plan 3 link, beside the video.
    expect((await pub(token)).bookingUrl).toBe("https://cal.example.com/me");
    await setBookingConfig({ windows: [] });
    await connectGoogle();
    expect((await pub(token)).bookingUrl).toBe("https://cal.example.com/me"); // windowless
    await setBookingConfig({ windows: WEEKDAY_WINDOWS });
    expect((await pub(token)).bookingUrl).toBe(`${BASE}/r/${token}/book`);
    await connectGoogle(CAL_SCOPE.replace(" https://www.googleapis.com/auth/calendar.freebusy", ""));
    expect((await pub(token)).bookingUrl).toBe("https://cal.example.com/me");
  });

  it("the per-lead page needs a usable OUTREACH_LINK_BASE", async () => {
    await setBookingConfig({ windows: WEEKDAY_WINDOWS });
    await connectGoogle();
    const { token } = await seedLead();
    expect((await publicReport(env.DB, token, new Date(), { linkBase: "https://go.example.test/" }))!.bookingUrl).toBe(`https://go.example.test/r/${token}/book`);
    for (const linkBase of [undefined, "", "   ", "http://go.example.test", "not a url"]) {
      expect((await publicReport(env.DB, token, new Date(), { linkBase }))!.bookingUrl, String(linkBase)).toBe("");
    }
  });

  it("does not add anything else to the public report", async () => {
    await setBookingConfig({ windows: WEEKDAY_WINDOWS });
    await connectGoogle();
    const { token } = await seedLead();
    expect(Object.keys(await pub(token)).sort()).toEqual(["auditedAt", "bookingUrl", "businessName", "counts", "expiresAt", "findings", "partial", "sender", "video", "website"]);
  });
});
