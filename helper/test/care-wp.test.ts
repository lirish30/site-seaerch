import { describe, expect, it, vi } from "vitest";
import { WP_ARG, WpError, quoteRemote, remote, wp, wpText } from "../src/care/wp.ts";
import type { Exec } from "../src/exec.ts";

const T = { alias: "client1", path: "/var/www/html" };
const fake = (stdout: string) => vi.fn<Exec>(async () => ({ stdout }));

/** The same accept/refuse table as test/care-inventory-kind.test.ts on the Worker side. */
export const ALIAS_ONLY = ["-oProxyCommand=x"];
export const HOSTILE = ["x; rm -rf ~", "$(id)", "`id`", "a b", "a\nb", "../etc", "/var/../etc"];

describe("the patterns", () => {
  it("accept the shapes a real site has", () => {
    expect(WP_ARG.alias.test("client1")).toBe(true);
    expect(WP_ARG.alias.test("ace-host.example_1")).toBe(true);
    expect(WP_ARG.path.test("/var/www/html")).toBe(true);
    expect(WP_ARG.slug.test("akismet")).toBe(true);
    expect(WP_ARG.slug.test("Divi")).toBe(true);
    expect(WP_ARG.slug.test("wp-super-cache")).toBe(true);
    expect(WP_ARG.version.test("5.1.2")).toBe(true);
    expect(WP_ARG.version.test("6.4.2-beta1+3")).toBe(true);
    expect(WP_ARG.checkPath.test("/shop/?a")).toBe(false);
    expect(WP_ARG.checkPath.test("//evil.com")).toBe(false);
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

describe("wp, an alias that starts with a dash", () => {
  it.each(ALIAS_ONLY)("refuses %j as the alias and never spawns", async (bad) => {
    const exec = fake("[]");
    expect(WP_ARG.alias.test(bad)).toBe(false);
    await expect(wp(exec, { alias: bad, path: T.path }, ["plugin", "list"], { timeoutMs: 1000 })).rejects.toThrow(WpError);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("wpText", () => {
  it("returns the last non-empty line, trimmed, with the same argv as wp", async () => {
    const exec = fake("Notice: x\n6.4.1\n\n");
    expect(await wpText(exec, T, ["core", "version"], { timeoutMs: 5 })).toBe("6.4.1");
    expect(exec).toHaveBeenCalledWith("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "client1", "--", "wp", "--path='/var/www/html'", "'core'", "'version'"], { timeoutMs: 5 });
  });
  it("throws on empty output and on hostile input without spawning", async () => {
    await expect(wpText(fake(" \n"), T, ["core", "version"], { timeoutMs: 5 })).rejects.toThrow("wp-cli gave no readable answer");
    const exec = fake("6.4.1");
    await expect(wpText(exec, { alias: "a b", path: T.path }, ["core", "version"], { timeoutMs: 5 })).rejects.toThrow(WpError);
    await expect(wpText(exec, T, ["core", "$(id)"], { timeoutMs: 5 })).rejects.toThrow(WpError);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("quoteRemote", () => {
  it("single-quotes and escapes a single quote", () => {
    expect(quoteRemote("it's")).toBe("'it'\\''s'");
    expect(quoteRemote("plain")).toBe("'plain'");
  });
});

describe("remote", () => {
  it("runs one of the four commands over ssh with each word quoted and the same options as wp", async () => {
    const exec = fake("");
    await remote(exec, "client1", ["find", "siteline-backups", "-name", "*.sql.gz", "-mtime", "+28", "-delete"], { timeoutMs: 7 });
    expect(exec).toHaveBeenCalledWith("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "client1", "--", "find", "'siteline-backups'", "'-name'", "'*.sql.gz'", "'-mtime'", "'+28'", "'-delete'"], { timeoutMs: 7 });
  });
  it("allows mkdir, test and gzip", async () => {
    const exec = fake("ok");
    expect(await remote(exec, "client1", ["mkdir", "-p", "siteline-backups"], { timeoutMs: 1 })).toBe("ok");
    expect(await remote(exec, "client1", ["mkdir", "-m", "700", "-p", "siteline-backups"], { timeoutMs: 1 })).toBe("ok"); // M4: the private backup folder passes the word check
    await remote(exec, "client1", ["test", "-e", "siteline-backups/a.com-x.sql.gz"], { timeoutMs: 1 });
    await remote(exec, "client1", ["gzip", "-f", "siteline-backups/a.com-x.sql"], { timeoutMs: 1 });
    expect(exec).toHaveBeenCalledTimes(4);
  });
  it("refuses any other command, a bad alias, a hostile word, an absolute path or a tilde, and never spawns", async () => {
    const exec = fake("");
    const o = { timeoutMs: 1 };
    await expect(remote(exec, "client1", ["rm", "-rf", "x"], o)).rejects.toThrow(WpError);
    await expect(remote(exec, "client1", ["sh", "-c", "id"], o)).rejects.toThrow(WpError);
    await expect(remote(exec, "client1", [], o)).rejects.toThrow(WpError);
    await expect(remote(exec, "-oProxyCommand=x", ["test", "-e", "a"], o)).rejects.toThrow(WpError);
    for (const bad of ["x; id", "$(id)", "`id`", "a b", "a\nb", "../x", "~/x", "/etc/passwd", "a'b"]) await expect(remote(exec, "client1", ["gzip", "-f", bad], o)).rejects.toThrow(WpError);
    expect(exec).not.toHaveBeenCalled();
  });
  it("turns a failed run into a WpError", async () => {
    const exec: Exec = async () => { throw new Error("exit 1"); };
    await expect(remote(exec, "client1", ["test", "-e", "a"], { timeoutMs: 1 })).rejects.toThrow(WpError);
  });
});
