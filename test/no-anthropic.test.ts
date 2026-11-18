import { describe, expect, it } from "vitest";

// Claude work runs on the user's Claude Code subscription through the task queue (/work-the-queue), never a paid API.
// This reads every source file in src as raw text and fails if one brings the SDK, the key or the API host back.
// The needles are built in pieces so this file never contains them itself.
const sources = import.meta.glob("../src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const needles = [["@anthropic-ai", "/sdk"], ["ANTHROPIC", "_API_KEY"], ["api.anthropic", ".com"]].map((p) => p.join(""));

describe("no source file references the Anthropic API", () => {
  it("scans the real source tree", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(Object.keys(sources).some((k) => k.endsWith("/worker/env.ts"))).toBe(true);
  });

  it("finds none of the SDK, the key or the API host", () => {
    const hits = Object.entries(sources).flatMap(([file, text]) => needles.filter((n) => text.includes(n)).map((n) => `${file}: ${n}`));
    expect(hits).toEqual([]);
  });
});
