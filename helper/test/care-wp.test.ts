import { describe, expect, it, vi } from "vitest";
import { WP_ARG, WpError, quoteRemote, wp } from "../src/care/wp.ts";
import type { Exec } from "../src/exec.ts";

const T = { alias: "client1", path: "/var/www/html" };
const fake = (stdout: string) => vi.fn<Exec>(async () => ({ stdout }));

/** The same accept/refuse table as test/care-inventory-kind.test.ts on the Worker side. */
export const HOSTILE = ["x; rm -rf ~", "$(id)", "`id`", "a b", "a\nb", "../etc", "/var/../etc"];

describe("the patterns", () => {
  it("accept the shapes a real site has", () => {
    expect(WP_ARG.alias.test("client1")).toBe(true);
    expect(WP_ARG.alias.test("ace-host.example_1")).toBe(true);
    expect(WP_ARG.path.test("/var/www/html")).toBe(true);
    expect(WP_ARG.slug.test("akismet")).toBe(true);
    expect(WP_ARG.slug.test("wp-super-cache")).toBe(true);
    expect(WP_ARG.version.test("5.1.2")).toBe(true);
    expect(WP_ARG.version.test("6.4.2-beta1+3")).toBe(true);
    expect(WP_ARG.checkPath.test("/shop/?a")).toBe(false);
    expect(WP_ARG.checkPath.test("/about-us/")).toBe(true);
    expect(WP_ARG.checkPath.test("/")).toBe(true);
  });
  it("refuse every hostile value", () => {
    for (const v of HOSTILE) for (const re of Object.values(WP_ARG)) expect(re.test(v), `${JSON.stringify(v)} vs ${re}`).toBe(false);
  });
});

describe("wp", () => {
  it("runs ssh with exactly this argv", async () => {
    const exec = fake('[{"name":"akismet"}]\n');
    await wp(exec, T, ["plugin", "list", "--format=json"], { timeoutMs: 120_000 });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "client1", "--", "wp", "--path='/var/www/html'", "'plugin'", "'list'", "'--format=json'"],
      { timeoutMs: 120_000 },
    );
  });

  it.each(HOSTILE)("refuses %j as the alias, the path or an argument and never spawns", async (bad) => {
    const exec = fake("[]");
    await expect(wp(exec, { alias: bad, path: T.path }, ["plugin", "list"], { timeoutMs: 1000 })).rejects.toThrow(WpError);
    await expect(wp(exec, { alias: T.alias, path: bad }, ["plugin", "list"], { timeoutMs: 1000 })).rejects.toThrow("this site's SSH settings are not valid");
    await expect(wp(exec, T, ["plugin", bad], { timeoutMs: 1000 })).rejects.toThrow(WpError);
    expect(exec).not.toHaveBeenCalled();
  });

  it("takes the last JSON line and ignores notices before it", async () => {
    const got = await wp(fake('Notice: x\nDeprecated: y\n[{"name":"akismet"}]\n'), T, ["plugin", "list"], { timeoutMs: 1000 });
    expect(got).toEqual([{ name: "akismet" }]);
  });

  it.each(["", "<html>", "Success: nothing\n"])("says wp-cli gave no readable answer for %j", async (out) => {
    await expect(wp(fake(out), T, ["plugin", "list"], { timeoutMs: 1000 })).rejects.toThrow("wp-cli gave no readable answer");
  });

  it("turns a failed run into a WpError with the message cut to 300 characters", async () => {
    const exec: Exec = async () => { throw new Error("x".repeat(1000)); };
    const e = (await wp(exec, T, ["plugin", "list"], { timeoutMs: 1000 }).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(WpError);
    expect(e.message).toHaveLength(300);
  });
});

describe("quoteRemote", () => {
  it("single-quotes and escapes a single quote", () => {
    expect(quoteRemote("it's")).toBe("'it'\\''s'");
    expect(quoteRemote("plain")).toBe("'plain'");
  });
});
