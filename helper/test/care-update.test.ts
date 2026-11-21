import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, type ClaimedJob, type JobApi } from "../src/api.ts";
import { careUpdateHandler } from "../src/handlers/careUpdate.ts";
import type { Exec } from "../src/exec.ts";
import type { JobContext } from "../src/loop.ts";

const RUN = "123e4567-e89b-12d3-a456-426614174000";
const BASE = `siteline-backups/acme.com-${RUN}.sql`;
const GZ = `${BASE}.gz`;
const upd = (slug: string, from: string, to: string, o: Record<string, unknown> = {}) => ({ id: `u-${slug}`, type: "plugin", slug, from, to, rollbackable: true, ...o });
const PAYLOAD = () => ({
  runId: RUN, siteId: "site1", siteUrl: "https://acme.com", alias: "client1", path: "/var/www/html", paths: ["/", "/contact/"],
  updates: [upd("akismet", "5.0", "5.1"), upd("hello", "1.0", "1.1")],
});
const keysFor = (n: number) => Array.from({ length: n }, (_, i) => ["before", "after", "diff"].map((k) => `care/${RUN}/${i}-${k}.jpg`)).flat();

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "care-update-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface World {
  versions: Record<string, string>;
  backupExists?: boolean;
  /** `test -e` finds the file but `gzip -t` says it is cut short. */
  gzipCorrupt?: boolean;
  failExport?: boolean;
  failUpdate?: string[];
  failInstall?: string[];
  failUpdateDb?: boolean;
  unreadable?: string[];
  /** Per path, the status each successive read of it gets. */
  pages?: Record<string, number[]>;
  stopTouchAt?: number;
}

/** A fake server, Chrome and ffmpeg behind one exec, a fake fetch and a fake api, all writing to one ordered log. */
function setup(w: World, payload: unknown = PAYLOAD(), outputs?: string[]) {
  const log: string[] = [];
  const argvs: string[][] = [];
  const uploads: { key: string; contentType: string }[] = [];
  const versions = { ...w.versions };
  let touches = 0;
  const timeouts: number[] = [];
  const reads: Record<string, number> = {};
  const exec: Exec = async (file, args, opts) => {
    if (file === "ssh") timeouts.push(opts?.timeoutMs ?? 0);
    if (file === "chrome") {
      const out = args.find((a) => a.startsWith("--screenshot="))!.slice(13);
      log.push(`chrome ${args[args.length - 1]}`);
      writeFileSync(out, "png");
      return { stdout: "" };
    }
    if (file === "ffmpeg") {
      if (args.includes("ssim")) { log.push("ffmpeg ssim"); return { stdout: "", stderr: "All:0.99 (20)" }; }
      log.push("ffmpeg jpg");
      writeFileSync(args[args.length - 1], "jpg");
      return { stdout: "" };
    }
    expect(file).toBe("ssh");
    argvs.push(args);
    const words = args.slice(args.indexOf("--") + 1).map((x) => x.replace(/^'|'$/g, ""));
    if (words[0] !== "wp") {
      const cmd = words.join(" ");
      log.push(`remote ${cmd}`);
      if ((words[0] === "test" || (words[0] === "gzip" && words[1] === "-t")) && !w.backupExists) throw new Error("exit 1");
      if (words[0] === "gzip" && words[1] === "-t" && w.gzipCorrupt) throw new Error("unexpected end of file");
      return { stdout: "" };
    }
    const cmd = words.slice(2).join(" ");
    log.push(`wp ${cmd}`);
    const [a, b, c] = words.slice(2);
    if (a === "core" && b === "version") return { stdout: `${versions.core}\n` };
    if ((a === "plugin" || a === "theme") && b === "get") {
      if (w.unreadable?.includes(`${a}:${c}`)) throw new Error("Error: not installed");
      return { stdout: `Notice: banner\n${versions[`${a}:${c}`]}\n` };
    }
    if (a === "db" && b === "export") { if (w.failExport) throw new Error("mysqldump missing"); return { stdout: "Success\n" }; }
    if ((a === "plugin" || a === "theme") && b === "update") {
      if (w.failUpdate?.includes(c)) throw new Error("Error: could not update the plugin");
      versions[`${a}:${c}`] = words.find((x) => x.startsWith("--version="))!.slice(10);
      return { stdout: "Success\n" };
    }
    if ((a === "plugin" || a === "theme") && b === "install") {
      if (w.failInstall?.includes(c)) throw new Error("Error: no such version");
      versions[`${a}:${c}`] = words.find((x) => x.startsWith("--version="))!.slice(10);
      return { stdout: "Success\n" };
    }
    if (a === "core" && b === "update") { versions.core = words.find((x) => x.startsWith("--version="))!.slice(10); return { stdout: "Success\n" }; }
    if (a === "core" && b === "update-db") { if (w.failUpdateDb) throw new Error("Error: db"); return { stdout: "Success\n" }; }
    throw new Error(`unexpected wp command: ${cmd}`);
  };
  const fetchFn = (async (url: string) => {
    const path = new URL(url).pathname;
    log.push(`fetch ${path}`);
    const q = w.pages?.[path] ?? [200];
    const n = reads[path] = (reads[path] ?? 0) + 1;
    return new Response("<form></form>", { status: q[Math.min(n, q.length) - 1] });
  }) as unknown as typeof fetch;
  const api: JobApi = {
    async hello() { return { serverTime: "", minHelperVersion: "0.1.0" }; },
    async claim() { return null; },
    async download() {},
    async upload(_id, key, from, contentType) { statSync(from); log.push(`upload ${key}`); uploads.push({ key, contentType }); },
    async touch() { touches++; log.push("touch"); if (w.stopTouchAt !== undefined && touches >= w.stopTouchAt) throw new ApiError(409, "this job is not claimed by this device"); },
    async complete() {}, async fail() {},
  };
  const job: ClaimedJob = { id: "j1", kind: "care.update", attempts: 1, payload, inputs: [], outputs: outputs ?? keysFor(2) };
  const ctx: JobContext = { job, api, cfg: { chrome: "chrome", ffmpeg: "ffmpeg" } as never, workDir: dir };
  return { run: () => careUpdateHandler(exec, fetchFn).run(ctx) as Promise<any>, log, argvs, uploads, versions, timeouts, touches: () => touches };
}

const BASIC: World = { versions: { "plugin:akismet": "5.0", "plugin:hello": "1.0" } };

describe("care.update", () => {
  it("does a clean run in order: versions, before pages, backup, updates, after pages, ffmpeg, uploads", async () => {
    const s = setup(BASIC);
    const r = await s.run();
    const calls = s.log.filter((l) => l !== "touch");
    expect(calls).toEqual([
      "wp plugin get akismet --field=version", "wp plugin get hello --field=version",
      "fetch /", "chrome https://acme.com/", "fetch /contact/", "chrome https://acme.com/contact/",
      `remote test -e ${GZ}`,
    ].concat([
      "remote mkdir -p siteline-backups", `wp db export ${BASE}`, `remote gzip -f ${BASE}`, "remote find siteline-backups -name *.sql.gz -mtime +28 -delete",
      "wp plugin update akismet --version=5.1", "wp plugin update hello --version=1.1",
      "fetch /", "chrome https://acme.com/", "fetch /contact/", "chrome https://acme.com/contact/",
      "ffmpeg ssim", "ffmpeg jpg", "ffmpeg jpg", "ffmpeg jpg",
      "ffmpeg ssim", "ffmpeg jpg", "ffmpeg jpg", "ffmpeg jpg",
      ...keysFor(2).map((k) => `upload ${k}`),
    ]));
    expect(s.uploads).toHaveLength(6);
    expect(s.uploads.every((u) => u.contentType === "image/jpeg")).toBe(true);
    expect(r.backupFile).toBe(GZ);
    expect(r.rolledBack).toBe(false);
    expect(r.steps.map((x: any) => [x.id, x.outcome])).toEqual([["u-akismet", "applied"], ["u-hello", "applied"]]);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[0]).toEqual({
      path: "/", before: { status: 200, fatal: false, forms: 1 }, after: { status: 200, fatal: false, forms: 1 }, ssim: 0.99, verdict: "ok",
      uploaded: { before: true, after: true, diff: true },
    });
  });

  it("orders the work the brief's way (phase positions)", async () => {
    const s = setup(BASIC);
    await s.run();
    const at = (re: RegExp, from = 0) => s.log.findIndex((l, i) => i >= from && re.test(l));
    const v = at(/^wp plugin get akismet/), b = at(/^chrome/), bk = at(/^wp db export/), u1 = at(/^wp plugin update akismet/), u2 = at(/^wp plugin update hello/);
    const a = at(/^chrome/, u2), ff = at(/^ffmpeg/), up = at(/^upload/);
    expect([v, b, bk, u1, u2, a, ff, up].every((n) => n >= 0)).toBe(true);
    expect([v, b, bk, u1, u2, a, ff, up]).toEqual([...[v, b, bk, u1, u2, a, ff, up]].sort((x, y) => x - y));
  });

  it("a rerun keeps the first backup, skips what is already updated and updates only the rest", async () => {
    const s = setup({ versions: { "plugin:akismet": "5.1", "plugin:hello": "1.0" }, backupExists: true });
    const r = await s.run();
    expect(s.log.some((l) => l.startsWith("wp db export"))).toBe(false);
    expect(s.log.some((l) => l.startsWith("remote mkdir"))).toBe(false);
    expect(s.log).not.toContain("wp plugin update akismet --version=5.1");
    expect(s.log).toContain("wp plugin update hello --version=1.1");
    expect(r.backupFile).toBe(GZ);
    expect(r.steps[0]).toEqual({ id: "u-akismet", outcome: "skipped", note: "already at the new version" });
    expect(r.steps[1].outcome).toBe("applied");
  });

  it("does not trust a backup file that is not a whole gzip: it takes the backup again", async () => {
    const s = setup({ ...BASIC, backupExists: true, gzipCorrupt: true });
    const r = await s.run();
    expect(s.log).toContain(`remote gzip -t ${GZ}`);
    expect(s.log).toContain(`wp db export ${BASE}`);
    expect(r.backupFile).toBe(GZ);
  });

  it("skips a component found at a third version", async () => {
    const s = setup({ versions: { "plugin:akismet": "4.9", "plugin:hello": "1.0" } });
    const r = await s.run();
    expect(r.steps[0]).toEqual({ id: "u-akismet", outcome: "skipped", note: "changed by hand since the plan" });
    expect(s.log.some((l) => l.startsWith("wp plugin update akismet"))).toBe(false);
    expect(r.steps[1].outcome).toBe("applied");
  });

  it("when everything is already done it does nothing else, and still names the first backup", async () => {
    const s = setup({ versions: { "plugin:akismet": "5.1", "plugin:hello": "1.1" }, backupExists: true });
    const r = await s.run();
    expect(r.steps.map((x: any) => x.outcome)).toEqual(["skipped", "skipped"]);
    expect(r.pages).toEqual([]);
    expect(r.backupFile).toBe(GZ);
    expect(s.log.some((l) => l.startsWith("chrome") || l.startsWith("wp db") || l.includes("update"))).toBe(false);
  });

  it("puts the old versions back when a page breaks, and reads the pages again", async () => {
    const s = setup({ ...BASIC, pages: { "/": [200, 500, 200], "/contact/": [200, 200, 200] } });
    const r = await s.run();
    expect(s.log).toContain("wp plugin install akismet --version=5.0 --force");
    expect(s.log).toContain("wp plugin install hello --version=1.0 --force");
    expect(s.versions["plugin:akismet"]).toBe("5.0");
    expect(r.rolledBack).toBe(true);
    expect(r.steps.map((x: any) => x.outcome)).toEqual(["rolled_back", "rolled_back"]);
    expect(r.steps[0].note).toMatch(/^the site broke after this update/);
    expect(r.pages[0].verdict).toBe("broken");
    expect(r.pages[0].after.status).toBe(200); // the recheck
    expect(r.pages[1].after.status).toBe(200);
    expect(s.log.filter((l) => l === "chrome https://acme.com/")).toHaveLength(2); // before and after only: the recheck takes no screenshot
    expect(s.log.some((l) => /db import|db query/.test(l))).toBe(false);
  });

  it("a non-rollbackable update that broke the site is rollback_failed, and the others are put back", async () => {
    const p = PAYLOAD();
    p.updates[0] = upd("akismet", "5.0", "5.1", { rollbackable: false });
    const s2 = setup({ ...BASIC, pages: { "/": [200, 500, 500] } }, p);
    const r = await s2.run();
    expect(s2.log.some((l) => l.startsWith("wp plugin install akismet"))).toBe(false);
    expect(s2.log).toContain("wp plugin install hello --version=1.0 --force");
    expect(r.steps[0]).toEqual({ id: "u-akismet", outcome: "rollback_failed", note: "the old version could not be put back" });
    expect(r.steps[1].outcome).toBe("rolled_back");
    expect(r.rolledBack).toBe(true);
  });

  it("only non-rollbackable and broken: rollback_failed, nothing is installed, rolledBack is false", async () => {
    const p = PAYLOAD();
    p.updates = [upd("akismet", "5.0", "5.1", { rollbackable: false })];
    const s = setup({ ...BASIC, pages: { "/": [200, 500] } }, p);
    const r = await s.run();
    expect(r.steps[0].outcome).toBe("rollback_failed");
    expect(r.rolledBack).toBe(false);
    expect(s.log.some((l) => l.includes(" install "))).toBe(false);
  });

  it("a rollback that wp-cli refuses is rollback_failed with its message", async () => {
    const s = setup({ ...BASIC, pages: { "/": [200, 500, 500] }, failInstall: ["hello"] });
    const r = await s.run();
    expect(r.steps[1].outcome).toBe("rollback_failed");
    expect(r.steps[1].note).toMatch(/^the old version could not be put back: .*no such version/);
    expect(r.steps[0].outcome).toBe("rolled_back");
  });

  it("a wp-cli failure stops the later updates, rolls back the applied ones and says why", async () => {
    const s = setup({ ...BASIC, failUpdate: ["hello"] });
    const r = await s.run();
    expect(r.steps[1].outcome).toBe("failed");
    expect(r.steps[1].note).toMatch(/^wp-cli refused the update: /);
    expect(r.steps[1].note.length).toBeLessThanOrEqual("wp-cli refused the update: ".length + 200);
    expect(r.steps[0].outcome).toBe("rolled_back");
    expect(s.log).toContain("wp plugin install akismet --version=5.0 --force");
    expect(r.rolledBack).toBe(true);
  });

  it("a failed update stops the rest: they are skipped", async () => {
    const s = setup({ ...BASIC, failUpdate: ["akismet"] });
    const r = await s.run();
    expect(r.steps[0].outcome).toBe("failed");
    expect(r.steps[1].outcome).toBe("skipped");
    expect(s.log.some((l) => l.startsWith("wp plugin update hello"))).toBe(false);
    expect(r.rolledBack).toBe(false);
  });

  it("updates and rolls back core with update-db each time, and themes too", async () => {
    const p = PAYLOAD();
    p.updates = [{ id: "u-core", type: "core", slug: "wordpress", from: "6.4.1", to: "6.5", rollbackable: true }, upd("divi", "1.0", "1.1", { type: "theme" })];
    const s = setup({ versions: { core: "6.4.1", "theme:divi": "1.0" }, pages: { "/": [200, 500, 200] } }, p);
    const r = await s.run();
    const cmds = s.log.filter((l) => l.startsWith("wp "));
    expect(cmds).toContain("wp core version");
    expect(cmds).toContain("wp theme get divi --field=version");
    const i = cmds.indexOf("wp core update --version=6.5");
    expect(cmds[i + 1]).toBe("wp core update-db");
    expect(cmds).toContain("wp theme update divi --version=1.1");
    const j = cmds.indexOf("wp core update --version=6.4.1 --force");
    expect(j).toBeGreaterThan(i);
    expect(cmds[j + 1]).toBe("wp core update-db");
    expect(cmds).toContain("wp theme install divi --version=1.0 --force");
    expect(r.steps.map((x: any) => x.outcome)).toEqual(["rolled_back", "rolled_back"]);
  });

  it("a core update whose update-db fails is failed but still put back", async () => {
    const p = PAYLOAD();
    p.updates = [{ id: "u-core", type: "core", slug: "wordpress", from: "6.4.1", to: "6.5", rollbackable: true }];
    const s = setup({ versions: { core: "6.4.1" }, failUpdateDb: true }, p);
    const r = await s.run();
    expect(s.log).toContain("wp core update --version=6.4.1 --force");
    expect(["rolled_back", "rollback_failed"]).toContain(r.steps[0].outcome);
    expect(r.rolledBack).toBe(true);
  });

  it("a failed backup updates nothing and says so on every step", async () => {
    const s = setup({ ...BASIC, failExport: true });
    const r = await s.run();
    expect(r.backupFile).toBeNull();
    expect(r.steps.map((x: any) => [x.outcome, x.note])).toEqual([["skipped", "the backup failed, nothing was updated"], ["skipped", "the backup failed, nothing was updated"]]);
    expect(s.log.some((l) => /plugin update|plugin install/.test(l))).toBe(false);
  });

  it("a version that cannot be read skips that one; if none can be read the job fails", async () => {
    const s = setup({ ...BASIC, unreadable: ["plugin:hello"] });
    const r = await s.run();
    expect(r.steps[1].outcome).toBe("skipped");
    expect(r.steps[1].note).toMatch(/^could not read the current version/);
    expect(r.steps[0].outcome).toBe("applied");
    const s2 = setup({ ...BASIC, unreadable: ["plugin:hello", "plugin:akismet"] });
    await expect(s2.run()).rejects.toThrow();
    expect(s2.log.some((l) => l.startsWith("chrome"))).toBe(false);
  });

  it("calls api.touch after every step", async () => {
    const s = setup(BASIC);
    await s.run();
    const touchAfter = (re: RegExp) => s.log.map((l, i) => (re.test(l) ? s.log[i + 1] : null)).filter((x) => x !== null);
    for (const re of [/^wp plugin get/, /^chrome/, /^wp db export/, /^remote gzip/, /^wp plugin update/]) {
      const next = touchAfter(re);
      expect(next.length, String(re)).toBeGreaterThan(0);
      expect(next.every((x) => x === "touch" || /^fetch|^chrome|^wp |^remote/.test(x!)), String(re)).toBe(true);
    }
    // each mutating command is followed at once by a touch
    for (const re of [/^wp plugin update/, /^wp db export/, /^remote gzip/, /^remote mkdir/]) expect(touchAfter(re).every((x) => x === "touch"), String(re)).toBe(true);
    expect(s.touches()).toBeGreaterThanOrEqual(8);
  });

  it("stops at once when the server says the job is no longer ours", async () => {
    const s = setup({ ...BASIC, stopTouchAt: 8 });
    await expect(s.run()).rejects.toMatchObject({ status: 409 });
    expect(s.log.some((l) => /^wp plugin update hello/.test(l))).toBe(false);
    expect(s.log.some((l) => l.startsWith("upload"))).toBe(false);
  });

  it("uploads only the keys the job lists", async () => {
    const s = setup(BASIC, PAYLOAD(), [`care/${RUN}/0-before.jpg`, `care/${RUN}/0-after.jpg`]);
    const r = await s.run();
    expect(s.uploads.map((u) => u.key)).toEqual([`care/${RUN}/0-before.jpg`, `care/${RUN}/0-after.jpg`]);
    expect(r.pages[0].uploaded).toEqual({ before: true, after: true, diff: false });
    expect(r.pages[1].uploaded).toEqual({ before: false, after: false, diff: false });
  });

  it("an unchanged page is ok", async () => {
    const s = setup({ ...BASIC, pages: { "/": [200, 200] } });
    const r = await s.run();
    expect(r.pages[0].verdict).toBe("ok");
  });
});

describe("care.update refuses a bad payload before any ssh", () => {
  const bad: [string, (p: any) => void][] = [
    ["hostile slug", (p) => { p.updates[0].slug = "x; rm -rf ~"; }],
    ["subshell slug", (p) => { p.updates[0].slug = "$(id)"; }],
    ["bad from", (p) => { p.updates[0].from = "5.0 --x"; }],
    ["dotdot version", (p) => { p.updates[0].to = "1..2"; }],
    ["bad type", (p) => { p.updates[0].type = "mu-plugin"; }],
    ["rollbackable not boolean", (p) => { p.updates[0].rollbackable = "yes"; }],
    ["no updates", (p) => { p.updates = []; }],
    ["41 updates", (p) => { p.updates = Array.from({ length: 41 }, (_, i) => upd(`p${i}`, "1.0", "1.1")); }],
    ["duplicate component", (p) => { p.updates[1] = { ...p.updates[0], id: "other" }; }],
    ["duplicate id", (p) => { p.updates[1].id = p.updates[0].id; }],
    ["bad alias", (p) => { p.alias = "a b"; }],
    ["dash alias", (p) => { p.alias = "-oProxyCommand=x"; }],
    ["bad path", (p) => { p.path = "/var/../etc"; }],
    ["six paths", (p) => { p.paths = ["/", "/a", "/b", "/c", "/d", "/e"]; }],
    ["bad page path", (p) => { p.paths = ["/a b"]; }],
    ["page path not a string", (p) => { p.paths = [3]; }],
    ["bad run id", (p) => { p.runId = "x; id"; }],
    ["short run id", (p) => { p.runId = "abc"; }],
    ["bad site url", (p) => { p.siteUrl = "not a url"; }],
    ["ftp site url", (p) => { p.siteUrl = "ftp://acme.com"; }],
    ["underscore host", (p) => { p.siteUrl = "https://a_b.com"; }],
    ["no site id", (p) => { delete p.siteId; }],
    ["updates not a list", (p) => { p.updates = "x"; }],
  ];
  it.each(bad)("%s", async (_name, mutate) => {
    const p = PAYLOAD();
    mutate(p);
    const s = setup(BASIC, p);
    await expect(s.run()).rejects.toThrow();
    expect(s.log).toEqual([]);
    expect(s.argvs).toEqual([]);
  });
  it("refuses a payload that is not an object", async () => {
    const s = setup(BASIC, null);
    await expect(s.run()).rejects.toThrow();
    expect(s.argvs).toEqual([]);
  });
});

describe("care.update never runs anything outside the fixed set", () => {
  it("no argv has eval, shell, sh -c, db query, db import or a tilde, and every ssh is one of the known commands", async () => {
    for (const w of [BASIC, { ...BASIC, pages: { "/": [200, 500, 200] } }, { ...BASIC, failUpdate: ["hello"] }]) {
      const s = setup(w);
      await s.run();
      const all = s.argvs.map((a) => a.join(" "));
      expect(all.length).toBeGreaterThan(5);
      for (const line of all) {
        expect(line).not.toMatch(/\beval\b|\bshell\b|\bsh -c\b|db query|db import|~/);
        expect(line).toMatch(/^-o BatchMode=yes -o ConnectTimeout=15 client1 -- (wp --path='\/var\/www\/html' |mkdir |test |gzip |find )/);
      }
    }
  });
  it("uses a 300 second timeout on every ssh call", async () => {
    const s = setup(BASIC);
    await s.run();
    expect(s.timeouts.length).toBeGreaterThan(5);
    expect(new Set(s.timeouts)).toEqual(new Set([300_000]));
  });
});
