import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/worker/documents/hash";

describe("content hash", () => {
  it("key order does not change the hash", async () => {
    const a = { name: "Ace", list: [{ x: 1, y: 2 }, 3], n: null };
    const b = { n: null, list: [{ y: 2, x: 1 }, 3], name: "Ace" };
    expect(await sha256Hex(canonicalJson(a))).toBe(await sha256Hex(canonicalJson(b)));
  });

  it("one changed character changes the hash", async () => {
    const h1 = await sha256Hex(canonicalJson({ scopeNotes: "Five pages" }));
    const h2 = await sha256Hex(canonicalJson({ scopeNotes: "Five pagez" }));
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonicalJson sorts nested keys", () => {
    expect(canonicalJson({ b: { d: 1, c: [{ z: 1, a: 2 }] }, a: "x" })).toBe('{"a":"x","b":{"c":[{"a":2,"z":1}],"d":1}}');
  });

  it("sha256Hex matches a known digest", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
