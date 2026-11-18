import { describe, it, expect } from "vitest";
import { draftStateLine, emptySignature, isBlankSignature, mailtoHref, readSignature, snippet, variantTitle, wordCount, writeSignature } from "../src/client/emailView";

describe("signature editing", () => {
  it("reads nothing, junk and partial data as a usable empty or partial signature", () => {
    for (const v of [undefined, null, "", "  ", "{bad", "null", "[]", 5]) expect(readSignature(v), String(v)).toEqual(emptySignature());
    expect(readSignature(JSON.stringify({ name: "L", image_width: "abc", links: [{ label: 1, url: "https://x.com" }] })))
      .toMatchObject({ name: "L", image_width: 96, links: [{ label: "", url: "https://x.com" }] });
  });
  it("clamps the width and caps the links", () => {
    expect(readSignature(JSON.stringify({ image_width: 5 })).image_width).toBe(40);
    expect(readSignature(JSON.stringify({ image_width: 5000 })).image_width).toBe(300);
    expect(readSignature(JSON.stringify({ links: Array.from({ length: 20 }, () => ({ label: "a", url: "https://x.com" })) })).links).toHaveLength(8);
  });
  it("writes an empty signature as an empty string, so the plain-text one is used", () => {
    expect(writeSignature(emptySignature())).toBe("");
    expect(writeSignature({ ...emptySignature(), links: [{ label: " ", url: " " }] })).toBe("");
    expect(isBlankSignature({ ...emptySignature(), name: "Logan" })).toBe(false);
  });
  it("keeps a half-filled link row while the sender is typing it", () => {
    const json = writeSignature({ ...emptySignature(), name: "L", links: [{ label: "GitHub", url: "" }] });
    expect(readSignature(json).links).toEqual([{ label: "GitHub", url: "" }]);
  });
});

describe("small helpers", () => {
  it("counts words and trims snippets", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount(" a  b\nc ")).toBe(3);
    expect(snippet("a   b\n c", 50)).toBe("a b c");
    expect(snippet("x".repeat(30), 10)).toBe("xxxxxxxxxx…");
  });
  it("names variants by angle, else by position", () => {
    expect(variantTitle({ angle: " Work-led " }, 1)).toBe("Work-led");
    expect(variantTitle({ angle: "" }, 2)).toBe("Option 3");
  });
  it("encodes a mailto link", () => {
    expect(mailtoHref("a@b.com", "Hi & bye", "Line 1\nLine 2")).toBe("mailto:a@b.com?subject=Hi%20%26%20bye&body=Line%201%0ALine%202");
  });
});

describe("draftStateLine", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  it("says what the queued draft is waiting for", () => {
    expect(draftStateLine({ state: "queued", since: "2026-11-18T11:00:00Z" }, now)).toBe("Waiting for Claude. It will be written in your next queue session.");
    expect(draftStateLine({ state: "claimed", since: "2026-11-18T11:59:00Z" }, now)).toBe("Claude is writing this now.");
  });
  it("is empty when nothing is queued, and for a state it does not know", () => {
    expect(draftStateLine({ state: "idle", since: null }, now)).toBe("");
    expect(draftStateLine({ state: "weird", since: null }, now)).toBe("");
  });
});
