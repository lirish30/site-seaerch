import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { SavedFilter } from "../types";

// A 4xx carries a message written for the user; anything else (a 5xx, a dropped connection) gets the caller's plain wording.
const friendly = (e: unknown, fallback: string) => (e instanceof ApiError && e.status < 500 && e.message ? e.message : fallback);

/** Save the current filters under a name, apply a saved set, or delete one. `current` is the serialized filter state ("" when nothing is set). */
export default function SavedFilters({ current, onApply }: { current: string; onApply: (query: string) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SavedFilter[] | null>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    api.get<SavedFilter[]>("/leads/filters").then((r) => { if (!dead) setItems(r); })
      .catch((e) => { if (!dead) { setItems([]); setErr(friendly(e, "Couldn't load saved filters.")); } });
    return () => { dead = true; };
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true); setErr("");
    try {
      const f = await api.post<SavedFilter>("/leads/filters", { name: name.trim(), query: current });
      setItems((xs) => [f, ...(xs ?? [])]); setName("");
    } catch (e2) { setErr(friendly(e2, "Couldn't save that filter. Try again.")); }
    finally { setBusy(false); }
  };
  const remove = async (f: SavedFilter) => {
    if (busy) return;
    setBusy(true); setErr("");
    try { await api.del(`/leads/filters/${f.id}`); setItems((xs) => (xs ?? []).filter((x) => x.id !== f.id)); }
    catch (e2) {
      if (e2 instanceof ApiError && e2.status === 404) setItems((xs) => (xs ?? []).filter((x) => x.id !== f.id)); // already gone
      else setErr(friendly(e2, "Couldn't delete that filter. Try again."));
    } finally { setBusy(false); }
  };

  return (
    <div className="saved-filters">
      <button aria-expanded={open} aria-controls="saved-filters-panel" onClick={() => setOpen((o) => !o)}>Saved filters{items?.length ? ` (${items.length})` : ""}</button>
      {open && (
        <div id="saved-filters-panel" className="saved-panel" role="group" aria-label="Saved filters" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
          {items === null ? <p className="muted small">Loading…</p> : items.length === 0 ? <p className="muted small">No saved filters yet.</p> : (
            <ul>
              {items.map((f) => (
                <li key={f.id}>
                  <button className="link-btn" disabled={busy} onClick={() => { onApply(f.query); setOpen(false); }} title={f.query || "No filters"}>{f.name}</button>
                  <button className="link-btn danger" disabled={busy} aria-label={`Delete saved filter ${f.name}`} onClick={() => remove(f)}>Delete</button>
                </li>
              ))}
            </ul>
          )}
          <form className="row" onSubmit={save}>
            <input value={name} maxLength={60} placeholder="Name this filter" aria-label="Saved filter name" onChange={(e) => setName(e.target.value)} />
            <button type="submit" disabled={busy || !name.trim() || !current} title={current ? "" : "Set at least one filter first"}>Save current filters</button>
          </form>
          {err && <p className="error small" role="alert">{err}</p>}
        </div>
      )}
      {!open && err && <p className="error small" role="alert">{err}</p>}
    </div>
  );
}
