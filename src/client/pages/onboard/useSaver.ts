import { useCallback, useEffect, useRef, useState } from "react";
import { AUTOSAVE_MS, type Outcome } from "../../onboardView";

export interface SaveState {
  phase: "idle" | "dirty" | "saving" | "saved" | "error";
  message: string;
  /** An error that will go away by trying again (a dropped connection, a busy server), so a "Try again" button makes sense. */
  retryable: boolean;
}

export interface SaverOptions<T> {
  /** Sends a value and says how it went. Never throws. */
  send: (value: T) => Promise<Outcome>;
  /** Joins a value waiting to go with a newer one (answers add up; text is replaced). Default: the newer one wins. */
  merge?: (older: T, newer: T) => T;
  onSaved?: () => void;
  onLocked?: () => void;
  onGone?: () => void;
}

const IDLE: SaveState = { phase: "idle", message: "", retryable: false };

/**
 * Debounced autosave for one box. `schedule` keeps the latest value and sends it once typing has paused for AUTOSAVE_MS, never once per keystroke; `flush`
 * sends right away (on blur, on submit, when the tab is hidden or the box goes away) and resolves true when nothing is left unsaved. Sends never overlap, a value
 * that could not be sent for a passing reason goes back in the queue and is tried again after a wait that grows, and a refusal is shown and not retried.
 */
export function useSaver<T>(opts: SaverOptions<T>): { state: SaveState; schedule: (v: T) => void; flush: () => Promise<boolean> } {
  const o = useRef(opts);
  o.current = opts;
  const [state, setState] = useState<SaveState>(IDLE);
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const line = useRef<Promise<boolean>>(Promise.resolve(true));
  const clean = useRef(true);
  const failures = useRef(0);
  const alive = useRef(true);
  const show = useCallback((s: SaveState) => { if (alive.current) setState(s); }, []);

  const flush = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current);
    clearTimeout(retryTimer.current);
    line.current = line.current.then(async () => {
      const job = pending.current;
      if (!job) return clean.current;
      pending.current = null;
      show({ phase: "saving", message: "Saving...", retryable: false });
      const outcome = await o.current.send(job.value);
      if (outcome.kind === "ok") {
        failures.current = 0;
        clean.current = true;
        show((pending.current as { value: T } | null) ? { phase: "dirty", message: "", retryable: false } : { phase: "saved", message: "Saved", retryable: false });
        o.current.onSaved?.();
        return true;
      }
      clean.current = false;
      if (outcome.kind === "retry") {
        // Put it back (joined with anything typed meanwhile) and try again later.
        const newer = pending.current as { value: T } | null; // typed during the send
        pending.current = { value: newer && o.current.merge ? o.current.merge(job.value, newer.value) : newer ? newer.value : job.value };
        failures.current += 1;
        show({ phase: "error", message: outcome.message, retryable: true });
        if (alive.current) retryTimer.current = setTimeout(() => void flush(), outcome.afterMs * Math.min(failures.current, 4));
      } else if (outcome.kind === "locked") {
        show({ phase: "error", message: outcome.message, retryable: false });
        o.current.onLocked?.();
      } else if (outcome.kind === "gone") {
        o.current.onGone?.();
      } else {
        show({ phase: "error", message: outcome.message, retryable: false });
      }
      return false;
    });
    return line.current;
  }, [show]);

  const schedule = useCallback((value: T) => {
    const waiting = pending.current;
    pending.current = { value: waiting && o.current.merge ? o.current.merge(waiting.value, value) : value };
    clean.current = false;
    clearTimeout(retryTimer.current);
    show({ phase: "dirty", message: "", retryable: false });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }, [flush, show]);

  // Leaving the tab or the page: send what is waiting rather than lose it.
  useEffect(() => {
    alive.current = true;
    const hide = () => { if (document.visibilityState === "hidden" && pending.current) void flush(); };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", hide);
      alive.current = false;
      clearTimeout(retryTimer.current);
      if (pending.current) void flush();
      clearTimeout(timer.current);
    };
  }, [flush]);

  return { state, schedule, flush };
}

/** The short line under a box that says where its text stands. Read out politely, never takes focus. */
export function saveText(s: SaveState): string {
  if (s.phase === "dirty") return "Not saved yet";
  if (s.phase === "saving") return "Saving...";
  if (s.phase === "saved") return "Saved";
  return s.message;
}
