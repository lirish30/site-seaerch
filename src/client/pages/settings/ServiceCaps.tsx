import { useState } from "react";
import { api, ApiError } from "../../api";
import { Card } from "../../components/SettingsPage";
import { levelWord, parseCapInput, serviceCapLine, serviceLabel, type ServiceSpend } from "../../spendView";

type Result = { text: string; bad: boolean } | null;

/** One service: its spend against its cap, and a box to change the cap (empty removes it). */
function CapRow({ s, onSaved, onResult }: { s: ServiceSpend; onSaved: (services: ServiceSpend[]) => void; onResult: (r: Result) => void }) {
  const saved = s.capUsd === null ? "" : String(s.capUsd);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = `cap-${s.service}`;
  const label = serviceLabel(s.service);

  async function save() {
    const p = parseCapInput(draft);
    if (!p.ok) { setError(p.error); return; }
    setError(""); setBusy(true); onResult(null);
    try {
      const r = await api.put<{ services: ServiceSpend[] }>(`/spend/caps/${s.service}`, { monthlyUsd: p.value });
      onSaved(r.services);
      setDraft(p.value === null ? "" : String(p.value));
      onResult({ text: p.value === null ? `${label}: cap removed.` : `${label}: cap saved at $${p.value}.`, bad: false });
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 400 ? "That cap was refused. Enter a number between 0 and 1000, or leave it empty." : "Couldn’t save the cap. Try again.";
      setError(msg);
      onResult({ text: `${label}: ${msg}`, bad: true });
    } finally { setBusy(false); }
  }

  return (
    <li className="us-cap">
      <div className="us-cap-main">
        <span className="us-cap-line">{serviceCapLine({ service: label, spentUsd: s.spentUsd, capUsd: s.capUsd })}</span>
        <span className={`us-level ${s.level}`}>{levelWord(s.level)}</span>
      </div>
      <form className="us-cap-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="fl" htmlFor={id}>{label} cap (USD)</label>
        <div className="us-cap-ctl">
          <input id={id} className="in" inputMode="decimal" autoComplete="off" placeholder="No cap" value={draft} aria-invalid={!!error}
            aria-describedby={error ? `${id}-err` : undefined} onChange={(e) => { setDraft(e.target.value); setError(""); }} />
          <button type="submit" className="btn" disabled={busy || draft.trim() === saved}>{busy ? "Saving…" : "Save"}</button>
        </div>
        {error && <p id={`${id}-err`} className="bx-err" role="alert">{error}</p>}
      </form>
    </li>
  );
}

/** Settings > Usage & limits: per-service sub-caps. A service at its cap pauses the optional jobs that use it. */
export default function ServiceCaps({ services, onChange }: { services: ServiceSpend[]; onChange: (services: ServiceSpend[]) => void }) {
  const [result, setResult] = useState<Result>(null);
  return (
    <Card title="Caps by service" sub="Inside the monthly limit. When a service reaches its cap, unattended jobs that use it pause (radars, for Bright Data and Google Places). Searches and audits you start yourself still run until the monthly limit.">
      {services.length === 0 ? <p className="bx-muted">No usage or caps yet this month.</p> : (
        <ul className="us-caps">
          {services.map((s) => <CapRow key={s.service} s={s} onSaved={onChange} onResult={setResult} />)}
        </ul>
      )}
      <div className={`us-cap-result${result?.bad ? " bad" : ""}`} aria-live="polite" aria-atomic="true">{result && <p>{result.text}</p>}</div>
    </Card>
  );
}
