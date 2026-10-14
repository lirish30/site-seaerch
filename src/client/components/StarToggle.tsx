/** The ★ button that stars or unstars a lead. It only reports the click; the caller makes the request and owns `busy`. */
export default function StarToggle({ on, name, busy = false, onClick }: { on: boolean; name: string; busy?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`star-btn${on ? " on" : ""}`} aria-pressed={on} disabled={busy}
      aria-label={on ? `Unstar ${name}` : `Star ${name}`} title={on ? "Starred. Click to unstar." : "Star this lead so you can find it again"}
      onClick={onClick}>{on ? "★" : "☆"}</button>
  );
}
