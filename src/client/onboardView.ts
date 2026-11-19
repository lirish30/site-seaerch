import type { ItemStatus } from "../worker/db/onboardings";
import type { PublicOnboarding, PublicOnboardingItem } from "../worker/onboarding/public";

/** Pure helpers for the client onboarding page (`/o/<token>`). Everything here takes plain values: no DOM, no fetch, no clock of its own. */

export type { PublicOnboarding, PublicOnboardingItem, ItemStatus };

/** The most a file can be, and how many an item takes (the server enforces the same). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_ITEM = 10;
export const FILE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "heic", "pdf", "docx", "txt"] as const;
/** For the file picker's `accept`: it narrows what the dialog offers, nothing more. The check below and the server decide. */
export const FILE_ACCEPT = FILE_EXTENSIONS.map((e) => `.${e}`).join(",");

/** How long (ms) the page leaves between requests: the server allows 30 a minute per link, so this keeps well under it. */
export const REQUEST_GAP_MS = 2500;
/** How long after the last keystroke an autosave waits. */
export const AUTOSAVE_MS = 1500;

// ---------- Dates ----------

/** The year, month and day of an instant in a zone, as a day number. An unknown zone is read as UTC rather than throwing. */
function dayNumber(d: Date, tz: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d); }
  catch { parts = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d); }
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Math.round(Date.UTC(n("year"), n("month") - 1, n("day")) / 86_400_000);
}

/**
 * "Due Fri, Dec 4", "Overdue by 2 days" or "No date yet". Days are counted on the calendar in `tz` (the owner's zone), so a due time of 11:30 pm on the
 * 4th is still "Due Fri, Dec 4" until the 4th ends there, whatever zone the phone is in.
 */
export function dueLabel(iso: string | null, now: Date, tz: string): string {
  const due = iso ? new Date(iso) : null;
  if (!due || Number.isNaN(due.getTime())) return "No date yet";
  const late = dayNumber(now, tz) - dayNumber(due, tz);
  if (late > 0) return `Overdue by ${late} ${late === 1 ? "day" : "days"}`;
  let text: string;
  try { text = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(due); }
  catch { text = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(due); }
  return `Due ${text}`;
}

// ---------- Labels ----------

const STATE_LABELS: Record<ItemStatus, string> = { waiting: "Waiting on you", received: "Received", accepted: "Accepted", not_applicable: "Not needed" };
export const itemStateLabel = (s: ItemStatus): string => STATE_LABELS[s] ?? "Waiting on you";

const clampDone = (p: { done: number; total: number }) => (p.total > 0 ? Math.min(Math.max(Math.floor(p.done) || 0, 0), p.total) : 0);

/** "2 of 7 done"; with nothing to do, words rather than "0 of 0". */
export const progressLabel = (p: { done: number; total: number }): string => (p.total > 0 ? `${clampDone(p)} of ${p.total} done` : "Nothing to do yet");

/** The progress bar's fill, 0 to 100. */
export const progressPercent = (p: { done: number; total: number }): number => (p.total > 0 ? Math.round((clampDone(p) / p.total) * 100) : 0);

// ---------- The questionnaire ----------

/** Whether the questionnaire can be handed in: the ids of required questions that have no answer yet (blank or only spaces counts as none). */
export function canSubmit(q: PublicOnboarding["questionnaire"]): { ok: boolean; missing: string[] } {
  const missing = q.questions.filter((x) => x.required && !(q.answers[x.id] ?? "").trim()).map((x) => x.id);
  return { ok: missing.length === 0, missing };
}

// ---------- The checklist ----------

const PHASE_TITLES = { 1: "First: homepage and one service page", 2: "Then: the rest of the site" } as const;

/** The items split by phase, phase 1 first, a phase with nothing in it left out. Order inside a phase is kept. */
export function groupByPhase<T extends { phase: 1 | 2 }>(items: T[]): { phase: 1 | 2; title: string; items: T[] }[] {
  return ([1, 2] as const).map((phase) => ({ phase, title: PHASE_TITLES[phase], items: items.filter((i) => i.phase === phase) })).filter((g) => g.items.length > 0);
}

// ---------- Files ----------

/** "1.5 KB", "20 MB", "0 B". A size that is not a count of bytes reads as 0 B. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024, u = 0;
  while (Number(v.toFixed(1)) >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${Number(v.toFixed(1))} ${units[u]}`;
}

/** A file name kept short enough to put in a message. */
const shortName = (name: string) => (name.length > 60 ? `${name.slice(0, 57)}...` : name);

/**
 * Why a file cannot be added, in words for the client, or null when it can. `existing` is how many files the item already has. This is only a courtesy
 * so the client is told at once: the server checks again and has the last word.
 */
export function checkFile(file: { name: string; size: number }, existing: number): string | null {
  const name = shortName(file.name);
  if (existing >= MAX_FILES_PER_ITEM) return `You can add up to ${MAX_FILES_PER_ITEM} files here. Remove one to add ${name}.`;
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!(FILE_EXTENSIONS as readonly string[]).includes(ext)) return `${name} isn't a type we accept. Please send photos (JPG, PNG, WEBP, GIF, HEIC), PDF, Word (DOCX) or text (TXT) files.`;
  if (file.size <= 0) return `${name} is empty.`;
  if (file.size > MAX_FILE_BYTES) return `${name} is ${formatBytes(file.size)}. The limit is 20 MB for each file.`;
  return null;
}

// ---------- What a write answers with ----------

/** Which write this was: it decides the words used for a refusal. */
export type WriteKind = "answers" | "submit" | "text" | "file" | "delete";

export type Outcome =
  | { kind: "ok" }
  /** Worth trying again: the connection dropped, the server is busy or slowing us down. `afterMs` is how long to wait. */
  | { kind: "retry"; message: string; afterMs: number }
  /** Refused for what was sent. `fields` are question or item ids (never what was typed). */
  | { kind: "rejected"; message: string; fields: string[] }
  /** Closed, already submitted, or the item no longer takes this. */
  | { kind: "locked"; message: string }
  /** The link is dead. */
  | { kind: "gone" };

const LOGIN_MESSAGE = "This looks like a login or password. Please remove it. We'll ask for access a safer way.";

/** Reads how long a 429 asks us to wait: whole seconds from `Retry-After`, kept between 5 and 60 seconds, 15 when it says nothing usable. */
function waitFrom(retryAfter: string | null): number {
  if (retryAfter === null || !/^\d+$/.test(retryAfter.trim())) return 15_000;
  return Math.min(Math.max(Number(retryAfter) * 1000, 5000), 60_000);
}

const stringIds = (body: { fields?: unknown } | null): string[] => (Array.isArray(body?.fields) ? body.fields.filter((f): f is string => typeof f === "string") : []);

/** A message the server sent, only when it is short text; its own words are fixed server text, never something the client typed. */
function serverWords(body: { error?: unknown } | null, fallback: string): string {
  const e = body?.error;
  if (typeof e !== "string" || !e.trim()) return fallback;
  const t = e.trim().slice(0, 200);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Sorts what a write answered (status 0 for a dropped connection) into what the page does next. */
export function writeOutcome(status: number, body: { error?: unknown; fields?: unknown } | null, retryAfter: string | null, kind: WriteKind): Outcome {
  if (status >= 200 && status < 300) return { kind: "ok" };
  if (status === 429) return { kind: "retry", message: "You're going a little fast. We'll save again in a moment.", afterMs: waitFrom(retryAfter) };
  if (status === 0) return { kind: "retry", message: "We couldn't reach the server. Check your connection and we'll try again.", afterMs: 10_000 };
  if (status >= 500) return { kind: "retry", message: "Something went wrong on our side. We'll try again.", afterMs: 10_000 };
  if (status === 404) return { kind: "gone" };
  if (status === 409) return { kind: "locked", message: serverWords(body, "This can't be changed any more.") };
  if (status === 413) return { kind: "rejected", message: "That file is too big. The limit is 20 MB for each file.", fields: [] };
  if (status === 415) return { kind: "rejected", message: "We don't accept that kind of file. Please send photos, PDF, Word (DOCX) or text files.", fields: [] };
  if (status === 422) return { kind: "rejected", message: LOGIN_MESSAGE, fields: stringIds(body) };
  if (kind === "submit") return { kind: "rejected", message: "A few questions still need an answer.", fields: stringIds(body) };
  return { kind: "rejected", message: kind === "file" ? "We couldn't use that file." : "That didn't go through. Please check it and try again.", fields: stringIds(body) };
}

// ---------- Pacing ----------

export interface Clock { now(): number; sleep(ms: number): Promise<void> }
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * One line for every request the page makes: each job starts at least `gapMs` after the one before it, in the order they were asked for. This is what keeps
 * the page under the server's per-link limit however fast someone types, tabs between boxes or picks ten files. A job that fails does not stop the line.
 */
export function createPacer(gapMs: number, clock: Clock = realClock): <T>(job: () => Promise<T>) => Promise<T> {
  let last = Number.NEGATIVE_INFINITY;
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(async () => {
      const wait = last + gapMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
      last = clock.now();
      return job();
    });
    tail = run.catch(() => undefined);
    return run;
  };
}

// ---------- Sending what is waiting when the tab goes away ----------

/** The most a `keepalive` request may carry is 64 KB (all of them in flight together); stay under it with room for headers. */
export const KEEPALIVE_LIMIT_BYTES = 60 * 1024;

/**
 * What to do with the value that is waiting when the tab is hidden or closed.
 * - `none`: nothing to send (nothing waiting, or the same thing is already on its way).
 * - `keepalive`: send this one request now, outside the pacer (a closed or frozen tab would never reach a pacer's wait), with `keepalive: true`.
 * - `paced`: the request is too big for keepalive, so it goes the normal way.
 */
export type UnloadPlan = { action: "none" } | { action: "keepalive"; url: string; method: "PUT"; body: string } | { action: "paced" };

/** Decides the plan for one box. `pending` is what is waiting (null for nothing), `inFlight` is what has already been sent and not answered. */
export function unloadPlan<T>(pending: T | null, inFlight: T | null, url: string, bodyOf: (v: T) => unknown, limit: number = KEEPALIVE_LIMIT_BYTES): UnloadPlan {
  if (pending === null) return { action: "none" };
  const body = JSON.stringify(bodyOf(pending));
  if (inFlight !== null && JSON.stringify(bodyOf(inFlight)) === body) return { action: "none" };
  if (new TextEncoder().encode(body).length > limit) return { action: "paced" };
  return { action: "keepalive", url, method: "PUT", body };
}
