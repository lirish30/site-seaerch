import { describe, expect, it } from "vitest";
import type { ClaimedJob } from "../src/api.ts";
import { WpError } from "../src/care/wp.ts";
import { careInventoryHandler } from "../src/handlers/careInventory.ts";
import type { JobContext } from "../src/loop.ts";

const job = (payload: unknown): ClaimedJob => ({ id: "j1", kind: "care.inventory", attempts: 1, payload, inputs: [], outputs: [] });
const ctx = (payload: unknown): JobContext => ({ job: job(payload), api: {} as never, cfg: {} as never, workDir: "/nope" });
const GOOD = { siteId: "s1", batchId: "b1", alias: "client1", path: "/var/www/html" };

const plugins = [
  { name: "akismet", title: "Akismet Anti-spam", status: "active", version: "5.0", update_version: "5.1", update_package: "https://downloads.wordpress.org/plugin/akismet.5.1.zip" },
  { name: "pro-thing", title: "Pro Thing", status: "active", version: "1.0", update_version: "1.1", update_package: "https://example.com/pro.zip" },
  { name: "hello", title: "Hello", status: "inactive", version: "1.7", update_version: "", update_package: "" },
  { name: "bad slug; id", title: "Evil", status: "active", version: "1.0", update_version: "1.1", update_package: "https://downloads.wordpress.org/x.zip" },
];
const themes = [
  { name: "twentytwentyfour", title: "Twenty Twenty-Four", status: "active", version: "1.0", update_version: "1.1", update_package: "https://downloads.wordpress.org/theme/t.zip" },
  { name: "old", title: "Old", status: "inactive", version: "1.0", update_version: "", update_package: "" },
];

function fakeWp(over: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const answers: Record<string, unknown> = {
    "core version": "6.4.1",
    "cli info": { php_version: "8.2.1" },
    "core check-update": [{ version: "6.5", update_type: "major", package_url: "https://downloads.wordpress.org/release/wordpress-6.5.zip" }],
    "plugin list": plugins,
    "theme list": themes,
    ...over,
  };
  const run = async (_t: { alias: string; path: string }, args: string[], o: { timeoutMs: number }) => {
    calls.push(args);
    expect(o.timeoutMs).toBe(120_000);
    const a = answers[args.slice(0, 2).join(" ")];
    if (a instanceof Error) throw a;
    return a;
  };
  return { run, calls };
}

describe("care.inventory handler", () => {
  it("runs the five read-only commands and returns the result shape", async () => {
    const { run, calls } = fakeWp();
    const r = (await careInventoryHandler(run).run(ctx(GOOD))) as any;
    expect(calls.map((c) => c.join(" "))).toEqual([
      "core version --format=json",
      "cli info --format=json",
      "core check-update --format=json",
      "plugin list --fields=name,title,status,version,update_version,update_package --format=json",
      "theme list --fields=name,title,status,version,update_version,update_package --format=json",
    ]);
    expect(r.wpVersion).toBe("6.4.1");
    expect(r.phpVersion).toBe("8.2.1");
    expect(r.core).toEqual({ to: "6.5" });
    expect(r.activeTheme).toBe("twentytwentyfour");
    expect(r.plugins).toEqual([
      { slug: "akismet", name: "Akismet Anti-spam", status: "active", version: "5.0", updateVersion: "5.1", fromWporg: true },
      { slug: "pro-thing", name: "Pro Thing", status: "active", version: "1.0", updateVersion: "1.1", fromWporg: false },
      { slug: "hello", name: "Hello", status: "inactive", version: "1.7", updateVersion: null, fromWporg: false },
    ]);
    expect(r.themes.map((t: any) => [t.slug, t.updateVersion, t.fromWporg])).toEqual([["twentytwentyfour", "1.1", true], ["old", null, false]]);
  });

  it("marks an update package that is not on downloads.wordpress.org as not from wordpress.org, even when the host merely contains it", async () => {
    const tricky = [{ name: "a", title: "A", status: "active", version: "1", update_version: "2", update_package: "https://downloads.wordpress.org.evil.com/a.zip" }];
    const r = (await careInventoryHandler(fakeWp({ "plugin list": tricky }).run).run(ctx(GOOD))) as any;
    expect(r.plugins[0].fromWporg).toBe(false);
  });

  it("reads no core update as null (wp-cli prints a sentence, not JSON)", async () => {
    const r = (await careInventoryHandler(fakeWp({ "core check-update": new WpError("wp-cli gave no readable answer") }).run).run(ctx(GOOD))) as any;
    expect(r.core).toBeNull();
    const r2 = (await careInventoryHandler(fakeWp({ "core check-update": [] }).run).run(ctx(GOOD))) as any;
    expect(r2.core).toBeNull();
  });

  it("fails the job when another command gives no readable answer", async () => {
    const { run } = fakeWp({ "plugin list": new WpError("wp-cli gave no readable answer") });
    await expect(careInventoryHandler(run).run(ctx(GOOD))).rejects.toThrow("wp-cli gave no readable answer");
  });

  it("refuses a payload with a hostile alias or path before running anything", async () => {
    const { run, calls } = fakeWp();
    await expect(careInventoryHandler(run).run(ctx({ ...GOOD, alias: "x; rm -rf ~" }))).rejects.toThrow();
    await expect(careInventoryHandler(run).run(ctx({ ...GOOD, path: "/var/../etc" }))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("never runs eval, shell or db query", async () => {
    const { run, calls } = fakeWp();
    await careInventoryHandler(run).run(ctx(GOOD));
    for (const c of calls) expect(["eval", "shell", "db"]).not.toContain(c[0]);
  });
});
