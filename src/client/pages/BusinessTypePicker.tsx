import { useMemo, useState } from "react";
import { TYPE_GROUPS } from "../businessTypes";

interface Props { selected: string[]; onChange: (next: string[]) => void; }

export default function BusinessTypePicker({ selected, onChange }: Props) {
  const [filter, setFilter] = useState("");
  const [custom, setCustom] = useState("");
  const chosen = useMemo(() => new Set(selected.map((t) => t.toLowerCase())), [selected]);
  const q = filter.trim().toLowerCase();

  const known = useMemo(() => new Set(TYPE_GROUPS.flatMap((g) => g.types.map((t) => t.toLowerCase()))), []);
  const customSelected = selected.filter((t) => !known.has(t.toLowerCase()));

  const groups = TYPE_GROUPS
    .map((g) => ({ ...g, visible: q ? g.types.filter((t) => t.toLowerCase().includes(q)) : g.types }))
    .filter((g) => g.visible.length > 0);

  const toggle = (t: string) =>
    onChange(chosen.has(t.toLowerCase()) ? selected.filter((x) => x.toLowerCase() !== t.toLowerCase()) : [...selected, t]);
  const setMany = (types: string[], on: boolean) => {
    const lower = new Set(types.map((t) => t.toLowerCase()));
    const rest = selected.filter((x) => !lower.has(x.toLowerCase()));
    onChange(on ? [...rest, ...types] : rest);
  };
  function addCustom() {
    const t = custom.trim();
    if (t.length >= 2 && !chosen.has(t.toLowerCase())) onChange([...selected, t]);
    setCustom("");
  }

  return (
    <div className="picker">
      <div className="picker-tools">
        <input type="search" aria-label="Filter business types" placeholder="Filter types…  e.g. school, law, repair"
          value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="custom-add">
          <input aria-label="Add a custom business type" placeholder="Add your own type" value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }} />
          <button type="button" onClick={addCustom} disabled={custom.trim().length < 2}>Add</button>
        </div>
      </div>

      <div className="chips" aria-live="polite">
        {selected.length === 0
          ? <span className="muted">Nothing selected yet. Tick one or more types below.</span>
          : <>
              {selected.map((t) => (
                <button type="button" key={t} className="chip" onClick={() => toggle(t)} aria-label={`Remove ${t}`}>{t} <span aria-hidden>×</span></button>
              ))}
              <button type="button" className="link-btn" onClick={() => onChange([])}>Clear all</button>
            </>}
      </div>

      <div className="groups">
        {customSelected.length > 0 && (
          <section className="group">
            <h4>Custom</h4>
            <div className="type-grid">
              {customSelected.map((t) => <TypeCard key={t} label={t} on onToggle={() => toggle(t)} />)}
            </div>
          </section>
        )}
        {groups.map((g) => {
          const n = g.visible.filter((t) => chosen.has(t.toLowerCase())).length;
          const all = n === g.visible.length;
          return (
            <section className="group" key={g.name}>
              <div className="group-head">
                <h4>{g.name}{n > 0 && <span className="count">{n}</span>}</h4>
                <button type="button" className="link-btn" onClick={() => setMany(g.visible, !all)}>{all ? "Clear" : "Select all"}</button>
              </div>
              <div className="type-grid">
                {g.visible.map((t) => <TypeCard key={t} label={t} on={chosen.has(t.toLowerCase())} onToggle={() => toggle(t)} />)}
              </div>
            </section>
          );
        })}
        {groups.length === 0 && <p className="muted">No suggestions match “{filter}”. Add it as a custom type above.</p>}
      </div>
    </div>
  );
}

function TypeCard({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <label className={`type-card${on ? " on" : ""}`}>
      <input type="checkbox" checked={on} onChange={onToggle} />
      <span>{label}</span>
    </label>
  );
}
