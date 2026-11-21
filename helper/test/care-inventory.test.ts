import { describe, expect, it } from "vitest";
import type { ClaimedJob } from "../src/api.ts";
import { careInventoryHandler } from "../src/handlers/careInventory.ts";
import type { Exec } from "../src/exec.ts";
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
  { name: "Divi", title: "Divi", status: "active", version: "1.0", update_version: "1.1", update_package: "https://downloads.wordpress.org/theme/t.zip" },
  { name: "old", title: "Old", status: "inactive", version: "1.0", update_version: "", update_package: "" },
];
const UP_TO_DATE = "Success: WordPress is at the latest version.\n";

/** A fake ssh that prints what real wp-cli prints: stdout text only, keyed by the remote command (without its quotes). */
function fakeExec(over: Record<string, string | Error> = {}) {
  const calls: string[] = [];
  const out: Record<string, string | Error> = {
    "core version": "Notice: banner\n6.4.1\n",
    "cli info --format=json": `Deprecated: x\n${JSON.stringify({ php_version: "8.2.1" })}\n`,
    "core check-update --format=json": JSON.stringify([{ version: "6.5", update_type: "major", package_url: "https://downloads.wordpress.org/release/wordpress-6.5.zip" }]) + "\n",
    "plugin list --fields=name,title,status,version,update_version,update_package --format=json": JSON.stringify(plugins) + "\n",
    "theme list --fields=name,title,status,version,update_version,update_package --format=json": JSON.stringify(themes) + "\n",
    ...over,
  };
  const exec: Exec = async (file, args, opts) => {
    expect(file).toBe("ssh");
    expect(opts?.timeoutMs).toBe(120_000);
    const cmd = args.slice(args.indexOf("wp") + 2).map((w) => w.replace(/^'|'$/g, "")).join(" ");
    calls.push(cmd);
    const a = out[cmd];
    if (a === undefined) throw new Error(`unexpected command: ${cmd}`);
    if (a instanceof Error) throw a;
    return { stdout: a };
  };
  return { exec, calls };
}
const run = (e: Exec, payload: unknown = GOOD) => careInventoryHandler(e).run(ctx(payload)) as Promise<any>;

describe("care.inventory handler", () => {
  it("runs the five read-only commands and returns the result shape", async () => {
    const { exec, calls } = fakeExec();
    const r = await run(exec);
    expect(calls).toEqual([
      "core version",
      "cli info --format=json",
      "core check-update --format=json",
      "plugin list --fields=name,title,status,version,update_version,update_package --format=json",
      "theme list --fields=name,title,status,version,update_version,update_package --format=json",
    ]);
    expect(r.wpVersion).toBe("6.4.1");
    expect(r.phpVersion).toBe("8.2.1");
    expect(r.core).toEqual({ to: "6.5" });
    expect(r.activeTheme).toBe("Divi");
    expect(r.plugins).toEqual([
      { slug: "akismet", name: "Akismet Anti-spam", status: "active", version: "5.0", updateVersion: "5.1", fromWporg: true },
      { slug: "pro-thing", name: "Pro Thing", status: "active", version: "1.0", updateVersion: "1.1", fromWporg: false },
      { slug: "hello", name: "Hello", status: "inactive", version: "1.7", updateVersion: null, fromWporg: false },
    ]);
    expect(r.themes.map((t: any) => [t.slug, t.updateVersion, t.fromWporg])).toEqual([["Divi", "1.1", true], ["old", null, false]]);
    expect(r.dropped).toBe(1);
  });

  it("counts rows cut by the caps as dropped", async () => {
    const many = Array.from({ length: 305 }, (_, i) => ({ name: `p${i}`, title: "P", status: "inactive", version: "1", update_version: "", update_package: "" }));
    const r = await run(fakeExec({ "plugin list --fields=name,title,status,version,update_version,update_package --format=json": JSON.stringify(many) }).exec);
    expect(r.plugins).toHaveLength(300);
    expect(r.dropped).toBe(5 + 0);
  });

  it("marks an update package that merely contains downloads.wordpress.org as not from wordpress.org", async () => {
    const tricky = [{ name: "a", title: "A", status: "active", version: "1", update_version: "2", update_package: "https://downloads.wordpress.org.evil.com/a.zip" }];
    const r = await run(fakeExec({ "plugin list --fields=name,title,status,version,update_version,update_package --format=json": JSON.stringify(tricky) }).exec);
    expect(r.plugins[0].fromWporg).toBe(false);
  });

  describe("core check-update", () => {
    const key = "core check-update --format=json";
    it("is no update only for wp-cli's own up-to-date sentence", async () => {
      expect((await run(fakeExec({ [key]: UP_TO_DATE }).exec)).core).toBeNull();
      expect((await run(fakeExec({ [key]: `Notice: x\n${UP_TO_DATE}` }).exec)).core).toBeNull();
      expect((await run(fakeExec({ [key]: "[]\n" }).exec)).core).toBeNull();
    });
    it("throws on empty output, HTML or a PHP fatal", async () => {
      for (const bad of ["", "<html>", "PHP Fatal error: x\n"]) await expect(run(fakeExec({ [key]: bad }).exec)).rejects.toThrow("wp-cli gave no readable answer");
    });
    it("throws when the command fails", async () => {
      await expect(run(fakeExec({ [key]: new Error("ssh: connect refused") }).exec)).rejects.toThrow("connect refused");
    });
  });

  it("reads wp core version as plain text and refuses an answer that is not a version", async () => {
    expect((await run(fakeExec({ "core version": "6.4.1\n" }).exec)).wpVersion).toBe("6.4.1");
    await expect(run(fakeExec({ "core version": "<html>\n" }).exec)).rejects.toThrow();
    await expect(run(fakeExec({ "core version": "" }).exec)).rejects.toThrow("wp-cli gave no readable answer");
  });

  it("fails the job when another command gives no readable answer", async () => {
    await expect(run(fakeExec({ "plugin list --fields=name,title,status,version,update_version,update_package --format=json": "" }).exec)).rejects.toThrow("wp-cli gave no readable answer");
  });

  it("refuses a payload with a hostile alias or path before running anything", async () => {
    const { exec, calls } = fakeExec();
    await expect(run(exec, { ...GOOD, alias: "x; rm -rf ~" })).rejects.toThrow();
    await expect(run(exec, { ...GOOD, alias: "-oProxyCommand=x" })).rejects.toThrow();
    await expect(run(exec, { ...GOOD, path: "/var/../etc" })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("never runs eval, shell or db query", async () => {
    const { exec, calls } = fakeExec();
    await run(exec);
    for (const c of calls) expect(["eval", "shell", "db"]).not.toContain(c.split(" ")[0]);
  });
});
