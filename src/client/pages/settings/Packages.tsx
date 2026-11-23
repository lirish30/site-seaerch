import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { Chip } from "../../components/ds";
import Icon, { type IconName } from "../../components/Icon";
import SettingsPage, { Callout } from "../../components/SettingsPage";
import { dollars, formatPrice, parseDollars, priceWarnings, type Package } from "../../packagesView";

type Result = { text: string; bad: boolean } | null;

const GROUPS: { kinds: Package["kind"][]; label: string; icon: IconName }[] = [
  { kinds: ["one_time"], label: "One-time projects", icon: "briefcase" },
  { kinds: ["monthly", "subscription"], label: "Monthly plans", icon: "refresh" },
  { kinds: ["hourly"], label: "Hourly", icon: "clock" },
];
const UNIT: Record<Package["kind"], string> = { one_time: "", monthly: "/mo", subscription: "/mo", hourly: "/hr" };
const UNIT_WORDS: Record<Package["kind"], string> = { one_time: "", monthly: " a month", subscription: " a month", hourly: " an hour" };

/** The small line under the price: setup fee, term, the Care rate. Empty when the price says it all. */
function priceExtra(p: Package): string {
  const bits: string[] = [];
  if (p.setupCents > 0) bits.push(`+ ${dollars(p.setupCents)} setup`);
  if (p.termMonths !== null) bits.push(p.kind === "subscription" ? `${p.termMonths}-month term` : `${p.termMonths}-month first term`);
  if (p.kind === "hourly" && p.altPriceCents !== null) bits.push(`${dollars(p.altPriceCents)}/hr for Care clients`);
  return bits.join(" · ");
}

/** One package as a price-list row: what it is and includes, its current price in mono, its version, and "Change price" that opens a compact field. A change saves as the next version; the old one is kept. */
function PackageRow({ p, onSaved, onResult }: { p: Package; onSaved: (next: Package) => void; onResult: (r: Result) => void }) {
  const saved = String(p.priceCents / 100);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = `pkg-${p.key}`;
  const cents = parseDollars(draft);
  const warnings = cents === null ? [] : priceWarnings(p, { priceCents: cents });
  const extra = priceExtra(p);
  const more = p.includes.length - 4;

  async function save() {
    if (cents === null) { setError("Enter a price in dollars, such as 797."); return; }
    setError(""); setBusy(true); onResult(null);
    try {
      const next = await api.put<Package>(`/packages/${p.key}`, { priceCents: cents });
      onSaved(next);
      setDraft(String(next.priceCents / 100));
      setOpen(false);
      onResult({ text: `${next.name}: saved as version ${next.version} at ${dollars(next.priceCents)}.`, bad: false });
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 400 ? "That price was refused." : "Couldn’t save the price. Try again.";
      setError(msg); onResult({ text: `${p.name}: ${msg}`, bad: true });
    } finally { setBusy(false); }
  }
  const cancel = () => { setOpen(false); setDraft(saved); setError(""); };

  return (
    <li>
      <div className={`sox-row top${p.publicOffer ? "" : " off"}`}>
        <span className="sox-tile"><Icon name={GROUPS.find((g) => g.kinds.includes(p.kind))?.icon ?? "tag"} size={16} /></span>
        <div className="sox-main">
          <div className="sox-title">
            <b>{p.name}</b>
            <Chip tone="outline">v{p.version}</Chip>
            {!p.publicOffer && <Chip tone="warning" dot>Not shown to prospects</Chip>}
            {p.wordpressOnly && <Chip>WordPress only</Chip>}
          </div>
          {p.summary && <span className="sox-desc">{p.summary}</span>}
          {p.includes.length > 0 && (
            <span className="sox-incl" aria-label="Includes">
              {p.includes.slice(0, 4).map((x) => <Chip key={x} tone="outline">{x}</Chip>)}
              {more > 0 && <Chip title={p.includes.slice(4).join(", ")}>+{more} more</Chip>}
            </span>
          )}
        </div>
        <div className="sox-price" title={formatPrice(p)}>
          <span className="sox-mono">{p.fromPrice && <small>from </small>}{dollars(p.priceCents)}<small>{UNIT[p.kind]}</small></span>
          {extra && <span className="sox-sub">{extra}</span>}
        </div>
        <div className="sox-side">
          <button type="button" className="btn sm" aria-expanded={open} aria-controls={`${id}-edit`} onClick={() => (open ? cancel() : setOpen(true))}>{open ? "Cancel" : "Change price"}</button>
        </div>
      </div>
      {open && (
        <form id={`${id}-edit`} className="sox-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="sox-inline">
            <div className="bx-f">
              <label className="fl" htmlFor={id}>New price{UNIT_WORDS[p.kind]}</label>
              <span className="sox-money"><span aria-hidden="true">$</span>
                <input id={id} className="in" inputMode="decimal" autoComplete="off" autoFocus value={draft} aria-invalid={!!error}
                  aria-describedby={error ? `${id}-err` : undefined} onChange={(e) => { setDraft(e.target.value); setError(""); }} /></span>
            </div>
            <button type="submit" className="btn primary" disabled={busy || cents === null || cents === p.priceCents}>{busy ? "Saving…" : `Save as v${p.version + 1}`}</button>
            <button type="button" className="btn-plain" onClick={cancel}>Cancel</button>
          </div>
          {warnings.map((w) => <p key={w} className="sox-warn"><Icon name="alert" size={13} />{w}</p>)}
          {error && <p id={`${id}-err`} className="bx-err" role="alert">{error}</p>}
          {!error && warnings.length === 0 && <p className="sox-sub">Version {p.version} stays on every proposal already sent.</p>}
        </form>
      )}
    </li>
  );
}

/** Settings > Packages: the price list every proposal and deck takes its prices from. Changing a price adds a version; old proposals keep theirs. */
export default function Packages() {
  const [rows, setRows] = useState<Package[] | null | false>(null);
  const [result, setResult] = useState<Result>(null);
  useEffect(() => { api.get<Package[]>("/packages").then(setRows).catch(() => setRows(false)); }, []);
  const replace = (next: Package) => setRows((r) => (Array.isArray(r) ? r.map((x) => (x.key === next.key ? next : x)) : r));
  const list = Array.isArray(rows) ? rows : [];
  const offered = list.filter((p) => p.publicOffer).length;
  return (
    <SettingsPage title="Packages" width={900} sub="What you sell and what it costs. Prices anywhere in the app come from here."
      badge={list.length > 0 ? <Chip tone="outline" dot>{list.length} packages · {offered} offered</Chip> : undefined}>
      <div className="bx sox">
        {rows === null && <p className="st-loading">Loading…</p>}
        {rows === false && <Callout tone="critical" icon="alert">Couldn't load the packages. Reload the page to try again.</Callout>}
        {Array.isArray(rows) && (
          <section className="st-card">
            <header><div><h2>Price list</h2><p>Proposals, decks and the booking form read these prices.</p></div></header>
            <div className="st-card-body flush">
              <ul className="sox-list">
                {GROUPS.flatMap((g) => {
                  const items = list.filter((p) => g.kinds.includes(p.kind));
                  return items.length === 0 ? [] : [
                    <li key={g.label} className="sox-group">{g.label}<span className="n">{items.length}</span></li>,
                    ...items.map((p) => <PackageRow key={p.key} p={p} onSaved={replace} onResult={setResult} />),
                  ];
                })}
                {list.length === 0 && (
                  <li className="sox-row"><span className="sox-tile"><Icon name="tag" size={16} /></span>
                    <div className="sox-main"><b>No packages yet</b><small>Packages come from the database seed. Once it has run, each one shows here with its price.</small></div></li>
                )}
              </ul>
            </div>
            <div aria-live="polite" aria-atomic="true">
              {result && <div className={`sox-card-foot sox-result${result.bad ? " bad" : ""}`}><p><Icon name={result.bad ? "alert" : "check"} size={14} />{result.text}</p></div>}
            </div>
          </section>
        )}
        <p className="sox-foot"><Icon name="info" size={14} />Changing a price saves a new version. Proposals already sent keep the version they were made with, and existing clients keep the price they signed at.</p>
      </div>
    </SettingsPage>
  );
}
