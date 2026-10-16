import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import Icon, { type IconName } from "../components/Icon";
import { announceLeadsChanged } from "../components/Shell";
import type { Radar, Search } from "../types";
import { RADAR_INTERVALS, radarBodyFor, radarFollowUpNotice } from "../radar";
import {
  RESULT_PRESETS, etaText, meterView, money, parseCustomResults, perLeadText, startFailureText, startedText, summaryRows, type Estimate,
} from "../newSearchView";
import BusinessTypePicker from "./BusinessTypePicker";

const ROW_ICON: Record<ReturnType<typeof summaryRows>[number]["key"], IconName> = {
  location: "pin", types: "briefcase", businesses: "users", scan: "sparkles", repeats: "radar",
};

/** One numbered card of the form: the circled step number, a title and a one-line help text, then its controls. */
function Step({ n, title, help, aside, children }: { n: number; title: string; help: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="ns-step" aria-labelledby={`ns-step-${n}`}>
      <header className="ns-step-head">
        <span className="ns-num" aria-hidden="true">{n}</span>
        <div className="ns-step-title"><h2 id={`ns-step-${n}`}>{title}</h2><p>{help}</p></div>
        {aside}
      </header>
      {children}
    </section>
  );
}

export default function NewSearch() {
  const nav = useNavigate();
  const [location, setLocation] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [maxResults, setMax] = useState(50);
  const [customOpen, setCustomOpen] = useState(false); const [customText, setCustomText] = useState("");
  const [est, setEst] = useState<Estimate | null>(null);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState("");
  const [repeat, setRepeat] = useState(false); const [every, setEvery] = useState(30);
  const [quickScan, setQuickScan] = useState(true);
  const [estErr, setEstErr] = useState("");
  const customRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<Estimate>(`/searches/estimate?maxResults=${maxResults}`)
      .then((r) => { if (!cancelled) { setEst(r); setEstErr(""); } })
      .catch(() => { if (!cancelled) { setEst(null); setEstErr("Couldn't load the cost estimate."); } });
    return () => { cancelled = true; };
  }, [maxResults]);

  const count = types.length;
  const totalUsd = est ? est.estUsd * count : 0;
  const meter = est ? meterView(est, totalUsd, count) : null;
  const overLimit = meter?.over ?? false;
  const locationOk = location.trim().length >= 2;
  const canSubmit = !busy && count > 0 && locationOk && !overLimit;
  const customMode = customOpen || !RESULT_PRESETS.includes(maxResults);
  const blocker = busy ? "" : !locationOk ? "Enter a location first." : count === 0 ? "Pick at least one business type." : overLimit ? "This would go over your monthly spend limit." : "";

  function pickPreset(n: number) { setCustomOpen(false); setMax(n); }
  function openCustom() { setCustomOpen(true); setCustomText(String(maxResults)); setTimeout(() => { customRef.current?.focus(); customRef.current?.select(); }); }
  function typeCustom(raw: string) {
    const digits = raw.replace(/\D/g, "");
    const n = parseCustomResults(digits);
    setCustomText(n === null ? digits : String(n)); // "9999" shows as the 200 it is capped to
    if (n !== null) setMax(n);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setErr(""); setStarted(""); setBusy(true);
    const ok: Search[] = []; const failed: string[] = [];
    let limitHit = false;
    for (const t of types) {
      if (limitHit) { failed.push(`${t} (spend limit)`); continue; }
      try { ok.push(await api.post<Search>("/searches", { location, businessType: t, maxResults, quickScan })); }
      catch (x) {
        if (x instanceof ApiError && x.status === 402) limitHit = true;
        failed.push(x instanceof ApiError && x.status !== 402 ? `${t} (${x.message})` : t);
      }
    }
    // Radar: each search just started is that market's first run, so its radar's first run is due in `every` days (runNow stays false).
    let notice = "";
    if (repeat) {
      for (const s of ok) {
        try { await api.post<Radar>("/radar", radarBodyFor({ location: s.location, businessType: s.business_type, radiusKm: s.radius_km, maxResults: s.max_results }, every)); }
        catch (x) { notice = radarFollowUpNotice(x instanceof ApiError ? x.message : ""); }
      }
    }
    setBusy(false);
    if (ok.length) announceLeadsChanged();
    if (ok.length === 1 && failed.length === 0) { nav(`/searches/${ok[0].id}`, notice ? { state: { notice } } : undefined); return; }
    const errText = startFailureText(failed, limitHit);
    if (errText || notice) setErr([errText, notice].filter(Boolean).join(" "));
    if (ok.length) {
      setStarted(startedText(ok.length));
      setTypes(failed.length ? types.filter((t) => failed.some((f) => f.startsWith(t))) : []);
    }
  }

  const rows = summaryRows({ location, count, maxResults, quickScan, repeat, every });
  return (
    <>
      <div className="page-header">
        <div><h1>New search</h1><p>Find local businesses on Google Maps, audit their websites, and rank them as leads.</p></div>
      </div>
      <form className="ns ns-body" onSubmit={submit} noValidate>
        <div className="ns-steps">
          <Step n={1} title="Where" help="A city and state, or a ZIP code.">
            <div className="ns-where">
              <div className="ns-field">
                <label className="ns-label" htmlFor="ns-loc">Location</label>
                <div className="ns-input">
                  <Icon name="pin" size={15} />
                  <input id="ns-loc" autoFocus placeholder="Boise, ID" autoComplete="off" value={location} onChange={(e) => setLocation(e.target.value)} />
                </div>
              </div>
              <div className="ns-field">
                <span className="ns-label" id="ns-max-label">Results per type</span>
                <div className="ns-seg" role="group" aria-labelledby="ns-max-label">
                  {RESULT_PRESETS.map((n) => {
                    const on = !customMode && maxResults === n;
                    return <button type="button" key={n} className={on ? "on" : ""} aria-pressed={on} onClick={() => pickPreset(n)}>{n}</button>;
                  })}
                  {customMode
                    ? <input ref={customRef} className="on" inputMode="numeric" aria-label="Custom results per type, 1 to 200" placeholder="Custom"
                        value={customOpen ? customText : String(maxResults)} onChange={(e) => typeCustom(e.target.value)}
                        onBlur={() => { if (parseCustomResults(customText) === null) { setCustomOpen(false); setCustomText(""); } }} />
                    : <button type="button" onClick={openCustom}>Custom</button>}
                </div>
              </div>
            </div>
          </Step>

          <Step n={2} title="What kind of businesses" help="Pick as many as you like. Each type runs as its own search."
            aside={count > 0 ? <span className="badge2 signal ns-count">{count} selected</span> : null}>
            <BusinessTypePicker selected={types} onChange={setTypes} />
          </Step>

          <Step n={3} title="How deep to look" help="You can always run a full scan later on the leads that look good.">
            <div className="ns-scans" role="radiogroup" aria-label="How deep to look">
              <label className={`ns-scan${quickScan ? " on" : ""}`}>
                <input type="radio" name="ns-scan" className="ns-sr" checked={quickScan} onChange={() => setQuickScan(true)} />
                <span className="ns-scan-top"><i className="ns-radio" aria-hidden="true" /><b>Quick scan first</b><span className="badge2 positive">Recommended</span></span>
                <span className="ns-scan-text">Crawls and scores each business. Cheap enough to cast a wide net.</span>
                {est?.quickUsd !== undefined && <span className="num-mono ns-scan-cost">{perLeadText(est.quickUsd, maxResults)} a lead</span>}
              </label>
              <label className={`ns-scan${quickScan ? "" : " on"}`}>
                <input type="radio" name="ns-scan" className="ns-sr" checked={!quickScan} onChange={() => setQuickScan(false)} />
                <span className="ns-scan-top"><i className="ns-radio" aria-hidden="true" /><b>Full scan</b></span>
                <span className="ns-scan-text">Adds screenshots, Google speed test, AI design review and an email draft.</span>
                {est && <span className="num-mono ns-scan-cost">{perLeadText(est.estUsd, maxResults)} a lead</span>}
              </label>
            </div>
          </Step>

          <Step n={4} title="Keep watching (Radar)" help="Re-run on a schedule and only audit businesses you haven’t seen."
            aside={<label className="switch"><input type="checkbox" role="switch" aria-label="Keep watching with Radar" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /><i /></label>}>
            <div className={`ns-repeat${repeat ? "" : " off"}`}>
              <label htmlFor="ns-every">Repeat every</label>
              <span className="ns-select">
                <select id="ns-every" value={every} disabled={!repeat} onChange={(e) => setEvery(Number(e.target.value))}>
                  {RADAR_INTERVALS.map((d) => <option key={d} value={d}>{d} days</option>)}
                </select>
                <Icon name="chevron-down" size={13} />
              </span>
              <span className="ns-repeat-hint">· Radar runs always use full scans.</span>
            </div>
          </Step>
        </div>

        <aside className="ns-summary" aria-label="Summary">
          <h2 className="ns-sum-head">Summary</h2>
          <dl className="ns-rows">
            {rows.map((r) => (
              <div key={r.key} className="ns-row"><Icon name={ROW_ICON[r.key]} size={14} /><dt>{r.label}</dt><dd>{r.value}</dd></div>
            ))}
          </dl>
          <div className="ns-est">
            <span className="ns-est-label">Estimated cost</span>
            <div className="ns-est-amount"><strong>{est ? money(totalUsd) : "—"}</strong><span>at most</span></div>
            <span className="ns-est-time">{etaText(count, maxResults)}</span>
          </div>
          <div className="ns-month">
            <div className="ns-month-top"><span>This month</span>{meter && <b className="num-mono">{meter.label}</b>}</div>
            <div className="ns-meter" role="img" aria-label={meter ? `${meter.label} spent this month` : "Spend this month"}>
              <span className="spent" style={{ width: `${meter?.spentPct ?? 0}%` }} /><span className="flight" style={{ width: `${meter?.flightPct ?? 0}%` }} />
            </div>
            {meter?.note && <p className={meter.over ? "over" : ""}>{meter.note}</p>}
          </div>
          <div className="ns-act">
            {started && <p className="ns-note ok" role="status">{started}</p>}
            {err && <p className="ns-note err" role="alert">{err}</p>}
            {estErr && <p className="ns-note err" role="alert">{estErr}</p>}
            {overLimit && !err && <p className="ns-note err" role="alert">This would go over your monthly spend limit.</p>}
            <button className="btn primary ns-go" disabled={!canSubmit} title={blocker || undefined}>
              {busy ? <><span className="spinner light" aria-hidden="true" />Starting…</> : <><Icon name="search" size={16} />{count > 0 ? `Find up to ${count * maxResults} businesses` : "Find businesses"}</>}
            </button>
            <p className="ns-safe"><Icon name="shield" size={13} /><span>Nothing is ever sent to these businesses. Drafts only.</span></p>
          </div>
        </aside>
      </form>
    </>
  );
}
