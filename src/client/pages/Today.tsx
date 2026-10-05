import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import type { TodayItem } from "../types";
import { actionErrorText, actionPath, doneLabel, dueLabel, snoozeButtonLabel, snoozeLabel, SNOOZE_DAYS, TODAY_KIND_LABEL, withoutItem } from "../todayView";

export default function Today() {
  const [items, setItems] = useState<TodayItem[] | null>(null);
  // The load error and the per-item action errors are separate, so reloading never wipes the message from a button the user pressed.
  const [loadErr, setLoadErr] = useState("");
  const [errs, setErrs] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [reloads, setReloads] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadErr("");
    api.get<{ items: TodayItem[] }>("/today")
      .then((r) => { if (!cancelled && alive.current) setItems(r.items); })
      .catch((e) => { if (!cancelled && alive.current) setLoadErr(e instanceof ApiError ? e.message : "Couldn't load today's list."); });
    return () => { cancelled = true; };
  }, [reloads]);

  const mark = (id: string, on: boolean) => { if (alive.current) setBusy((b) => { const n = new Set(b); on ? n.add(id) : n.delete(id); return n; }); };
  const act = useCallback(async (item: TodayItem, action: "done" | "snooze", days?: number) => {
    mark(item.id, true);
    if (alive.current) setErrs((e) => { const { [item.id]: _drop, ...rest } = e; return rest; });
    try {
      await api.post(actionPath(item, action), action === "snooze" ? { days } : undefined);
      if (alive.current) setItems((cur) => (cur ? withoutItem(cur, item.id) : cur));
    } catch (x) {
      if (alive.current) setErrs((e) => ({ ...e, [item.id]: actionErrorText(x, action) }));
    }
    mark(item.id, false);
  }, []);

  return (
    <div>
      <div className="row between page-head">
        <h2>Today</h2>
        <button onClick={() => setReloads((n) => n + 1)}>Refresh</button>
      </div>
      <p className="muted">
        What needs you next: follow-ups that are due, drafts you haven't sent, deals that went quiet, and quick-scanned leads worth a full scan.
        Done hides an item for a week; Snooze hides it for as long as you choose.
      </p>
      {loadErr && <p className="error" role="alert">{loadErr}</p>}
      {!items ? (loadErr ? null : <p role="status">Loading…</p>) : items.length === 0 ? (
        <div className="card"><p role="status">Nothing due</p></div>
      ) : (
        <ul className="today-list" aria-label="Today's items">
          {items.map((it) => {
            const isBusy = busy.has(it.id), due = dueLabel(it.due);
            return (
              <li key={it.id} className="card today-item">
                <div className="today-main">
                  <div className="row">
                    <span className={`badge today-kind ${it.kind}`}>{TODAY_KIND_LABEL[it.kind]}</span>
                    <Link to={`/leads/${it.businessId}`} title={it.businessName}><strong>{it.businessName}</strong></Link>
                    {due && <span className="muted small">{due}</span>}
                  </div>
                  <p className="today-reason">{it.reason}</p>
                  {errs[it.id] && <p className="error small" role="alert">{errs[it.id]}</p>}
                </div>
                <div className="today-actions row">
                  <button className="primary" aria-label={doneLabel(it.businessName)} disabled={isBusy} onClick={() => act(it, "done")}>Done</button>
                  <span className="muted small" aria-hidden="true">Snooze</span>
                  {SNOOZE_DAYS.map((d) => (
                    <button key={d} aria-label={snoozeLabel(it.businessName, d)} disabled={isBusy} onClick={() => act(it, "snooze", d)}>{snoozeButtonLabel(d)}</button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
