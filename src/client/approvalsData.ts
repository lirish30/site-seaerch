import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { announceLeadsChanged } from "./components/Shell";
import { APPROVE_BATCH, canBulkApprove, type ApprovalItem } from "./approvalsView";

/**
 * The Approvals page's data: the pending list plus approve, reject and approve-many. The calls and their rules are the same as the Home
 * card's (useHome): one approve with an optional edited payload, a reject with an optional note, and batches of APPROVE_BATCH through
 * /approvals/approve-batch that only ever carry kinds canBulkApprove allows. A failure leaves the item in the list with its message.
 */
export interface ApprovalsState { items: ApprovalItem[] | null; error: string; loading: boolean }

const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function useApprovals() {
  const [state, setState] = useState<ApprovalsState>({ items: null, error: "", loading: true });
  const [errs, setErrs] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [reloads, setReloads] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, error: "", loading: true }));
    api.get<{ items: ApprovalItem[] }>("/approvals?status=pending")
      .then((r) => { if (live) setState({ items: Array.isArray(r.items) ? r.items : [], error: "", loading: false }); })
      .catch((e) => { if (live) setState((s) => ({ ...s, error: msg(e, "Couldn't load what's waiting for you."), loading: false })); });
    return () => { live = false; };
  }, [reloads]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const mark = (id: string, on: boolean) => { if (alive.current) setBusy((b) => { const n = new Set(b); if (on) n.add(id); else n.delete(id); return n; }); };
  const setErr = (id: string, text: string | null) => {
    if (!alive.current) return;
    setErrs((e) => { const { [id]: _drop, ...rest } = e; return text ? { ...rest, [id]: text } : rest; });
  };
  const drop = (ids: string[]) => { if (alive.current) setState((s) => (s.items ? { ...s, items: s.items.filter((a) => !ids.includes(a.id)) } : s)); };

  /** Approve one item, with the edited payload when there is one. True when it went through. */
  const approveOne = useCallback(async (item: ApprovalItem, payload?: unknown): Promise<boolean> => {
    mark(item.id, true); setErr(item.id, null);
    let ok = false;
    try {
      await api.post(`/approvals/${encodeURIComponent(item.id)}/approve`, payload === undefined ? undefined : { payload });
      drop([item.id]); announceLeadsChanged(); ok = true;
    } catch (x) { setErr(item.id, msg(x, "Couldn't approve that. Try again.")); }
    mark(item.id, false);
    return ok;
  }, []);

  /** Reject one item with an optional note. True when it went through. */
  const rejectOne = useCallback(async (item: ApprovalItem, note: string): Promise<boolean> => {
    mark(item.id, true); setErr(item.id, null);
    let ok = false;
    try {
      await api.post(`/approvals/${encodeURIComponent(item.id)}/reject`, note.trim() ? { note: note.trim() } : undefined);
      drop([item.id]); ok = true;
    } catch (x) { setErr(item.id, msg(x, "Couldn't reject that. Try again.")); }
    mark(item.id, false);
    return ok;
  }, []);

  /** Approve many at once (Approve all, Approve selected). Kinds that must be opened one by one are skipped, never sent in a batch. */
  const approveMany = useCallback(async (items: ApprovalItem[]) => {
    const ids = items.filter((a) => canBulkApprove(a.kind)).map((a) => a.id);
    ids.forEach((id) => { mark(id, true); setErr(id, null); });
    try {
      for (let i = 0; i < ids.length; i += APPROVE_BATCH) {
        const r = await api.post<{ results: { id: string; ok: boolean; error?: string }[] }>("/approvals/approve-batch", { ids: ids.slice(i, i + APPROVE_BATCH) });
        drop(r.results.filter((x) => x.ok).map((x) => x.id));
        r.results.filter((x) => !x.ok).forEach((x) => setErr(x.id, x.error ?? "Couldn't approve that."));
      }
      announceLeadsChanged();
    } catch (x) {
      const text = msg(x, "Couldn't approve these. Try again.");
      ids.forEach((id) => setErr(id, text));
    }
    ids.forEach((id) => mark(id, false));
  }, []);

  return { ...state, errs, busy, reload, approveOne, rejectOne, approveMany };
}
