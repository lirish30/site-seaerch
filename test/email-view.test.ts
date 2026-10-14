import { describe, it, expect } from "vitest";
import { emptySignature, gapsMessage, isBlankSignature, mailtoHref, profileGaps, readSignature, snippet, variantTitle, wordCount, writeSignature } from "../src/client/emailView";

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

describe("profileGaps", () => {
  const full = { role_title: "Dev", bio: "Bio", goal_line: "Full-time" };
  it("lists what a full-time email still lacks", () => {
    expect(profileGaps("full_time", {}, 0)).toEqual(["your role", "a short bio", "what you're looking for", "at least one work sample"]);
    expect(profileGaps("full_time", full, 0)).toEqual(["at least one work sample"]);
    expect(profileGaps("full_time", full, 2)).toEqual([]);
  });
  it("asks nothing of a freelance email", () => {
    expect(profileGaps("freelance", {}, 0)).toEqual([]);
  });
  it("reads as a sentence", () => {
    expect(gapsMessage([])).toBe("");
    expect(gapsMessage(["your role"])).toBe("Add your role in Settings so the email can talk about real work.");
    expect(gapsMessage(["your role", "a short bio", "a work sample"])).toBe("Add your role, a short bio and a work sample in Settings so the email can talk about real work.");
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
