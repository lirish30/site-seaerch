import { useEffect, useRef, useState } from "react";
import { STAGE_LABEL } from "../leadView";
import Icon from "./Icon";
import { api, ApiError } from "../api";
import { bulkSummary, normalizeTag, undoSummary, UNDO_VISIBLE_MS, type BulkRequest } from "../bulkView";
import { STATUSES, type BulkResult, type LeadStatus, type UndoResult } from "../types";

// A 4xx carries a message written for the user; anything else (a 5xx, a dropped connection) gets the caller's plain wording.
const friendly = (e: unknown, fallback: string) => (e instanceof ApiError && e.status < 500 && e.message ? e.message : fallback);

/**
 * The selection bar: set status, star/unstar, archive/restore, tag. After an action it keeps an Undo button for 10 seconds.
 * A failed request shows its error here and leaves the selection as it was. There is no delete action.
 */
export default function BulkBar({ selected, archivedView = false, allStarred = false, onClear, onDone }: {
  selected: string[]; archivedView?: boolean; allStarred?: boolean; onClear: () => void;
  /** Called after a change landed (or was undone) so the page can reload its rows. */
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tag, setTag] = useState("");
  const [menu, setMenu] = useState<"stage" | "tag" | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  // The two small menus close on an outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => { if (bar.current && !bar.current.contains(e.target as Node)) setMenu(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [menu]);
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
        <div className="bulk-bar" ref={bar}>
          <button className="bar-check" aria-label="Clear selection" onClick={() => { onClear(); setErr(""); setMenu(null); }}><Icon name="check" size={12} /></button>
          <strong>{n} selected</strong>
          <span className="vr" aria-hidden="true" />
          <span className="bulk-menu">
            <button className="bulk-act" disabled={busy} aria-expanded={menu === "stage"} aria-haspopup="menu" onClick={() => setMenu(menu === "stage" ? null : "stage")}><Icon name="kanban" size={14} />Set stage</button>
            {menu === "stage" && (
              <div className="popover" role="menu" aria-label="Set stage">
                {STATUSES.map((s) => <button key={s} className="pop-item" role="menuitem" onClick={() => { setMenu(null); void run({ action: "status", status: s as LeadStatus }); }}>{STAGE_LABEL[s]}</button>)}
              </div>
            )}
          </span>
          <button className="bulk-act" disabled={busy} onClick={() => run({ action: allStarred ? "unstar" : "star" })}><Icon name="star" size={14} />{allStarred ? "Unstar" : "Star"}</button>
          <span className="bulk-menu">
            <button className="bulk-act" disabled={busy} aria-expanded={menu === "tag"} aria-haspopup="dialog" onClick={() => setMenu(menu === "tag" ? null : "tag")}><Icon name="tag" size={14} />Add tag</button>
            {menu === "tag" && (
              <div className="popover" role="dialog" aria-label="Tag the selected leads">
                <form onSubmit={(e) => { e.preventDefault(); if (cleanTag) { setMenu(null); void run({ action: "tag", tag: cleanTag }); } }}>
                  <input value={tag} maxLength={40} placeholder="tag" aria-label="Tag" autoFocus onChange={(e) => setTag(e.target.value)} disabled={busy} />
                  <button type="submit" className="btn sm primary" disabled={busy || !cleanTag} title={tag.trim() && !cleanTag ? "A tag is up to 32 letters, numbers, spaces, - or _" : undefined}>Add</button>
                  <button type="button" className="btn sm" disabled={busy || !cleanTag} onClick={() => { if (cleanTag) { setMenu(null); void run({ action: "untag", tag: cleanTag }); } }}>Remove</button>
                </form>
              </div>
            )}
          </span>
          <button className="bulk-act" disabled={busy} title={archivedView ? undefined : "Starred leads are left alone. Unstar them first to archive them."} onClick={() => run({ action: archivedView ? "restore" : "archive" })}><Icon name="copy" size={14} />{archivedView ? "Restore" : "Archive"}</button>
          <button className="bulk-clear" disabled={busy} onClick={() => { onClear(); setErr(""); setMenu(null); }}>Clear selection</button>
        </div>
      )}
      {err && <p className="bulk-note err" role="alert">{err}</p>}
      <div role="status">
        {note && (
          <div className="bulk-note">
            <span>{note.text}</span>
            {note.token && <button className="btn sm" onClick={undo} disabled={busy}>Undo</button>}
          </div>
        )}
      </div>
    </div>
  );
}
