import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { fieldErrors, parseJobValue } from "../campaignView";
import { Pill } from "../components/settingsBits";
import { jobValueText, leaderRowId, statText, usdText, verdictLine, type NicheRow, type NicheVerdict } from "../nicheView";
import type { Campaign } from "../types";

type NicheData = { rows: NicheRow[]; verdict: NicheVerdict };

/** The job value box: saves when you leave it or press Enter. Blank clears the value; anything else must be an amount of 0 or more. */
function JobValueCell({ row, onSaved }: { row: NicheRow; onSaved: () => void }) {
  const [text, setText] = useState(jobValueText(row.jobValueUsd));
  const [saved, setSaved] = useState(text);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const errId = useId();

  async function save() {
    if (inflight.current || text.trim() === saved.trim()) return; // Enter then blur must not send it twice
    const job = parseJobValue(text);
    if (!job.ok) { setErr("Enter an amount of 0 or more, or leave it blank."); return; }
    const sent = text;
    inflight.current = true; setBusy(true); setErr("");
    try {
      const c = await api.patch<Campaign>(`/campaigns/${row.campaignId}`, { est_job_value_usd: job.value });
      if (!alive.current) return;
      const t = jobValueText(c.est_job_value_usd);
      setSaved(t); setText((cur) => (cur === sent ? t : cur));
      onSaved();
    } catch (e) {
      if (alive.current) setErr(e instanceof ApiError && e.status === 400 ? fieldErrors(e.fields).est_job_value_usd ?? "Not saved: enter an amount of 0 or more." : `Not saved: ${e instanceof ApiError ? e.message : "request failed"}`);
    } finally { inflight.current = false; if (alive.current) setBusy(false); }
  }

  return (
    <form className="niche-job" onSubmit={(e: FormEvent) => { e.preventDefault(); void save(); }} noValidate>
      <span className="niche-dollar" aria-hidden="true">$</span>
      <input inputMode="decimal" autoComplete="off" value={text} disabled={busy} aria-label={`Job value in dollars for ${row.name}`}
        aria-invalid={err ? true : undefined} aria-describedby={err ? errId : undefined}
        onChange={(e) => { setText(e.target.value); setErr(""); }} onBlur={() => void save()} />
      {err && <p className="error small" id={errId} role="alert">{err}</p>}
    </form>
  );
}

/** Niche test: the trades side by side on site score, competition and job value. It names the leader once there are enough audits and never picks for you. */
export default function NicheTest() {
  const [data, setData] = useState<NicheData | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const alive = useRef(true);
  const latest = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(() => {
    const n = ++latest.current; // a slower, older response must not overwrite a newer one
    return api.get<NicheData>("/niche")
      .then((r) => { if (alive.current && n === latest.current) { setData(r); setLoadErr(""); } })
      .catch((e) => { if (alive.current && n === latest.current) setLoadErr(e instanceof ApiError ? e.message : "Couldn't load the niche test."); });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const leader = data ? leaderRowId(data.verdict) : null;
  return (
    <div className="leads-page">
      <header className="page-header">
        <div>
          <h1>Niche test</h1>
          <p>Search four or five trades across your towns, audit what turns up, then compare them here.</p>
        </div>
      </header>
      <div className="page-body">
        <div className="niche-verdict" role="status" aria-live="polite" aria-atomic="true">
          {data && data.rows.length > 0 && <p><strong>{verdictLine(data.verdict, data.rows)}</strong></p>}
        </div>
        {loadErr && <p className="error" role="alert">{loadErr}</p>}
        {!data ? (loadErr ? null : <p>Loading…</p>) : data.rows.length === 0 ? (
          <div className="card"><p>No trades to compare yet. Make a campaign for each trade on the <Link to="/campaigns">Campaigns</Link> page and run its searches.</p></div>
        ) : (
          <>
            <p className="muted promising-note">
              Site score is Site Health from 0 to 100, so a low average means more to fix. Opportunity is the room left on the sites (100 minus the average score)
              times the job value, divided down for competition (average Google reviews). A bigger number is a better bet. Audits are counted once per business, even when two trades found it.
            </p>
            <div className="table-card"><div className="table-scroll"><table className="leads niche">
              <colgroup><col className="c-trade" /><col className="c-n" /><col className="c-n" /><col className="c-n" /><col className="c-job" /><col className="c-opp" /></colgroup>
              <thead><tr>
                <th>Trade</th><th className="r">Audited</th>
                <th className="r" title="Average Site Health of the audited businesses. Higher is a better site.">Avg site score</th>
                <th className="r" title="Average Google reviews: more reviews means more competition.">Avg reviews</th>
                <th>Job value</th><th className="r">Opportunity</th>
              </tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.campaignId} className={r.campaignId === leader ? "leader" : undefined}>
                    <td className="cell-name">
                      <div className="name-line">{r.name}</div>
                      <div className="sub">{r.niche}</div>
                      {r.campaignId === leader && <Pill tone="positive">Leads on opportunity</Pill>}
                    </td>
                    <td className="r num-cell">{r.audited}</td>
                    <td className="r num-cell">{statText(r.avgScore)}</td>
                    <td className="r num-cell">{statText(r.avgReviews)}</td>
                    <td><JobValueCell row={r} onSaved={() => void load()} /></td>
                    <td className="r num-cell">{usdText(r.opportunity)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div></div>
            <p className="muted promising-note">The job value saves when you leave the box or press Enter. Leave it blank if you are not sure yet.</p>
          </>
        )}
      </div>
    </div>
  );
}
