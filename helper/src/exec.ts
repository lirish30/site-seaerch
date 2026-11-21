import { spawn } from "node:child_process";

export interface RunOptions { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv }
export type Exec = (file: string, args: string[], opts?: RunOptions) => Promise<{ stdout: string; stderr?: string }>;

const KEEP = 1_000_000;
/** The last few lines of a process's stderr: where the reason for a failure is. */
const tail = (s: string, max = 600): string => { const t = s.trim(); return t.length > max ? `…${t.slice(-max)}` : t; };

/**
 * Runs a program and returns what it printed. No shell, so nothing in an argument is ever interpreted. Rejects with a message that ends in the
 * program's own last words when it exits non-zero, and kills it (SIGKILL) when `timeoutMs` passes.
 */
export const runProcess: Exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs) : null;
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < KEEP) stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-KEEP); });
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      reject(new Error(e.code === "ENOENT" ? `cannot run ${file}: it was not found` : `cannot run ${file}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new Error(`${file} took longer than ${Math.round((opts.timeoutMs ?? 0) / 1000)} seconds and was stopped`));
      if (code === 0) return resolve({ stdout, stderr });
      const why = tail(stderr) || tail(stdout) || "no output";
      reject(new Error(`${file} ${signal ? `was killed (${signal})` : `exited with code ${code}`}: ${why}`));
    });
  });
