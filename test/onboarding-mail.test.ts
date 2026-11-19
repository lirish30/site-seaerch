import { describe, expect, it } from "vitest";
import type { Onboarding } from "../src/worker/db/onboardings";
import type { Settings } from "../src/worker/types";
import { renderFriday, renderReminder, renderWelcome } from "../src/worker/onboarding/mail";

const settings = { your_name: "Logan", signature: "", signature_json: "" } as Settings;
const LINK = "https://go.hellositeline.test/o/" + "t".repeat(43);
const ctx = { clientName: "Acme Roofing", contactName: "Pat Jones", lastClientActivityAt: "2026-11-02T17:00:00.000Z" };
const onb = (over: Partial<Onboarding> = {}): Onboarding => ({
  id: "o1", businessId: "b", dealId: "d", documentId: "doc", kind: "build", test: false, token: "t", revokedAt: null, welcomeVideoUrl: null, welcomeSentAt: null,
  questionnaireDueAt: null, questionnaireSubmittedAt: null, kickoffAt: null, lastClientActivityAt: null, closedAt: null, createdAt: "", updatedAt: "", ...over,
});
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const fridayCtx = { ...ctx, waiting: ["Logo files", "Homepage text"], received: ["Brand colors and fonts"], questionnaireDone: false };

const all = (c = ctx, f = fridayCtx) => [
  renderWelcome(onb({ welcomeVideoUrl: "https://video.test/hello" }), c, LINK, settings),
  renderWelcome(onb(), c, LINK, settings),
  renderWelcome(onb({ kind: "light" }), c, LINK, settings),
  ...([1, 2, 3, 4] as const).map((n) => renderReminder(n, c, LINK, settings)),
  renderFriday(f, LINK, settings),
  renderFriday({ ...f, waiting: [], received: [], questionnaireDone: true }, LINK, settings),
];

describe("welcome", () => {
  it("welcome includes the video link only when set", () => {
    const withVideo = renderWelcome(onb({ welcomeVideoUrl: "https://video.test/hello" }), ctx, LINK, settings);
    expect(withVideo.body).toContain("https://video.test/hello");
    const without = renderWelcome(onb(), ctx, LINK, settings);
    expect(without.body).not.toContain("video.test");
    expect(without.body.toLowerCase()).not.toContain("video");
  });

  it("asks for the questionnaire in 2 days and says never to send passwords", () => {
    const m = renderWelcome(onb(), ctx, LINK, settings);
    expect(m.body).toMatch(/2 days/);
    expect(m.body.toLowerCase()).toContain("never send");
    expect(m.body.toLowerCase()).toContain("password");
    expect(m.body).toContain("Hi Pat,");
    expect(m.body).toContain("Acme Roofing");
  });

  it("a light onboarding does not promise a list of files", () => {
    const m = renderWelcome(onb({ kind: "light" }), ctx, LINK, settings);
    expect(m.body.toLowerCase()).not.toContain("photos");
  });

  it("signs with the owner's name only when there is no saved signature", () => {
    expect(renderWelcome(onb(), ctx, LINK, settings).body.trimEnd().endsWith("Thanks,\nLogan")).toBe(true);
    const signed = renderWelcome(onb(), ctx, LINK, { ...settings, signature: "Logan Irish\nSiteline" });
    expect(signed.body.trimEnd().endsWith("Thanks,")).toBe(true);
  });
});

describe("every mail", () => {
  it("every mail contains the link exactly once and no markup", () => {
    for (const m of all()) {
      expect(count(m.body, LINK), m.subject).toBe(1);
      expect(m.body).not.toMatch(/[<>]/);
      expect(m.body).not.toMatch(/\*\*|__|\]\(|^#|`/m);
      expect(m.subject).not.toMatch(/[<>\r\n]/);
      expect(m.subject.length).toBeGreaterThan(5);
      expect(m.body.toLowerCase()).toContain("never send");
    }
  });

  it("client text is shown on one line and cleaned", () => {
    const evil = { ...ctx, clientName: "Acme\n\nRoofing‮ <b>Co</b>", contactName: "Pat\r\nBcc: x@y.test" };
    for (const m of all(evil, { ...fridayCtx, waiting: ["Logo\nfiles‮"] })) {
      expect(m.body).not.toContain("‮");
      expect(m.body).toContain("Hi Pat,");
      expect(m.body).not.toContain("Acme\n");
      expect(m.body).not.toContain("Bcc");
      expect(m.subject).not.toMatch(/\n/);
    }
  });

  it("client text containing a URL stays inert text", () => {
    const sneaky = { ...ctx, clientName: `Acme https://evil.test/login ${LINK}`, contactName: "https://evil.test/x" };
    for (const m of all(sneaky, { ...fridayCtx, waiting: [`https://evil.test/a ${LINK}`] })) {
      expect(count(m.body, LINK), m.subject).toBe(1);
      expect(m.subject).not.toContain("evil.test");
    }
    // It is still only text on the same line it was put on.
    const m = renderReminder(2, sneaky, LINK, settings);
    expect(m.body).toContain("Acme https://evil.test/login");
  });

  it("long client names are capped", () => {
    const m = renderReminder(1, { ...ctx, clientName: "A".repeat(500), contactName: "B".repeat(500) }, LINK, settings);
    expect(m.body).not.toContain("A".repeat(121));
    expect(m.body).not.toContain("B".repeat(61));
  });
});

describe("reminders", () => {
  it("get firmer with the level and each says something different", () => {
    const bodies = ([1, 2, 3, 4] as const).map((n) => renderReminder(n, ctx, LINK, settings).body);
    expect(new Set(bodies).size).toBe(4);
    expect(new Set(([1, 2, 3, 4] as const).map((n) => renderReminder(n, ctx, LINK, settings).subject)).size).toBe(4);
  });

  it("level 3 names a date 14 days after last activity", () => {
    const m = renderReminder(3, ctx, LINK, settings);
    expect(m.body).toContain("November 16, 2026");
    expect(m.body.toLowerCase()).toContain("back of the queue");
    expect(renderReminder(2, ctx, LINK, settings).body).not.toContain("November 16, 2026");
  });

  it("level 3 dates in the given zone", () => {
    // 2026-11-02T03:00Z is still Nov 1 in Los Angeles, so 14 days on is Nov 15 there.
    const m = renderReminder(3, { ...ctx, lastClientActivityAt: "2026-11-02T03:00:00.000Z", tz: "America/Los_Angeles" }, LINK, settings);
    expect(m.body).toContain("November 15, 2026");
  });

  it("level 3 without a known last activity still reads and names no date", () => {
    const m = renderReminder(3, { ...ctx, lastClientActivityAt: null }, LINK, settings);
    expect(m.body).not.toMatch(/20\d\d/);
    expect(m.body.toLowerCase()).toContain("back of the queue");
  });

  it("level 4 says what the 14-day clause means in plain words", () => {
    const m = renderReminder(4, ctx, LINK, settings).body;
    expect(m).toContain("14 days");
    expect(m.toLowerCase()).toContain("back of the queue");
    expect(m.toLowerCase()).toContain("free slot");
  });
});

describe("friday", () => {
  it("lists what is waiting and what came in, and the questionnaire", () => {
    const m = renderFriday(fridayCtx, LINK, settings).body;
    expect(m).toContain("Logo files");
    expect(m).toContain("Homepage text");
    expect(m).toContain("Brand colors and fonts");
    expect(m.toLowerCase()).toContain("questionnaire");
  });

  it("when the questionnaire is done it does not ask for it", () => {
    const m = renderFriday({ ...fridayCtx, questionnaireDone: true }, LINK, settings).body;
    expect(m.toLowerCase()).not.toMatch(/questionnaire.*(still|not yet)/);
  });

  it("long lists are cut with a count", () => {
    const waiting = Array.from({ length: 40 }, (_, i) => `Item ${i}`);
    const m = renderFriday({ ...fridayCtx, waiting }, LINK, settings).body;
    expect(m).toContain("Item 0");
    expect(m).not.toContain("Item 39");
    expect(m).toMatch(/and \d+ more/);
  });
});
