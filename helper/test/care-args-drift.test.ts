import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WP_ARG } from "../src/care/wp.ts";

/**
 * M7. The helper keeps its own copy of the five remote-value patterns (it has no dependency on the Worker). This reads src/worker/care/args.ts as text,
 * since the helper's toolchain cannot import Worker code, and checks every pattern's `.source` is the same on both sides.
 */
describe("the helper's WP_ARG matches the Worker's args.ts", () => {
  it("has the same five patterns, source for source", () => {
    const text = readFileSync(new URL("../../src/worker/care/args.ts", import.meta.url), "utf8");
    const block = /export const WP_ARG = \{([\s\S]*?)\} as const;/.exec(text)?.[1];
    expect(block, "WP_ARG block in args.ts").toBeTruthy();
    const worker: Record<string, string> = {};
    for (const m of block!.matchAll(/^\s*(\w+):\s*\/(.+)\/([a-z]*),\s*$/gm)) worker[m[1]] = new RegExp(m[2], m[3]).source;
    expect(Object.keys(worker).sort()).toEqual(["alias", "checkPath", "path", "slug", "version"]);
    expect(Object.keys(WP_ARG).sort()).toEqual(Object.keys(worker).sort());
    for (const [k, re] of Object.entries(WP_ARG)) expect(re.source, k).toBe(worker[k]);
  });
});
