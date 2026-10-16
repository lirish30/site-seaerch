import { useMemo, useRef, useState } from "react";
import { TYPE_GROUPS } from "../businessTypes";
import Icon from "../components/Icon";
import { CUSTOM_GROUP, TYPE_TOTAL, activeGroup, visibleGroups } from "../newSearchView";

interface Props { selected: string[]; onChange: (next: string[]) => void; }

/** Filter and add-your-own on top, the chosen types as pills, then a group list on the left and the active group's types on the right. */
export default function BusinessTypePicker({ selected, onChange }: Props) {
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState(TYPE_GROUPS[0].name);
  const [hint, setHint] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const chosen = useMemo(() => new Set(selected.map((t) => t.toLowerCase())), [selected]);
  const known = useMemo(() => new Set(TYPE_GROUPS.flatMap((g) => g.types.map((t) => t.toLowerCase()))), []);
  const custom = selected.filter((t) => !known.has(t.toLowerCase()));
  const groups = visibleGroups(custom, filter);
  const group = activeGroup(groups, picked);
  const q = filter.trim();

  const toggle = (t: string) =>
    onChange(chosen.has(t.toLowerCase()) ? selected.filter((x) => x.toLowerCase() !== t.toLowerCase()) : [...selected, t]);
  const setMany = (types: string[], on: boolean) => {
    const lower = new Set(types.map((t) => t.toLowerCase()));
    const rest = selected.filter((x) => !lower.has(x.toLowerCase()));
    onChange(on ? [...rest, ...types] : rest);
  };
  /** Adds what is typed in the filter box as a type of its own; with nothing typed it just points at the box. */
  function addCustom() {
    if (q.length < 2) { setHint(true); filterRef.current?.focus(); return; }
    if (!chosen.has(q.toLowerCase())) onChange([...selected, q]);
    setFilter(""); setHint(false);
    if (!known.has(q.toLowerCase())) setPicked(CUSTOM_GROUP);
  }

  const picks = (g: { name: string; types: string[] }) => g.types.filter((t) => chosen.has(t.toLowerCase())).length;
  const allOn = group ? picks(group) === group.types.length : false;

  return (
    <div className="ns-picker-wrap">
      <div className="ns-filter-row">
        <label className="ns-search">
          <Icon name="search" size={15} />
          <input ref={filterRef} type="search" aria-label="Filter business types" placeholder={`Filter ${TYPE_TOTAL} types…  e.g. school, law, repair`}
            value={filter} onChange={(e) => { setFilter(e.target.value); setHint(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (groups.length === 0) addCustom(); } }} />
        </label>
        <button type="button" className="btn" onClick={addCustom}><Icon name="plus" size={16} />Add custom type</button>
      </div>
      {hint && <p className="ns-hint" role="status">Type the business type in the box above, then choose Add custom type.</p>}

      {selected.length > 0 && (
        <div className="ns-selected" aria-live="polite">
          <span className="ns-selected-label">Selected</span>
          {selected.map((t) => (
            <button type="button" key={t} className="ns-pill" onClick={() => toggle(t)} aria-label={`Remove ${t}`}>{t}<Icon name="x" size={12} /></button>
          ))}
          <button type="button" className="ns-link" onClick={() => onChange([])}>Clear all</button>
        </div>
      )}

      <div className="ns-picker">
        <nav className="ns-groups" aria-label="Business type groups">
          {groups.map((g) => {
            const n = picks(g);
            const on = g.name === group?.name;
            return (
              <button type="button" aria-current={on ? "true" : undefined} key={g.name} className={`ns-group${on ? " on" : ""}`} onClick={() => setPicked(g.name)}>
                <span className="ns-group-name">{g.name}</span>
                {n > 0 && <span className="ns-group-picked" aria-label={`${n} selected`}>{n}</span>}
                <span className="ns-group-count">{g.types.length}</span>
              </button>
            );
          })}
        </nav>
        <div className="ns-types">
          {group ? (
            <>
              <div className="ns-types-head">
                <h3>{group.name}</h3>
                <button type="button" className="ns-link" onClick={() => setMany(group.types, !allOn)}>{allOn ? "Deselect all" : `Select all ${group.types.length}`}</button>
              </div>
              <div className="ns-chips">
                {group.types.map((t) => {
                  const on = chosen.has(t.toLowerCase());
                  return (
                    <button type="button" key={t} className={`ns-chip${on ? " on" : ""}`} aria-pressed={on} onClick={() => toggle(t)}>
                      {on && <Icon name="check" size={13} />}{t}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="ns-none">
              <p>No suggestions match “{filter}”.</p>
              <button type="button" className="ns-link" onClick={addCustom}>Add “{q}” as a custom type</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
