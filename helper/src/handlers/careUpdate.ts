import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ApiError, TokenRevoked } from "../api.ts";
import { WP_ARG, WpError, remote, wpRaw, wpText } from "../care/wp.ts";
import { checkUrl, compare, pageUrl, readPage, screenshot, toJpeg, verdictOf, type CheckTag, type PageShot, type Verdict } from "../care/pages.ts";
import { runProcess, type Exec } from "../exec.ts";
import type { JobHandler } from "../loop.ts";
import { payloadOf } from "./clone.ts";

/** Each wp-cli call (and each remote command) may take this long. */
const TIMEOUT_MS = 300_000;
/** No new update is started when the last successful touch is older than this. */
const CONTACT_MS = 10 * 60_000;
const MAX_UPDATES = 40;
const MAX_PATHS = 5;
const BACKUP_DIR = "siteline-backups";
/** A page read that got no answer at all is tried once more after this long before it counts. */
const REREAD_MS = 2_000;

type Target = { alias: string; path: string };
type Outcome = "applied" | "skipped" | "failed" | "rolled_back" | "rollback_failed";
type Read = { status: number | null; fatal: boolean; forms: number };
interface Update { id: string; type: "core" | "plugin" | "theme"; slug: string; from: string; to: string; rollbackable: boolean }
interface Payload { runId: string; siteId: string; siteUrl: string; domain: string; alias: string; path: string; paths: string[]; updates: Update[] }
interface Step { id: string; outcome: Outcome; note: string }
interface PageResult { path: string; before: Read; after: Read; ssim: number | null; verdict: Verdict; uploaded: { before: boolean; after: boolean; diff: boolean } }

/** The fixed sentences a step's note is made of (the Worker and the incident text rely on them). */
const SAY = {
  already: "already at the new version",
  byHand: "changed by hand since the plan",
  noBackup: "the backup failed, nothing was updated",
  refused: "wp-cli refused the update",
  broke: "the site broke after this update",
  otherFailed: "put back because another update failed",
  notStarted: "not started: an earlier update failed",
  noPutBack: "the old version could not be put back",
  noRead: "could not read the current version",
  earlier: "applied by an earlier attempt",
  interrupted: "not started: the job was interrupted",
  lostContact: "stopped: lost contact with Agency OS",
} as const;

const word = (v: unknown, max: number): string => (typeof v === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(v) && v.length <= max ? v : "");
const cut = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 200);
const withWhy = (sentence: string, e?: unknown): string => { const why = e === undefined ? "" : cut(e); return why ? `${sentence}: ${why}` : sentence; };

const badVersion = (v: unknown): boolean => typeof v !== "string" || !WP_ARG.version.test(v) || v.includes("..");

/** Reads the job's payload and checks every field with the helper's own patterns. Any bad field throws, before anything is run. */
function parsePayload(job: Parameters<typeof payloadOf>[0]): Payload {
  const p = payloadOf(job);
  const bad = (what: string): never => { throw new Error(`the care.update job's ${what} is not valid`); };
  const runId = typeof p.runId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.runId) ? p.runId : bad("run id");
  const siteId = word(p.siteId, 100) || bad("site id");
  let domain = "";
  let siteUrl = "";
  try {
    const u = new URL(String(p.siteUrl));
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !/^[a-z0-9.-]+$/i.test(u.hostname) || u.hostname.includes("..") || u.hostname.length > 100) throw new Error("x");
    domain = u.hostname.toLowerCase();
    siteUrl = u.origin;
  } catch { bad("site address"); }
  const alias = typeof p.alias === "string" && WP_ARG.alias.test(p.alias) ? p.alias : bad("SSH alias");
  const path = typeof p.path === "string" && WP_ARG.path.test(p.path) ? p.path : bad("WordPress path");
  if (!Array.isArray(p.paths) || p.paths.length > MAX_PATHS) bad("page list");
  const paths = (p.paths as unknown[]).map((x) => {
    if (typeof x !== "string") return bad("page path");
    try { pageUrl(siteUrl, x); } catch { bad("page path"); }
    return x;
  });
  if (!Array.isArray(p.updates) || p.updates.length < 1 || p.updates.length > MAX_UPDATES) bad("update list");
  const seenId = new Set<string>();
  const seenComponent = new Set<string>();
  const updates = (p.updates as unknown[]).map((raw): Update => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("update");
    const u = raw as Record<string, unknown>;
    const type = u.type === "core" || u.type === "plugin" || u.type === "theme" ? u.type : bad("update type");
    const id = word(u.id, 100) || bad("update id");
    // A core update has no slug on the command line; a plugin or theme slug is put on one, so it must be a safe slug.
    const slug = type === "core" ? word(u.slug, 100) || bad("update slug") : typeof u.slug === "string" && WP_ARG.slug.test(u.slug) ? u.slug : bad("update slug");
    if (badVersion(u.from) || badVersion(u.to)) bad("update version");
    if (typeof u.rollbackable !== "boolean") bad("rollbackable flag");
    const component = type === "core" ? "core" : `${type}:${slug}`;
    if (seenId.has(id) || seenComponent.has(component)) bad("update list");
    seenId.add(id); seenComponent.add(component);
    return { id, type, slug, from: u.from as string, to: u.to as string, rollbackable: u.rollbackable as boolean };
  });
  return { runId, siteId, siteUrl, domain, alias, path, paths, updates };
}

/** The server no longer counts this job as ours (or the token is gone): the one kind of error that must stop the job at once. */
const isStop = (e: unknown): boolean => e instanceof TokenRevoked || (e instanceof ApiError && [403, 404, 409].includes(e.status));

const fileExists = async (p: string): Promise<boolean> => { try { const s = await stat(p); return s.isFile() && s.size > 0; } catch { return false; } };

/**
 * Updates one client site's plugins, themes and core over SSH, with a database backup first, page checks before and after, and the old versions put back if a page breaks.
 * Safe to run again after the Mac slept: it reads each component's version first, skips what is already at the new version, and keeps the first backup.
 * It runs `wp` (plugin get/update/install, theme get/update/install, core version/update/update-db, db export, cache flush) and `mkdir`, `test`, `gzip`, `find`, nothing else.
 * Every page read and screenshot has its own `siteline-check` query and asks caches not to answer, and the object cache is flushed after the updates, so a cached copy never passes for a healthy page.
 */
export function careUpdateHandler(
  exec: Exec = runProcess, fetchFn: typeof fetch = fetch, now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): JobHandler {
  return {
    kind: "care.update",
    async run({ job, api, cfg, workDir }) {
      const p = parsePayload(job);
      const t: Target = { alias: p.alias, path: p.path };
      const o = { timeoutMs: TIMEOUT_MS };
      const sql = `${BACKUP_DIR}/${p.domain}-${p.runId}.sql`;
      const gz = `${sql}.gz`;

      /** After every step: keeps the claim alive. Only "this job is no longer yours" stops the job; a hiccup in the keep-alive does not. */
      let lastContact = now();
      const tick = async (): Promise<void> => { try { await api.touch(job.id); lastContact = now(); } catch (e) { if (isStop(e)) throw e; } };
      const rem = (words: string[]) => remote(exec, p.alias, words, o);

      const steps: Step[] = p.updates.map((u) => ({ id: u.id, outcome: "skipped", note: "" }));
      const pending = new Set<number>();
      const changed = new Set<number>(); // updates this run touched (in the order applied): the only ones that can be put back
      const stepOf = (i: number, outcome: Outcome, note: string) => { steps[i] = { id: p.updates[i].id, outcome, note }; };

      /** The first ssh/wp error a version read hit: named when no version could be read at all. */
      let firstReadError = "";
      /** The version now, or null when it cannot be read. */
      const versionOf = async (u: Update): Promise<string | null> => {
        try {
          const v = u.type === "core" ? await wpText(exec, t, ["core", "version"], o) : await wpText(exec, t, [u.type, "get", u.slug, "--field=version"], o);
          return WP_ARG.version.test(v) ? v : null;
        } catch (e) {
          firstReadError ||= (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 300);
          return null;
        }
      };
      /** Page i's URL for one read: its own cache-busting query each time. */
      const urlOf = (i: number, tag: CheckTag): string => checkUrl(p.siteUrl, p.paths[i], p.runId, i, tag);
      /** A read that got no answer at all (`status: null`) is tried once more, 2 s later, before it counts. */
      const read = async (i: number, tag: CheckTag): Promise<Read> => {
        const r = await readPage(fetchFn, urlOf(i, tag));
        if (r.status !== null) return r;
        await sleep(REREAD_MS);
        return readPage(fetchFn, urlOf(i, tag));
      };
      const backupExists = async (): Promise<boolean> => {
        try { await rem(["test", "-e", gz]); await rem(["gzip", "-t", gz]); return true; } catch { return false; }
      };
      /** Puts the old code back, in the reverse of the order it was changed. The database is never imported. True when at least one put-back command ran. */
      const putBack = async (order: number[], why: string): Promise<boolean> => {
        let ran = false;
        for (const i of [...order].reverse()) {
          const u = p.updates[i];
          if (!u.rollbackable) { stepOf(i, "rollback_failed", SAY.noPutBack); await tick(); continue; }
          ran = true;
          try {
            if (u.type === "core") {
              await wpRaw(exec, t, ["core", "update", `--version=${u.from}`, "--force"], o);
              await wpRaw(exec, t, ["core", "update-db"], o);
            } else await wpRaw(exec, t, [u.type, "install", u.slug, `--version=${u.from}`, "--force"], o);
            stepOf(i, "rolled_back", why);
          } catch (e) {
            stepOf(i, "rollback_failed", withWhy(SAY.noPutBack, e));
          }
          await tick();
        }
        return ran;
      };
      /** Only the status, no screenshot: is the site back? */
      const recheck = async (pages: PageResult[]): Promise<void> => {
        for (let i = 0; i < p.paths.length; i++) {
          const r = await read(i, "recheck");
          pages[i].after = { status: r.status, fatal: r.fatal, forms: r.forms };
          await tick();
        }
      };
      const empty: Read = { status: null, fatal: false, forms: 0 };

      // (1) Where is each component now?
      const readErrors: unknown[] = [];
      const nowVer: (string | null)[] = [];
      for (const [i, u] of p.updates.entries()) {
        const v = await versionOf(u);
        nowVer.push(v);
        if (v === null) { readErrors.push(1); stepOf(i, "skipped", SAY.noRead); }
        await tick();
      }
      // Not one version could be read: the site cannot be reached, which is a failed job (it may be tried again), not a list of skipped updates.
      if (readErrors.length === p.updates.length) throw new WpError(firstReadError ? `${SAY.noRead}: ${firstReadError}` : SAY.noRead);

      // A retried job (the Mac slept or the helper died) never applies an update: it reports what is there, checks the pages and puts back what broke the site.
      if (job.attempts > 1) {
        const set: number[] = [];
        for (const [i, u] of p.updates.entries()) {
          const v = nowVer[i];
          if (v === null) continue;
          if (v === u.to) { stepOf(i, "applied", SAY.earlier); set.push(i); }
          else if (v === u.from) stepOf(i, "skipped", SAY.interrupted);
          else { stepOf(i, "skipped", SAY.byHand); if (u.rollbackable) set.push(i); }
        }
        const pages: PageResult[] = [];
        for (let i = 0; i < p.paths.length; i++) {
          const r = await read(i, "after");
          const broken = r.status === null || r.status === 404 || r.status === 410 || r.status >= 500 || r.fatal;
          pages.push({ path: p.paths[i], before: empty, after: { status: r.status, fatal: r.fatal, forms: r.forms }, ssim: null, verdict: broken ? "broken" : "ok", uploaded: { before: false, after: false, diff: false } });
          await tick();
        }
        let rolledBack = false;
        if (pages.some((x) => x.verdict === "broken") && set.length > 0) {
          rolledBack = await putBack(set, SAY.broke);
          if (rolledBack) await recheck(pages);
        }
        return { backupFile: (await backupExists()) ? gz : null, steps, pages, rolledBack, retry: true };
      }

      for (const [i, u] of p.updates.entries()) {
        const v = nowVer[i];
        if (v === null) continue;
        if (v === u.to) stepOf(i, "skipped", SAY.already);
        else if (v === u.from) pending.add(i);
        else stepOf(i, "skipped", SAY.byHand);
      }

      if (pending.size === 0) {
        // Nothing left to do: no pages, no backup. Name the first run's backup if it is there.
        return { backupFile: (await backupExists()) ? gz : null, steps, pages: [], rolledBack: false, retry: false };
      }

      // (2) The pages as they are now.
      const shoot = async (i: number, kind: "before" | "after"): Promise<PageShot> => {
        const png = join(workDir, `${i}-${kind}.png`);
        const r = await read(i, kind);
        const ok = await screenshot(exec, cfg.chrome, urlOf(i, kind), png);
        await tick();
        return { path: p.paths[i], ...r, png: ok ? png : null };
      };
      const before: PageShot[] = [];
      for (let i = 0; i < p.paths.length; i++) before.push(await shoot(i, "before"));

      // (3) The backup (a rerun keeps the first one).
      let backupOk = await backupExists();
      await tick();
      if (!backupOk) {
        try {
          await rem(["mkdir", "-m", "700", "-p", BACKUP_DIR]); await tick();
          await wpRaw(exec, t, ["db", "export", sql], o); await tick();
          await rem(["gzip", "-f", sql]); await tick();
          backupOk = true;
        } catch (e) {
          if (isStop(e)) throw e;
          backupOk = false;
        }
        if (backupOk) {
          // Old dumps go after the new one is safe; a failure here is only housekeeping.
          try { await rem(["find", BACKUP_DIR, "-name", "*.sql.gz", "-mtime", "+28", "-delete"]); } catch { /* the next run tries again */ }
          await tick();
        }
      }
      if (!backupOk) {
        for (const i of pending) stepOf(i, "skipped", SAY.noBackup);
        return { backupFile: null, steps, pages: [], rolledBack: false, retry: false };
      }

      // (4) The updates, in the plan's order. One failure stops the rest; so does losing contact with the server for 10 minutes.
      let anyFailed = false;
      for (const i of [...pending]) {
        const u = p.updates[i];
        if (anyFailed) { stepOf(i, "skipped", SAY.notStarted); continue; }
        if (now() - lastContact > CONTACT_MS) { stepOf(i, "skipped", SAY.lostContact); continue; }
        let why: unknown;
        try {
          if (u.type === "core") await wpRaw(exec, t, ["core", "update", `--version=${u.to}`], o);
          // A premium plugin or theme (not on wordpress.org) has no versions to pick from: its own updater gives the newest. The version re-read below still decides `applied`.
          else if (!u.rollbackable) await wpRaw(exec, t, [u.type, "update", u.slug], o);
          else await wpRaw(exec, t, [u.type, "update", u.slug, `--version=${u.to}`], o);
          if (u.type === "core") await wpRaw(exec, t, ["core", "update-db"], o);
        } catch (e) { why = e; }
        // wp-cli's exit code is not trusted: the step is applied only when the version now reads `to`.
        const v = await versionOf(u);
        if (v === u.to && why === undefined) stepOf(i, "applied", "");
        else {
          anyFailed = true;
          stepOf(i, "failed", withWhy(SAY.refused, why ?? new Error(v === u.to ? "" : `the version reads ${v ?? "unknown"}`)));
          // It may be half installed: whatever does not read `from` any more is put back too.
          if (v !== u.from) changed.add(i);
        }
        if (v === u.to) changed.add(i);
        await tick();
      }

      // (4b) Empty the object cache so the after-reads see the new code. Best effort: a host without one (or a refusal) changes nothing.
      try { await wpRaw(exec, t, ["cache", "flush"], o); } catch { /* ignored */ }
      await tick();

      // (5) The pages again, compared.
      const afterShots: PageShot[] = [];
      for (let i = 0; i < p.paths.length; i++) afterShots.push(await shoot(i, "after"));
      const pages: PageResult[] = [];
      for (let i = 0; i < p.paths.length; i++) {
        const b = before[i];
        const a = afterShots[i];
        const diff = join(workDir, `${i}-diff.jpg`);
        const ssim = b.png && a.png ? await compare(exec, cfg.ffmpeg, b.png, a.png, diff) : null;
        const jb = b.png ? await toJpeg(exec, cfg.ffmpeg, b.png, join(workDir, `${i}-before.jpg`)) : false;
        const ja = a.png ? await toJpeg(exec, cfg.ffmpeg, a.png, join(workDir, `${i}-after.jpg`)) : false;
        await tick();
        pages.push({
          path: p.paths[i],
          before: { status: b.status, fatal: b.fatal, forms: b.forms },
          after: { status: a.status, fatal: a.fatal, forms: a.forms },
          ssim, verdict: verdictOf(b, a, ssim),
          uploaded: { before: jb, after: ja, diff: ssim !== null },
        });
      }

      // (6) Put the old code back when a page broke or an update failed.
      const pageBroke = pages.some((x) => x.verdict === "broken");
      let rolledBack = false;
      if ((pageBroke || anyFailed) && changed.size > 0) {
        rolledBack = await putBack([...changed], pageBroke ? SAY.broke : SAY.otherFailed);
        if (rolledBack) await recheck(pages);
      }

      // (7) The JPEGs that exist, and only the keys the server listed for this job.
      const upload = async (key: string, file: string): Promise<boolean> => {
        if (!job.outputs.includes(key) || !(await fileExists(file))) return false;
        try { await api.upload(job.id, key, file, "image/jpeg"); return true; } catch (e) { if (isStop(e)) throw e; return false; }
      };
      for (const [i, page] of pages.entries()) {
        const key = (k: string) => `care/${p.runId}/${i}-${k}.jpg`;
        page.uploaded = {
          before: page.uploaded.before && (await upload(key("before"), join(workDir, `${i}-before.jpg`))),
          after: page.uploaded.after && (await upload(key("after"), join(workDir, `${i}-after.jpg`))),
          diff: page.uploaded.diff && (await upload(key("diff"), join(workDir, `${i}-diff.jpg`))),
        };
        await tick();
      }

      return { backupFile: gz, steps, pages, rolledBack, retry: false };
    },
  };
}
