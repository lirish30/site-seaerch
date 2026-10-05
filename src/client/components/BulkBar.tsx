import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { bulkSummary, normalizeTag, undoSummary, UNDO_VISIBLE_MS, type BulkRequest } from "../bulkView";
import { STATUSES, type BulkResult, type LeadStatus, type UndoResult } from "../types";

// A 4xx carries a message written for the user; anything else (a 5xx, a dropped connection) gets the caller's plain wording.
const friendly = (e: unknown, fallback: string) => (e instanceof ApiError && e.status < 500 && e.message ? e.message : fallback);

/**
 * The selection bar: set status, archive/restore, tag. After an action it keeps an Undo button for 10 seconds.
 * A failed request shows its error here and leaves the selection as it was. There is no delete action.
 */
export default function BulkBar({ selected, archivedView = false, onClear, onDone }: {
  selected: string[]; archivedView?: boolean; onClear: () => void;
  /** Called after a change landed (or was undone) so the page can reload its rows. */
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tag, setTag] = useState("");
  const [note, setNote] = useState<{ text: string; token: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // The banner (and its Undo) goes away on its own; the timer is cleared on unmount and whenever a newer note replaces it.
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), note.token ? UNDO_VISIBLE_MS : 4000);
    return () => clearTimeout(t);
  }, [note]);

  // The page reports its own load errors; a failed refresh must not read as a failed action.
  const refresh = async () => { try { await onDone(); } catch { /* ignored */ } };

  const run = async (req: BulkRequest) => {
    if (busy || !selected.length) return;
    setBusy(true); setErr("");
    try {
      const r = await api.post<BulkResult>("/leads/bulk", { ids: selected, ...req });
      if (!alive.current) return;
      setNote({ text: bulkSummary(req, r), token: r.undoToken });
      if (r.updated) onClear();
      await refresh();
    } catch (e) {
      if (alive.current) setErr(friendly(e, "Couldn't apply that. Nothing was changed; your selection is still here. Try again."));
    } finally { if (alive.current) setBusy(false); }
  };

  const undo = async () => {
    const token = note?.token;
    if (!token || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await api.post<UndoResult>("/leads/bulk/undo", { undoToken: token });
      if (!alive.current) return;
      setNote({ text: undoSummary(r), token: null });
      await refresh();
    } catch (e) {
      if (alive.current) { setNote(null); setErr(friendly(e, "Couldn't undo that. Try again.")); }
    } finally { if (alive.current) setBusy(false); }
  };

  const n = selected.length;
  const cleanTag = normalizeTag(tag);
  if (!n && !note && !err) return null;
  return (
    <div className="bulk" role="region" aria-label="Bulk actions">
      {n > 0 && (
        <div className="bulk-bar">
          <strong>{n} selected</strong>
          <select aria-label="Set status" value="" disabled={busy} onChange={(e) => { if (e.target.value) void run({ action: "status", status: e.target.value as LeadStatus }); }}>
            <option value="">Set status…</option>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button disabled={busy} onClick={() => run({ action: archivedView ? "restore" : "archive" })}>{archivedView ? "Restore" : "Archive"}</button>
          <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); if (cleanTag) void run({ action: "tag", tag: cleanTag }); }}>
            <input className="bulk-tag" value={tag} maxLength={40} placeholder="tag" aria-label="Tag" onChange={(e) => setTag(e.target.value)} disabled={busy} />
            <button type="submit" disabled={busy || !cleanTag} title={tag.trim() && !cleanTag ? "A tag is up to 32 letters, numbers, spaces, - or _" : undefined}>Add tag</button>
            <button type="button" disabled={busy || !cleanTag} onClick={() => cleanTag && run({ action: "untag", tag: cleanTag })}>Remove tag</button>
          </form>
          <button className="link-btn" disabled={busy} onClick={() => { onClear(); setErr(""); }}>Clear selection</button>
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      <div role="status">
        {note && (
          <div className="notice bulk-note">
            <span>{note.text}</span>
            {note.token && <button onClick={undo} disabled={busy}>Undo</button>}
          </div>
        )}
      </div>
    </div>
  );
}
