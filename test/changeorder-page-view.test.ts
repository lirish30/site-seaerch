import { describe, expect, it } from "vitest";
import { consentTextFor } from "../src/worker/documents/public";
import { CONSENT_LABEL, ESIGN_DISCLOSURE, authorityLabel } from "../src/worker/documents/consent";
import { canSign, closedMessage, declineError, priceLine, scheduleLine, signError, splitConsent } from "../src/client/changeOrderPageView";

describe("priceLine", () => {
  it("priceLine at 1.5 hours and 9500 cents", () => {
    expect(priceLine(1.5, 9500, 14250)).toBe("1.5 hours × $95 an hour = $142.50");
  });

  it("says 1 hour in the singular, keeps quarter hours and shows whole dollars without cents", () => {
    expect(priceLine(1, 12500, 12500)).toBe("1 hour × $125 an hour = $125");
    expect(priceLine(0.25, 9999, 2500)).toBe("0.25 hours × $99.99 an hour = $25");
    expect(priceLine(2, 12500, 25000)).toBe("2 hours × $125 an hour = $250");
  });

  it("shows the stored price, not a recomputed one, and drops the equation when the price was set by hand (M3)", () => {
    expect(priceLine(3, 12500, 20000)).toBe("3 hours, $200 in total");
    expect(priceLine(1, 12500, 9000)).toBe("1 hour, $90 in total");
    // a price that is hours times rate, rounded to the cent, keeps the sum
    expect(priceLine(0.25, 9999, 2500)).toBe("0.25 hours × $99.99 an hour = $25");
    expect(priceLine(3, 12500, 37500)).toBe("3 hours × $125 an hour = $375");
  });
});

describe("canSign", () => {
  const ok = { name: "Pat Jones", consent: true, authority: true };

  it("canSign lists what is missing", () => {
    const none = canSign({ name: "", consent: false, authority: false });
    expect(none.ok).toBe(false);
    expect(none.missing).toHaveLength(3);
    expect(none.missing[0]).toMatch(/agree to sign electronically/i);
    expect(none.missing[1]).toMatch(/sign for the business/i);
    expect(none.missing[2]).toMatch(/full name/i);
    expect(canSign({ ...ok, consent: false }).missing).toEqual([expect.stringMatching(/electronically/i)]);
    expect(canSign({ ...ok, authority: false }).missing).toEqual([expect.stringMatching(/for the business/i)]);
    expect(canSign({ ...ok, name: "A" }).missing).toEqual([expect.stringMatching(/full name/i)]);
    expect(canSign({ ...ok, name: "Pat‮Jones" }).missing).toEqual([expect.stringMatching(/hidden/i)]);
  });

  it("is ok with nothing missing once everything is there, and judges the name after trimming", () => {
    expect(canSign(ok)).toEqual({ ok: true, missing: [] });
    expect(canSign({ ...ok, name: "  Jo  " })).toEqual({ ok: true, missing: [] });
    expect(canSign({ ...ok, name: "   " }).ok).toBe(false);
  });
});

describe("closedMessage", () => {
  it("closedMessage covers every reason", () => {
    const reasons = ["void", "expired", "declined", null] as const;
    const texts = reasons.map((r) => closedMessage(r));
    for (const t of texts) expect(t.length).toBeGreaterThan(20);
    expect(new Set(texts).size).toBe(4); // each reason says its own thing
    expect(closedMessage("expired")).toMatch(/expired/i);
    expect(closedMessage("declined")).toMatch(/no thanks|said no/i);
    expect(closedMessage("declined")).toMatch(/nothing/i);
    expect(closedMessage("void")).toMatch(/withdrawn|cancel/i);
  });
});

describe("scheduleLine", () => {
  it("says what the change does to the schedule", () => {
    expect(scheduleLine(null)).toMatch(/no change/i);
    expect(scheduleLine(0)).toMatch(/no change/i);
    expect(scheduleLine(1)).toBe("Adds 1 day to the schedule.");
    expect(scheduleLine(3)).toBe("Adds 3 days to the schedule.");
  });
});

describe("signError and declineError", () => {
  it("show our own words for each status and never the server's", () => {
    for (const status of [0, 400, 404, 409, 413, 429, 500]) {
      expect(signError(status).length).toBeGreaterThan(10);
      expect(declineError(status).length).toBeGreaterThan(10);
    }
    expect(signError(409)).toMatch(/changed|no longer open/i);
    expect(signError(404)).toMatch(/no longer available/i);
    expect(signError(429)).toMatch(/too many/i);
    expect(declineError(409)).toMatch(/no longer open/i);
  });
});

describe("splitConsent", () => {
  it("splits the stored consent text into the disclosure and the two labels", () => {
    const text = consentTextFor("Ace Plumbing");
    const r = splitConsent(text);
    expect(r.consentLabel).toBe(CONSENT_LABEL);
    expect(r.authorityLabel).toBe(authorityLabel("Ace Plumbing"));
    expect(r.disclosure.join("\n\n")).toBe(ESIGN_DISCLOSURE);
  });

  it("a client name with a blank line in it stays inside the authority label", () => {
    const name = "Ace\n\nPlumbing & Heating";
    const r = splitConsent(consentTextFor(name));
    expect(r.consentLabel).toBe(CONSENT_LABEL);
    expect(r.authorityLabel).toBe(authorityLabel(name));
    expect(r.disclosure.join("\n\n")).toBe(ESIGN_DISCLOSURE);
  });

  it("a text that does not start with the known disclosure and consent label is shown whole with plain labels", () => {
    const r = splitConsent(`${ESIGN_DISCLOSURE}\n\nA different consent label\n\n${authorityLabel("X")}`);
    expect(r.consentLabel).toMatch(/electronic/i);
    expect(r.authorityLabel).toMatch(/authorized/i);
    expect(r.disclosure.length).toBeGreaterThan(5);
  });

  it("a text too short to hold both labels is all disclosure, with plain labels", () => {
    const r = splitConsent("Only one paragraph.");
    expect(r.disclosure).toEqual(["Only one paragraph."]);
    expect(r.consentLabel).toMatch(/electronic/i);
    expect(r.authorityLabel).toMatch(/authorized/i);
    expect(splitConsent("").disclosure).toEqual([]);
  });
});
