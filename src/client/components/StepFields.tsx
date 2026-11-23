/** Shared pieces of the SOP step editors (the template editor and a project's SOP tab). */

/** An on/off switch with its words: what it is, then what it means. */
export function SwitchRow({ checked, onChange, label, help }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string }) {
  return (
    <label className="ds-switch-row">
      <span className="ds-switch-text"><b>{label}</b>{help && <small>{help}</small>}</span>
      <span className="switch"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><i /></span>
    </label>
  );
}

/** "Waits for": every other step as a chip you can switch on, so a dependency is one click and you can see them all. */
export function WaitsFor({ options, value, onChange }: { options: { key: string; title: string }[]; value: string[]; onChange: (next: string[]) => void }) {
  return (
    <fieldset className="ds-waits">
      <legend className="ds-label">Waits for {value.length === 0 ? <span className="ds-help">nothing: it can start straight away</span> : <span className="ds-help">{value.length} {value.length === 1 ? "step" : "steps"} to finish first</span>}</legend>
      {options.length === 0 ? <p className="ds-help">There are no other steps yet.</p> : (
        <div className="ds-waits-list">
          {options.map((o) => {
            const on = value.includes(o.key);
            return (
              <button key={o.key} type="button" className="ds-wait" aria-pressed={on} onClick={() => onChange(on ? value.filter((k) => k !== o.key) : [...value, o.key])}>
                <span className="ds-wait-key">{o.key}</span>{o.title || "Untitled step"}
              </button>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
