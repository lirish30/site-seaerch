import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { announceLeadsChanged } from "../Shell";
import { fullScanErrorText } from "../../promising";
import { actionErrorText, actionPath, withoutItem } from "../../todayView";
import type { TodaySummary, UsageRow } from "../../todayHome";
import type { LeadRow, TodayItem } from "../../types";
import { APPROVE_BATCH, type ApprovalItem, type SpendLevel } from "../../approvalsView";
import type { QueueStatus } from "../../queueView";
import type { HelperStatus } from "../../helperView";

/** One piece of the page: its data once loaded, or why it could not be. The pieces load and fail independently. */
export interface Part<T> { data: T | null; error: string }
const empty = <T,>(): Part<T> => ({ data: null, error: "" });
const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export interface LeadFacts { score: number | null; contactedAt: string | null }
export interface Money { name: string; limit: number; usage: UsageRow[] }
/** GET /api/spend: this month against the single cap, plus the fixed monthly costs. */
export interface Spend {
  month: string; variableUsd: number; fixedUsd: number; spentUsd: number; limitUsd: number; level: SpendLevel; ok: boolean;
  fixedCosts: { id: string; name: string; monthly_usd: number; active: 0 | 1 }[];
}
/** The quick-scan row's Run full scan button: request in flight, or accepted. */
export type ScanState = "starting" | "started";

/** Everything Home shows, from /today, /today/summary, /leads (for the score chips) and /settings (name and spend), plus the row actions. */
export function useHome() {
  const [items, setItems] = useState<Part<TodayItem[]>>(empty);
  const [summary, setSummary] = useState<Part<TodaySummary>>(empty);
  const [leads, setLeads] = useState<Part<Map<string, LeadFacts>>>(empty);
  const [money, setMoney] = useState<Part<Money>>(empty);
  const [approvals, setApprovals] = useState<Part<ApprovalItem[]>>(empty);
  const [spend, setSpend] = useState<Part<Spend>>(empty);
  const [queue, setQueue] = useState<Part<QueueStatus>>(empty);
  const [helper, setHelper] = useState<Part<HelperStatus>>(empty);
  const [approvalErrs, setApprovalErrs] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState(0);
  const [reloads, setReloads] = useState(0);
  // The per-row action errors live apart from the load errors, so reloading never wipes the message beside a button the user pressed.
  const [errs, setErrs] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [scans, setScans] = useState<Readonly<Record<string, ScanState>>>({});
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    const live = () => !cancelled && alive.current;
    const run = <T,>(get: () => Promise<T>, ok: (v: T) => void, fail: (m: string) => void, fallback: string) => {
      setPending((n) => n + 1);
      get().then((v) => { if (live()) ok(v); }).catch((e) => { if (live()) fail(msg(e, fallback)); })
        .finally(() => { if (alive.current) setPending((n) => n - 1); });
    };
    // A reload keeps what is on screen until the new data arrives; only the error is cleared.
    const keep = <T,>(set: (f: (p: Part<T>) => Part<T>) => void) => set((p) => ({ ...p, error: "" }));
    keep(setItems); keep(setSummary); keep(setLeads); keep(setMoney); keep(setApprovals); keep(setSpend); keep(setQueue); keep(setHelper);
    run(() => api.get<{ items: TodayItem[] }>("/today"), (r) => setItems({ data: r.items, error: "" }), (m) => setItems((p) => ({ ...p, error: m })), "Couldn't load your list.");
    run(() => api.get<TodaySummary>("/today/summary"), (r) => setSummary({ data: r, error: "" }), (m) => setSummary((p) => ({ ...p, error: m })), "Couldn't load your numbers.");
    run(() => api.get<LeadRow[]>("/leads?limit=500"), (rows) => setLeads({
      data: new Map(rows.map((r) => [r.business.id, { score: r.score, contactedAt: r.business.contacted_at }])), error: "" }),
      (m) => setLeads((p) => ({ ...p, error: m })), "Couldn't load scores.");
    run(() => api.get<{ settings: { your_name?: string; monthly_spend_limit_usd?: number }; usage: UsageRow[] }>("/settings"),
      (r) => setMoney({ data: { name: r.settings.your_name ?? "", limit: r.settings.monthly_spend_limit_usd ?? 0, usage: r.usage }, error: "" }),
      (m) => setMoney((p) => ({ ...p, error: m })), "Couldn't load this month's spend.");
    run(() => api.get<{ items: ApprovalItem[] }>("/approvals?status=pending"), (r) => setApprovals({ data: r.items, error: "" }),
      (m) => setApprovals((p) => ({ ...p, error: m })), "Couldn't load what's waiting for you.");
    run(() => api.get<Spend>("/spend"), (r) => setSpend({ data: r, error: "" }), (m) => setSpend((p) => ({ ...p, error: m })), "Couldn't load the spend level.");
    run(() => api.get<QueueStatus>("/queue"), (r) => setQueue({ data: r, error: "" }), (m) => setQueue((p) => ({ ...p, error: m })), "Couldn't load the Claude queue.");
    run(() => api.get<HelperStatus>("/helper/status"), (r) => setHelper({ data: r, error: "" }), (m) => setHelper((p) => ({ ...p, error: m })), "Couldn't load the Mac helper's state.");
    return () => { cancelled = true; };
  }, [reloads]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const mark = (id: string, on: boolean) => { if (alive.current) setBusy((b) => { const n = new Set(b); if (on) n.add(id); else n.delete(id); return n; }); };
  const clearErr = (id: string) => { if (alive.current) setErrs((e) => { const { [id]: _drop, ...rest } = e; return rest; }); };

  /** Done (hides the item for a week) or Snooze (for `days`): the row leaves the list, and the bell and sidebar counts refresh. */
  const act = useCallback(async (item: TodayItem, action: "done" | "snooze", days?: number) => {
    mark(item.id, true); clearErr(item.id);
    try {
      await api.post(actionPath(item, action), action === "snooze" ? { days } : undefined);
      if (alive.current) setItems((p) => (p.data ? { ...p, data: withoutItem(p.data, item.id) } : p));
      announceLeadsChanged();
    } catch (x) {
      if (alive.current) setErrs((e) => ({ ...e, [item.id]: actionErrorText(x, action) }));
    }
    mark(item.id, false);
  }, []);

  /** Run full scan on a quick-scanned lead. The row stays (marked as started) until the scan finishes and it drops off the queue. */
  const fullScan = useCallback(async (item: TodayItem) => {
    mark(item.id, true); clearErr(item.id);
    if (alive.current) setScans((s) => ({ ...s, [item.id]: "starting" }));
    try {
      await api.post(`/leads/${encodeURIComponent(item.businessId)}/full-scan`);
      if (alive.current) setScans((s) => ({ ...s, [item.id]: "started" }));
      announceLeadsChanged();
    } catch (x) {
      if (alive.current) {
        setScans((s) => { const { [item.id]: _drop, ...rest } = s; return rest; });
        setErrs((e) => ({ ...e, [item.id]: fullScanErrorText(x) }));
      }
    }
    mark(item.id, false);
  }, []);

  const dropApprovals = (ids: string[]) => {
    if (alive.current) setApprovals((p) => (p.data ? { ...p, data: p.data.filter((a) => !ids.includes(a.id)) } : p));
  };
  const setApprovalErr = (id: string, text: string | null) => {
    if (!alive.current) return;
    setApprovalErrs((e) => { const { [id]: _drop, ...rest } = e; return text ? { ...rest, [id]: text } : rest; });
  };

  /** Approve one item, optionally with an edited payload. On an error the item stays and shows the message. */
  const approveOne = useCallback(async (item: ApprovalItem, payload?: unknown) => {
    mark(item.id, true); setApprovalErr(item.id, null);
    try {
      await api.post(`/approvals/${encodeURIComponent(item.id)}/approve`, payload === undefined ? undefined : { payload });
      dropApprovals([item.id]); announceLeadsChanged();
    } catch (x) { setApprovalErr(item.id, msg(x, "Couldn't approve that. Try again.")); }
    mark(item.id, false);
  }, []);

  const rejectOne = useCallback(async (item: ApprovalItem, note: string) => {
    mark(item.id, true); setApprovalErr(item.id, null);
    try {
      await api.post(`/approvals/${encodeURIComponent(item.id)}/reject`, note.trim() ? { note: note.trim() } : undefined);
      dropApprovals([item.id]);
    } catch (x) { setApprovalErr(item.id, msg(x, "Couldn't reject that. Try again.")); }
    mark(item.id, false);
  }, []);

  /** Approve every item in a group (20 at a time, the API's limit). Failures stay in the list with their own message. */
  const approveAll = useCallback(async (group: ApprovalItem[]) => {
    const ids = group.map((a) => a.id);
    ids.forEach((id) => { mark(id, true); setApprovalErr(id, null); });
    try {
      for (let i = 0; i < ids.length; i += APPROVE_BATCH) {
        const r = await api.post<{ results: { id: string; ok: boolean; error?: string }[] }>("/approvals/approve-batch", { ids: ids.slice(i, i + APPROVE_BATCH) });
        dropApprovals(r.results.filter((x) => x.ok).map((x) => x.id));
        r.results.filter((x) => !x.ok).forEach((x) => setApprovalErr(x.id, x.error ?? "Couldn't approve that."));
      }
      announceLeadsChanged();
    } catch (x) {
      const text = msg(x, "Couldn't approve these. Try again.");
      ids.forEach((id) => setApprovalErr(id, text));
    }
    ids.forEach((id) => mark(id, false));
  }, []);

  return { approvals, spend, queue, helper, approvalErrs, approveOne, rejectOne, approveAll, items, summary, leads, money, loading: pending > 0, reload, act, fullScan, errs, busy, scans };
}
