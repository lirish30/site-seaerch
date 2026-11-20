import { describe, expect, it } from "vitest";
import { careRateHint, hoursText, linesOf, parseDaysInput, parseHoursInput, pricePreview, signedRecord, statusLabel, statusTone, voidable } from "../src/client/changeOrderView";

describe("statusLabel", () => {
  it("statusLabel for signed unpaid and signed paid", () => {
    expect(statusLabel("signed", false)).toBe("Signed, waiting for payment");
    expect(statusLabel("signed", true)).toBe("Signed and paid, work unlocked");
  });
  it("names the other states", () => {
    expect((["draft", "sent", "viewed", "declined", "expired", "void"] as const).map((s) => statusLabel(s, false)))
      .toEqual(["Draft", "Waiting for client", "Viewed", "Declined", "Expired", "Void"]);
  });
  it("tones: unpaid signed warns, paid is good, finished-with ones are muted", () => {
    expect(statusTone("signed", false)).toBe("warn");
    expect(statusTone("signed", true)).toBe("good");
    expect(statusTone("draft", false)).toBe("neutral");
    expect(statusTone("sent", false)).toBe("neutral");
    expect((["declined", "expired", "void"] as const).map((s) => statusTone(s, false))).toEqual(["muted", "muted", "muted"]);
  });
});

describe("pricePreview", () => {
  it("is hours times rate in whole cents", () => {
    expect(pricePreview(2.5, 9500, null)).toEqual({ priceCents: 23750, custom: false, line: "2.5 hours at $95 an hour is $237.50" });
    expect(pricePreview(1, 9500, null).line).toBe("1 hour at $95 an hour is $95");
  });
  it("pricePreview marks a custom price", () => {
    expect(pricePreview(2, 9500, 15000)).toEqual({ priceCents: 15000, custom: true, line: "2 hours at $95 an hour would be $190; your price is $150 (custom)" });
  });
  it("an override equal to the computed price is not custom", () => expect(pricePreview(2, 9500, 19000).custom).toBe(false));
  it("rounds half a cent up", () => expect(pricePreview(0.25, 9995, null).priceCents).toBe(2499));
});

describe("careRateHint", () => {
  it("careRateHint is null without a care rate", () => expect(careRateHint(null, 12000)).toBeNull());
  it("names the Care rate against the standard rate", () => expect(careRateHint(9500, 12000)).toBe("Care clients pay $95 an hour (the standard rate is $120)."));
  it("is null when both rates are the same", () => expect(careRateHint(12000, 12000)).toBeNull());
});

describe("small helpers", () => {
  it("hoursText", () => { expect(hoursText(1)).toBe("1 hour"); expect(hoursText(0.25)).toBe("0.25 hours"); expect(hoursText(3)).toBe("3 hours"); });
  it("a signed order cannot be voided, the rest can", () => {
    expect((["draft", "sent", "viewed", "declined", "expired"] as const).every(voidable)).toBe(true);
    expect(voidable("signed")).toBe(false);
    expect(voidable("void")).toBe(false);
  });
  it("signedRecord is the name, the time and the first characters of the hash", () => {
    const r = signedRecord({ signerName: "Ada Lovelace", signedAt: "2026-11-02T18:30:00.000Z", contentSha256: "abcdef0123456789abcdef" });
    expect(r).toMatchObject({ name: "Ada Lovelace", hashPrefix: "abcdef012345" });
    expect(r?.signedAt).toBe("2026-11-02T18:30:00.000Z");
    expect(signedRecord({ signerName: null, signedAt: null, contentSha256: null })).toBeNull();
  });
});

describe("form inputs", () => {
  it("parseHoursInput takes quarter hours from a quarter to 200", () => {
    expect(parseHoursInput("2")).toBe(2);
    expect(parseHoursInput(" 1.25 ")).toBe(1.25);
    expect(parseHoursInput("0.25")).toBe(0.25);
    expect(["", "0", "0.1", "1.3", "200.25", "-1", "abc", "1,5"].map(parseHoursInput)).toEqual([null, null, null, null, null, null, null, null]);
  });
  it("parseDaysInput is blank for none, else whole days from 0 to 180", () => {
    expect(parseDaysInput("")).toBeNull();
    expect(parseDaysInput(" 5 ")).toBe(5);
    expect(parseDaysInput("0")).toBe(0);
    expect(["181", "1.5", "-2", "x"].map(parseDaysInput)).toEqual([undefined, undefined, undefined, undefined]);
  });
  it("linesOf is one item per line, trimmed, blanks dropped", () => {
    expect(linesOf("  a \n\n b\r\n   \nc")).toEqual(["a", "b", "c"]);
    expect(linesOf("")).toEqual([]);
  });
});
