import { useEffect, useRef, useState } from "react";
import Icon from "../Icon";
import { snoozeButtonLabel, snoozeLabel, SNOOZE_DAYS } from "../../todayView";

/** The clock button on a row: opens a small menu of 1, 3 and 7 days. Escape or a click elsewhere closes it. */
export default function SnoozeMenu({ name, disabled, onPick }: { name: string; disabled: boolean; onPick: (days: number) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const down = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = [...(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <span className="hm-snooze" ref={root}>
      <button ref={trigger} type="button" className="hm-icon-btn" aria-label={`Snooze ${name}`} aria-haspopup="menu" aria-expanded={open} title="Snooze" disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Icon name="clock" size={14} />
      </button>
      {open && (
        <div className="hm-menu" role="menu" aria-label={`Snooze ${name} for`}>
          <p>Snooze for</p>
          {SNOOZE_DAYS.map((d) => (
            <button key={d} type="button" role="menuitem" aria-label={snoozeLabel(name, d)} onClick={() => { setOpen(false); onPick(d); }}>{snoozeButtonLabel(d)}</button>
          ))}
        </div>
      )}
    </span>
  );
}
