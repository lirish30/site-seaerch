import { useState } from "react";
import { api, ApiError } from "../../api";
import { Chip, Meter } from "../../components/ds";
import Icon from "../../components/Icon";
import { Card } from "../../components/SettingsPage";
import { levelWord, parseCapInput, serviceCapLine, serviceLabel, type ServiceSpend } from "../../spendView";

type Result = { text: string; bad: boolean } | null;
const TONE = { ok: "positive", warn: "warning", capped: "critical" } as const;

/** One service: its spend against its cap as a labelled meter, and a compact box to change the cap (empty removes it). */
function CapRow({ s, onSaved, onResult }: { s: ServiceSpend; onSaved: (services: ServiceSpend[]) => void; onResult: (r: Result) => void }) {
  const saved = s.capUsd === null ? "" : String(s.capUsd);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = `cap-${s.service}`;
  const label = serviceLabel(s.service);
  const tone = TONE[s.level as keyof typeof TONE] ?? "positive";

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
    <li className="sox-cap">
      <div className="sox-main">
        <div className="sox-title"><b>{label}</b>{s.capUsd !== null && <Chip tone={tone} dot>{levelWord(s.level)}</Chip>}</div>
        <div className="sox-cap-bar">
          {s.capUsd !== null && <Meter value={s.spentUsd} max={s.capUsd} tone={tone} label={`${label}: $${s.spentUsd.toFixed(2)} of a $${s.capUsd} cap`} />}
          <small>{serviceCapLine({ service: label, spentUsd: s.spentUsd, capUsd: s.capUsd }).replace(`${label}: `, "")}</small>
        </div>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div>
          <span className="sox-money"><span aria-hidden="true">$</span>
            <input id={id} className="in" inputMode="decimal" autoComplete="off" placeholder="No cap" value={draft} aria-invalid={!!error} aria-label={`${label} cap (USD)`}
              aria-describedby={error ? `${id}-err` : undefined} onChange={(e) => { setDraft(e.target.value); setError(""); }} /></span>
          {error && <p id={`${id}-err`} className="bx-err" role="alert">{error}</p>}
        </div>
        <button type="submit" className="btn" disabled={busy || draft.trim() === saved}>{busy ? "Saving…" : "Save cap"}</button>
      </form>
    </li>
  );
}

/** Settings > Usage & limits: per-service sub-caps. A service at its cap pauses the optional jobs that use it. */
export default function ServiceCaps({ services, onChange }: { services: ServiceSpend[]; onChange: (services: ServiceSpend[]) => void }) {
  const [result, setResult] = useState<Result>(null);
  return (
    <Card title="Caps by service" sub="Inside the monthly limit. When a service reaches its cap, unattended jobs that use it pause (radars, for Bright Data and Google Places). Searches and audits you start yourself still run until the monthly limit.">
      <div className="sox">
        {services.length === 0
          ? <p className="sox-foot"><Icon name="info" size={14} />No usage or caps yet this month. Each service you use shows here, and you can cap it.</p>
          : <ul className="sox-list sox-caps">{services.map((s) => <CapRow key={s.service} s={s} onSaved={onChange} onResult={setResult} />)}</ul>}
        <div className={`sox-result${result?.bad ? " bad" : ""}`} aria-live="polite" aria-atomic="true">{result && <p><Icon name={result.bad ? "alert" : "check"} size={14} />{result.text}</p>}</div>
      </div>
    </Card>
  );
}
