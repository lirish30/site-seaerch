import { describe, expect, it } from "vitest";

// Claude work runs on the user's Claude Code subscription through the task queue (/work-the-queue), never a paid API.
// This reads every source file in src, plus the files that could bring the API back through config (package.json, wrangler.jsonc, .dev.vars.example and
// README.md), as raw text, and fails if any of them names the vendor at all: the SDK, the key, the API host, or a stray mention.
// package-lock.json is left out on purpose: it is generated. The needle is built in pieces so this file never contains it, and a scan of test/ stays clean.
const files = import.meta.glob(
  ["../src/**/*.{ts,tsx}", "../package.json", "../wrangler.jsonc", "../.dev.vars.example", "../README.md"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const needle = new RegExp(["anthro", "pic"].join(""), "i");

describe("nothing in the app or its config references the Anthropic API", () => {
  it("scans the real source tree and every config file", () => {
    const names = Object.keys(files);
    expect(names.length).toBeGreaterThan(100);
    expect(names.some((k) => k.endsWith("/worker/env.ts"))).toBe(true);
    for (const f of ["package.json", "wrangler.jsonc", ".dev.vars.example", "README.md"]) expect(names.some((k) => k.endsWith(`/${f}`)), f).toBe(true);
    expect(names.some((k) => k.endsWith("package-lock.json"))).toBe(false);
  });

  it("finds no mention of the vendor, in any case", () => {
    const hits = Object.entries(files).filter(([, text]) => needle.test(text)).map(([file]) => file);
    expect(hits).toEqual([]);
  });
});
