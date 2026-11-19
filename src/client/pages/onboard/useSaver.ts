import { useCallback, useEffect, useRef, useState } from "react";
import { AUTOSAVE_MS, combine, mayRun, type Outcome, type UnloadPlan, type UnloadState } from "../../onboardView";

export interface SaveState {
  phase: "idle" | "dirty" | "saving" | "saved" | "error";
  message: string;
  /** An error that will go away by trying again (a dropped connection, a busy server), so a "Try again" button makes sense. */
  retryable: boolean;
}

export interface SaverOptions<T> {
  /**
   * Sends a value (through the page's pacer) and says how it went. Never throws. `gate` must be handed to the request and asked at the moment the pacer lets
   * it go: it says whether to fetch at all (false: the value was sent another way meanwhile) and marks the fetch as started.
   */
  send: (value: T, gate: () => boolean) => Promise<Outcome>;
  /** Joins a value waiting to go with a newer one (answers add up; text is replaced). Default: the newer one wins. */
  merge?: (older: T, newer: T) => T;
  /**
   * For the moment the tab is hidden or the box goes away: `plan` says what to do with what is waiting (typed, queued in the pacer, or already fetching) and
   * `fire` sends a keepalive plan at once. Without it, the waiting value goes the normal, paced way.
   */
  unload?: { plan: (s: UnloadState<T>) => UnloadPlan; fire: (plan: Extract<UnloadPlan, { action: "keepalive" }>) => Promise<Outcome> };
  /** True while a refused value is still outstanding: the box is then never reported as fully saved. */
  blocked?: () => boolean;
  onSaved?: () => void;
  onLocked?: () => void;
  onGone?: () => void;
}

const IDLE: SaveState = { phase: "idle", message: "", retryable: false };

/**
 * Debounced autosave for one box. `schedule` keeps the latest value and sends it once typing has paused for AUTOSAVE_MS, never once per keystroke; `flush`
 * sends right away (on blur, on submit) and resolves true when nothing is left unsaved. Sends never overlap, a value that could not be sent for a passing
 * reason goes back in the queue and is tried again after a wait that grows, and a refusal is shown and not retried. When the tab is hidden (or the page is
 * left, or the box goes away) the waiting value is sent once, immediately, as a keepalive request that skips the pacer, unless it is too big or already on its way.
 */
export function useSaver<T>(opts: SaverOptions<T>): { state: SaveState; schedule: (v: T) => void; flush: () => Promise<boolean> } {
  const o = useRef(opts);
  o.current = opts;
  const [state, setState] = useState<SaveState>(IDLE);
  const pending = useRef<{ value: T } | null>(null);
  /** The value handed to the pacer: `started` is false while it waits its turn (no fetch yet) and true once its fetch has been issued. */
  const current = useRef<{ value: T; started: boolean } | null>(null);
  /** The token of the one queued job allowed to fetch. Bumping it stands every queued job down. */
  const gen = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const line = useRef<Promise<boolean>>(Promise.resolve(true));
  const clean = useRef(true);
  const failures = useRef(0);
  const alive = useRef(true);
  const flushRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
  const show = useCallback((s: SaveState) => { if (alive.current) setState(s); }, []);

  /** What to do once a send has been answered. Returns whether the value is saved. */
  const settle = useCallback((outcome: Outcome, value: T): boolean => {
    const waiting = pending.current as { value: T } | null; // typed during the send
    if (outcome.kind === "ok") {
      failures.current = 0;
      clean.current = !o.current.blocked?.();
      show(waiting ? { phase: "dirty", message: "", retryable: false } : { phase: "saved", message: "Saved", retryable: false });
      o.current.onSaved?.();
      return clean.current;
    }
    clean.current = false;
    if (outcome.kind === "retry") {
      // Put it back (joined with anything typed meanwhile) and try again later.
      pending.current = { value: waiting && o.current.merge ? o.current.merge(value, waiting.value) : waiting ? waiting.value : value };
      failures.current += 1;
      show({ phase: "error", message: outcome.message, retryable: true });
      if (alive.current) retryTimer.current = setTimeout(() => void flushRef.current(), outcome.afterMs * Math.min(failures.current, 4));
    } else if (outcome.kind === "locked") {
      show({ phase: "error", message: outcome.message, retryable: false });
      o.current.onLocked?.();
    } else if (outcome.kind === "gone") {
      o.current.onGone?.();
    } else {
      show({ phase: "error", message: outcome.message, retryable: false });
    }
    return false;
  }, [show]);

  const flush = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current);
    clearTimeout(retryTimer.current);
    line.current = line.current.then(async () => {
      const job = pending.current;
      if (!job) return clean.current;
      pending.current = null;
      const token = ++gen.current;
      const entry = { value: job.value, started: false };
      current.current = entry;
      show({ phase: "saving", message: "Saving...", retryable: false });
      // The pacer asks this when it lets the request go. A job stood down while it waited never fetches.
      const outcome = await o.current.send(job.value, () => { if (!mayRun(token, gen.current)) return false; entry.started = true; return true; });
      if (current.current === entry) current.current = null;
      // Stood down: the same value (or a newer one) went by keepalive and that send settles it.
      if (!mayRun(token, gen.current)) return clean.current;
      return settle(outcome, job.value);
    });
    return line.current;
  }, [show, settle]);
  flushRef.current = flush;

  const schedule = useCallback((value: T) => {
    const waiting = pending.current;
    pending.current = { value: waiting && o.current.merge ? o.current.merge(waiting.value, value) : value };
    clean.current = false;
    clearTimeout(retryTimer.current);
    show({ phase: "dirty", message: "", retryable: false });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }, [flush, show]);

  /**
   * The tab was hidden or the box is going away: send what is unsent once, now. A value queued in the pacer has not been fetched yet, so it counts as unsent:
   * it goes by keepalive (joined with anything newer, the newer winning) and the queued job is stood down so it can never fetch after, and overwrite, it.
   */
  const sendOnLeave = useCallback(() => {
    const cur = current.current;
    const queued = cur && !cur.started ? cur.value : null;
    const started = cur && cur.started ? cur.value : null;
    const waiting = pending.current;
    if (!waiting && queued === null) return; // nothing unsent (a second event right after the first lands here)
    const unload = o.current.unload;
    const plan: UnloadPlan = unload ? unload.plan({ pending: waiting ? waiting.value : null, queued, started }) : { action: "paced" };
    if (plan.action === "paced") { void flush(); return; }
    clearTimeout(timer.current);
    clearTimeout(retryTimer.current);
    const value = combine(queued, waiting ? waiting.value : null, o.current.merge);
    pending.current = null;
    if (plan.supersede) { gen.current += 1; if (current.current === cur && !cur?.started) current.current = null; }
    if (plan.action === "none" || value === null) return; // the same thing is already on its way, and that send settles it
    const sent = { value, started: true };
    current.current = sent;
    void unload!.fire(plan).then((outcome) => {
      if (current.current === sent) current.current = null;
      settle(outcome, sent.value);
    });
  }, [flush, settle]);

  useEffect(() => {
    alive.current = true;
    const hide = () => { if (document.visibilityState === "hidden") sendOnLeave(); };
    const leave = () => sendOnLeave();
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
      clearTimeout(timer.current);
      clearTimeout(retryTimer.current);
      sendOnLeave(); // before `alive` goes false so a failed send still queues its retry state
      alive.current = false;
    };
  }, [sendOnLeave]);

  return { state, schedule, flush };
}

/** The short line under a box that says where its text stands. Read out politely, never takes focus. */
export function saveText(s: SaveState): string {
  if (s.phase === "dirty") return "Not saved yet";
  if (s.phase === "saving") return "Saving...";
  if (s.phase === "saved") return "Saved";
  return s.message;
}
