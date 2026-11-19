import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import SettingsPage, { Callout, Card } from "../../components/SettingsPage";
import { dollars, formatPrice, parseDollars, priceWarnings, type Package } from "../../packagesView";

type Result = { text: string; bad: boolean } | null;

/** One package: what it is, its price, and a box to change the price. A change saves as the next version; the old version is kept. */
function PackageRow({ p, onSaved, onResult }: { p: Package; onSaved: (next: Package) => void; onResult: (r: Result) => void }) {
  const saved = String(p.priceCents / 100);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = `pkg-${p.key}`;
  const cents = parseDollars(draft);
  const warnings = cents === null ? [] : priceWarnings(p, { priceCents: cents });

  async function save() {
    if (cents === null) { setError("Enter a price in dollars, such as 797."); return; }
    setError(""); setBusy(true); onResult(null);
    try {
      const next = await api.put<Package>(`/packages/${p.key}`, { priceCents: cents });
      onSaved(next);
      setDraft(String(next.priceCents / 100));
      onResult({ text: `${next.name}: saved as version ${next.version} at ${dollars(next.priceCents)}.`, bad: false });
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 400 ? "That price was refused." : "Couldn’t save the price. Try again.";
      setError(msg); onResult({ text: `${p.name}: ${msg}`, bad: true });
    } finally { setBusy(false); }
  }

  return (
    <li className="us-cap">
      <div className="us-cap-main">
        <span className="us-cap-line"><strong>{p.name}</strong> · {formatPrice(p)}</span>
        <span className="bx-muted">version {p.version}</span>
        {!p.publicOffer && <span className="bx-muted">not shown to prospects</span>}
      </div>
      <form className="us-cap-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="fl" htmlFor={id}>{p.name} price (USD)</label>
        <div className="us-cap-ctl">
          <input id={id} className="in" inputMode="decimal" autoComplete="off" value={draft} aria-invalid={!!error}
            aria-describedby={error ? `${id}-err` : undefined} onChange={(e) => { setDraft(e.target.value); setError(""); }} />
          <button type="submit" className="btn" disabled={busy || cents === null || cents === p.priceCents}>{busy ? "Saving…" : `Save as v${p.version + 1}`}</button>
        </div>
        {warnings.map((w) => <p key={w} className="bx-muted">{w}</p>)}
        {error && <p id={`${id}-err`} className="bx-err" role="alert">{error}</p>}
      </form>
    </li>
  );
}

/** Settings > Packages: the catalog every proposal and deck takes its prices from. Changing a price adds a version; old proposals keep theirs. */
export default function Packages() {
  const [rows, setRows] = useState<Package[] | null | false>(null);
  const [result, setResult] = useState<Result>(null);
  useEffect(() => { api.get<Package[]>("/packages").then(setRows).catch(() => setRows(false)); }, []);
  const replace = (next: Package) => setRows((r) => (Array.isArray(r) ? r.map((x) => (x.key === next.key ? next : x)) : r));
  return (
    <SettingsPage title="Packages" width={900} sub="What you sell and what it costs. Prices anywhere in the app come from here.">
      <Card title="Catalog" sub="Changing a price saves a new version. Proposals already sent keep the version they were made with.">
        {rows === null && <p className="st-loading">Loading…</p>}
        {rows === false && <Callout tone="critical" icon="alert">Couldn't load the packages.</Callout>}
        {Array.isArray(rows) && <ul className="us-caps">{rows.map((p) => <PackageRow key={p.key} p={p} onSaved={replace} onResult={setResult} />)}</ul>}
        <div className={`us-cap-result${result?.bad ? " bad" : ""}`} aria-live="polite" aria-atomic="true">{result && <p>{result.text}</p>}</div>
      </Card>
    </SettingsPage>
  );
}
