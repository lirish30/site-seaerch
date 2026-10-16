import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { notifySettingsChanged } from "../settingsData";
import { activeCount, visibleServices } from "../settingsView";
import { fromLines, groupByCategory, toLines } from "../services";
import type { Service } from "../types";
import Icon from "./Icon";
import { Toggle } from "./settingsBits";

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** The service catalog and its load error. Edits go through `patch`, which swaps the saved row in. */
export function useServices(enabled = true) {
  const [services, setServices] = useState<Service[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!enabled) return;
    api.get<Service[]>("/services").then((r) => { if (alive.current) setServices(r); })
      .catch((e) => { if (alive.current) setLoadErr(errText(e, "Couldn't load services.")); });
  }, [enabled]);
  return { services, setServices, loadErr, alive };
}
export type ServicesState = ReturnType<typeof useServices>;

/** Details form with its own draft: a failed save keeps what was typed and says why. */
function ServiceDetails({ s, onSave, onCancel }: { s: Service; onSave: (patch: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [summary, setSummary] = useState(s.summary);
  const [deliverables, setDeliverables] = useState(toLines(s.deliverables));
  const [prerequisites, setPrerequisites] = useState(toLines(s.prerequisites));
  const [first, setFirst] = useState(s.first_engagement ?? "");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [saved, setSaved] = useState(false);
  const id = `svc-${s.id}`;
  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setSaved(false); setErr(""); };
  async function save() {
    setBusy(true); setErr(""); setSaved(false);
    try {
      await onSave({ summary, deliverables: fromLines(deliverables), prerequisites: fromLines(prerequisites), first_engagement: first.trim() || null });
      setSaved(true);
    } catch (e) { setErr(`Couldn't save: ${errText(e, "request failed")}`); }
    finally { setBusy(false); }
  }
  return (
    <div className="sv-details" id={`${id}-panel`}>
      <div className="bx-f"><label className="fl" htmlFor={`${id}-sum`}>Summary</label>
        <input id={`${id}-sum`} className="in" value={summary} onChange={(e) => touch(setSummary)(e.target.value)} /></div>
      <div className="bx-two">
        <div className="bx-f"><label className="fl" htmlFor={`${id}-del`}>Deliverables (one per line)</label>
          <textarea id={`${id}-del`} className="in" rows={4} value={deliverables} onChange={(e) => touch(setDeliverables)(e.target.value)} /></div>
        <div className="bx-f"><label className="fl" htmlFor={`${id}-pre`}>Needs from the client (one per line)</label>
          <textarea id={`${id}-pre`} className="in" rows={4} value={prerequisites} onChange={(e) => touch(setPrerequisites)(e.target.value)} /></div>
      </div>
      <div className="bx-f"><label className="fl" htmlFor={`${id}-first`}>First engagement</label>
        <input id={`${id}-first`} className="in" value={first} placeholder="The small first project you would pitch" onChange={(e) => touch(setFirst)(e.target.value)} /></div>
      <div className="bx-acts">
        <button type="button" className="btn primary sm" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save service"}</button>
        <button type="button" className="btn-ghost-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        {saved && <span className="bx-ok" role="status">Saved</span>}
        {err && <span className="bx-err" role="alert">{err}</span>}
      </div>
    </div>
  );
}

/** The "Add service" panel: name, category (existing ones suggested) and a one-line summary. */
function AddService({ categories, onAdded, onCancel, alive }: { categories: string[]; onAdded: (s: Service) => void; onCancel: () => void; alive: { current: boolean } }) {
  const [draft, setDraft] = useState({ name: "", category: "", summary: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const set = (k: keyof typeof draft) => (e: { target: { value: string } }) => { setDraft((d) => ({ ...d, [k]: e.target.value })); setErr(""); };
  async function add() {
    if (!draft.name.trim()) { setErr("Give the service a name."); return; }
    setBusy(true); setErr("");
    try {
      const body = { name: draft.name, summary: draft.summary, ...(draft.category.trim() ? { category: draft.category } : {}) };
      const created = await api.post<Service>("/services", body);
      if (alive.current) onAdded(created);
    } catch (e) { if (alive.current) setErr(`Couldn't add: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setBusy(false); }
  }
  return (
    <div className="sv-add">
      <div className="bx-two">
        <div className="bx-f"><label className="fl" htmlFor="svc-new-name">Name</label>
          <input id="svc-new-name" className="in" autoFocus value={draft.name} onChange={set("name")} onKeyDown={(e) => { if (e.key === "Enter" && !busy) void add(); }} /></div>
        <div className="bx-f"><label className="fl" htmlFor="svc-new-cat">Category</label>
          <input id="svc-new-cat" className="in" list="svc-cats" placeholder="Other" value={draft.category} onChange={set("category")} />
          <datalist id="svc-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist></div>
      </div>
      <div className="bx-f"><label className="fl" htmlFor="svc-new-sum">Summary</label>
        <input id="svc-new-sum" className="in" value={draft.summary} onChange={set("summary")} onKeyDown={(e) => { if (e.key === "Enter" && !busy) void add(); }} /></div>
      <div className="bx-acts">
        <button type="button" className="btn primary sm" onClick={add} disabled={busy}>{busy ? "Adding…" : "Add service"}</button>
        <button type="button" className="btn-ghost-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        {err && <span className="bx-err" role="alert">{err}</span>}
      </div>
    </div>
  );
}

/**
 * Every service, by category: search, "Active only", per-row Specialty and Active switches, and an inline editor.
 * The Services page passes its own `sv` (so the header can show counts and the Add button); alone, the editor loads the list itself.
 */
export default function ServicesEditor({ sv: lifted, adding = false, onCloseAdd = () => {} }: { sv?: ServicesState; adding?: boolean; onCloseAdd?: () => void }) {
  const own = useServices(!lifted);
  const { services, setServices, loadErr, alive } = lifted ?? own;
  const [q, setQ] = useState(""); const [activeOnly, setActiveOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [cats, setCats] = useState<Set<string> | null>(null); // null: the first two categories are open
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState("");

  const replace = (u: Service) => setServices((cur) => cur && cur.map((x) => (x.id === u.id ? u : x)));
  async function patch(s: Service, body: Record<string, unknown>) {
    const u = await api.patch<Service>(`/services/${s.id}`, body);
    if (alive.current) { replace(u); setRowErr((r) => ({ ...r, [s.id]: "" })); notifySettingsChanged(); }
  }
  // Toggles apply on click; if the request fails the switch snaps back and the row says why.
  async function toggle(s: Service, field: "active" | "is_specialty") {
    setRowErr((r) => ({ ...r, [s.id]: "" })); setBusyId(s.id);
    try { await patch(s, { [field]: !s[field] }); }
    catch (e) { if (alive.current) setRowErr((r) => ({ ...r, [s.id]: `Couldn't update ${s.name}: ${errText(e, "request failed")}` })); }
    finally { if (alive.current) setBusyId(""); }
  }

  if (!services) return loadErr ? <p className="bx-err" role="alert">{loadErr}</p> : <p className="bx-muted">Loading…</p>;
  const groups = visibleServices(services, q, activeOnly);
  const searching = q.trim() !== "";
  const allCats = groupByCategory(services).map((g) => g.category);
  const isOpen = (cat: string) => searching || (cats ? cats.has(cat) : allCats.indexOf(cat) < 2);
  const toggleCat = (cat: string) => setCats((cur) => { const n = new Set(cur ?? allCats.slice(0, 2)); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; });

  return (
    <div className="sv">
      {adding && <AddService categories={allCats} alive={alive} onCancel={onCloseAdd}
        onAdded={(s) => { setServices((cur) => [...(cur ?? []), s]); setCats((cur) => new Set([...(cur ?? allCats.slice(0, 2)), s.category])); setOpenId(s.id); onCloseAdd(); notifySettingsChanged(); }} />}
      <div className="sv-tools">
        <label className="sv-search">
          <Icon name="search" size={14} />
          <input type="search" placeholder={`Search ${services.length} services…`} aria-label="Search services" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <Toggle checked={activeOnly} onChange={setActiveOnly} label="Active only"><span className="sv-lbl">Active only</span></Toggle>
      </div>
      {loadErr && <p className="bx-err" role="alert">{loadErr}</p>}
      {!services.length && <p className="bx-empty">No services yet. Use “Add service” to list what you sell.</p>}
      {services.length > 0 && !groups.length && <p className="bx-empty">{searching ? `No services match “${q.trim()}”.` : "No active services. Turn one on, or switch off “Active only”."}</p>}
      {groups.map((g) => {
        const open = isOpen(g.category);
        return (
          <section key={g.category} className={`sv-cat${open ? " open" : ""}`}>
            <button type="button" className="sv-cat-head" aria-expanded={open} onClick={() => toggleCat(g.category)} disabled={searching}>
              <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
              <span className="n">{g.category}</span>
              <span className="c">{activeCount(g.all)} of {g.all.length} active</span>
            </button>
            {open && (
              <div className="sv-list">
                {g.services.map((s) => {
                  const expanded = openId === s.id;
                  return (
                    <div key={s.id} className={`sv-row${s.active ? "" : " off"}${expanded ? " open" : ""}`}>
                      <div className="sv-line" onClick={(e) => { if (!(e.target as HTMLElement).closest("label,input,button")) setOpenId(expanded ? null : s.id); }}>
                        <button type="button" className="sv-name" aria-expanded={expanded} aria-controls={`svc-${s.id}-panel`} onClick={() => setOpenId(expanded ? null : s.id)}>
                          <span className="n">{s.name}</span>{s.is_specialty && <span className="badge2 signal">Specialty</span>}
                        </button>
                        <label className="sv-spec"><input type="checkbox" className="cb" checked={s.is_specialty} disabled={busyId === s.id} onChange={() => void toggle(s, "is_specialty")} aria-label={`Specialty: ${s.name}`} />Specialty</label>
                        <Toggle checked={s.active} onChange={() => void toggle(s, "active")} disabled={busyId === s.id} label={`Active: ${s.name}`}><span className="sv-lbl">{s.active ? "Active" : "Off"}</span></Toggle>
                        <button type="button" className="sv-chev" aria-label={`${expanded ? "Close" : "Edit"} ${s.name}`} tabIndex={-1} onClick={() => setOpenId(expanded ? null : s.id)}><Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} /></button>
                      </div>
                      {rowErr[s.id] && <p className="bx-err sv-rowerr" role="alert">{rowErr[s.id]}</p>}
                      {expanded && <ServiceDetails s={s} onSave={(b) => patch(s, b)} onCancel={() => setOpenId(null)} />}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
