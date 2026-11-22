import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { seoApi } from "../../../api";
import { dayLabel } from "../../../careReportPageView";
import { statusTone } from "../../../careReportsView";
import { periodLabel } from "../../../../worker/sop/cadence";
import { reportChip, reportWordsForm, wordsReady, type SeoReportRow } from "../../../seoView";
import Icon from "../../Icon";
import { copyText, Part, Say, sentence } from "./seoBits";

const SUMMARY_MAX = 600;
const RECOMMENDATION_MAX = 300;
const PRIORITY_MAX = 120;

/** The report's link in a box to select, and a button that copies it. A copy that is refused says so and leaves the link to copy by hand. */
function LinkBox({ link, id }: { link: string; id: string }) {
  const [note, setNote] = useState("");
  async function copy() { setNote((await copyText(link)) ? "Link copied." : "Could not copy: select the link and copy it by hand."); }
  return (
    <div className="rp-link">
      <label className="rp-link-label small" htmlFor={`sxl-${id}`}>Link to the report page</label>
      <div className="rp-link-row">
        <input id={`sxl-${id}`} readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn" onClick={() => void copy()}><Icon name="copy" size={16} />Copy link</button>
      </div>
      {note && <p className="small muted" role="status">{note}</p>}
    </div>
  );
}

/** The boxes for a `ready` report. A report the app wrote from the numbers has only a summary: it is pre-filled and the form says a recommendation and three priorities are still needed. A refusal shows the server's sentence. */
function WordsForm({ r, onSaved }: { r: SeoReportRow; onSaved: (next: SeoReportRow) => void }) {
  const start = reportWordsForm(r);
  const [summary, setSummary] = useState(start.summary);
  const [recommendation, setRecommendation] = useState(start.recommendation);
  const [priorities, setPriorities] = useState(start.priorities);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { const f = reportWordsForm(r); setSummary(f.summary); setRecommendation(f.recommendation); setPriorities(f.priorities); }, [r.id, r.summary, r.recommendation, r.priorities.join("\n"), r.source]);
  const words = { summary, recommendation, priorities };
  const dirty = summary.trim() !== r.summary || recommendation.trim() !== r.recommendation || priorities.some((p, i) => p.trim() !== (r.priorities[i] ?? ""));
  const canSave = dirty && wordsReady(words);
  async function save() {
    if (busy || !canSave) return;
    setBusy(true); setError(""); setSaved(false);
    try { onSaved(await seoApi.editReport(r.id, { summary, recommendation, priorities })); setSaved(true); }
    catch (e) { setError(sentence(e, "Couldn’t save the words. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <div className="rp-words">
      {start.note && <p className="small sx-note" role="note">{start.note}</p>}
      <label htmlFor={`ss-${r.id}`}><b>Summary</b> <span className="muted small">what the client reads in the mail ({summary.length} of {SUMMARY_MAX})</span></label>
      <textarea id={`ss-${r.id}`} rows={4} maxLength={SUMMARY_MAX} value={summary} onChange={(e) => { setSummary(e.target.value); setSaved(false); }} />
      <label htmlFor={`sr-${r.id}`}><b>Recommendation</b> <span className="muted small">on the report page ({recommendation.length} of {RECOMMENDATION_MAX})</span></label>
      <textarea id={`sr-${r.id}`} rows={2} maxLength={RECOMMENDATION_MAX} value={recommendation} onChange={(e) => { setRecommendation(e.target.value); setSaved(false); }} />
      {priorities.map((p, i) => (
        <div className="sx-priority" key={i}>
          <label htmlFor={`sp-${r.id}-${i}`}><b>Priority {i + 1}</b> <span className="muted small">one thing to work on next month ({p.length} of {PRIORITY_MAX})</span></label>
          <input id={`sp-${r.id}-${i}`} value={p} maxLength={PRIORITY_MAX} onChange={(e) => { setPriorities(priorities.map((x, j) => (j === i ? e.target.value : x))); setSaved(false); }} />
        </div>
      ))}
      <p className="small muted">No links, prices, markdown, or promise about a ranking or a result. The server checks the words and says what to change.</p>
      <div className="rp-actions">
        <button type="button" className="btn primary" aria-disabled={busy || !canSave} onClick={() => void save()}>Save my words</button>
        {saved && <span className="small muted" role="status">Saved. The card on Today shows these words now.</span>}
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  );
}

/** The latest monthly report for one client: its status, the words (editable while it is ready), the link to copy once it has one, Revoke, and a button that starts last month's report when there is none. */
export function SeoReport({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<SeoReportRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const load = useCallback(async () => {
    try { setRows(await seoApi.clientReports(clientId)); setFailed(false); } catch { setFailed(true); }
  }, [clientId]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const r = rows?.[0] ?? null;
  const replace = (next: SeoReportRow) => setRows((xs) => xs && xs.map((x) => (x.id === next.id ? next : x)));
  async function build() {
    if (busy) return;
    setBusy("build"); setError(""); setOk("");
    try { const b = await seoApi.buildReport(clientId); setOk(b.status === "collecting" ? "Started. The numbers are being collected and the words written." : "That report is already there."); await load(); }
    catch (e) { setError(sentence(e, "Couldn’t start the report. Try again.")); }
    finally { setBusy(""); }
  }
  async function revoke() {
    if (busy || !r) return;
    setBusy("revoke"); setError("");
    try { replace(await seoApi.revokeReport(r.id)); setAsking(false); }
    catch (e) { setError(sentence(e, "Couldn’t take it back. Try again.")); }
    finally { setBusy(""); }
  }
  const canBuild = rows !== null && (r === null || r.status === "revoked" || r.status === "cancelled");
  return (
    <Part title="Monthly report" help="The report goes out only after you approve it on Today. Ranks are only ever “in our check”; nothing in it looks forward."
      actions={canBuild ? <button type="button" className="btn" aria-disabled={!!busy} onClick={() => void build()}>{busy === "build" ? "Starting…" : "Build report now"}</button> : undefined}>
      {failed && <p className="error small" role="alert">Couldn’t load the report. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p>}
      {rows === null && !failed && <p className="small muted">Loading…</p>}
      {rows !== null && r === null && <p className="small muted">No report yet. It starts by itself in the first days of the month, or build last month’s now once a rank check is in.</p>}
      {r && (
        <div className="sx-report">
          <p className="sx-report-head">
            <b>{periodLabel("monthly", r.period)}</b>
            <span className={`badge2${statusTone(r.status) ? ` ${statusTone(r.status)}` : ""}`}><i className="dot" aria-hidden="true" />{reportChip(r.status)}</span>
            {r.test && <span className="badge2 outline">Test</span>}
          </p>
          <p className="small muted">
            {r.source === "claude" ? "Words written by Claude." : r.source === "logan" ? "Words written by you." : r.source === "plain" ? "Summary written by the app from the numbers." : ""}
            {r.sentOn && ` Sent ${dayLabel(r.sentOn) ?? r.sentOn}.`}
            {r.status === "sent" && ` ${r.views === 0 ? "Not opened yet." : `Opened ${r.views} ${r.views === 1 ? "time" : "times"}.`}`}
          </p>
          {r.status === "collecting" && <p className="small muted">The numbers are being collected and the words written. This changes when they are ready.</p>}
          {r.status === "ready" && (
            <>
              <WordsForm r={r} onSaved={replace} />
              <p className="small">Approve it on <Link to="/today">Today</Link> to send it. Nothing is mailed before that.</p>
            </>
          )}
          {r.status === "sent" && (
            <>
              <p className="sx-text">{r.summary}</p>
              {r.recommendation && <p className="sx-text small muted">Recommendation: {r.recommendation}</p>}
              {r.priorities.length > 0 && <ol className="sx-prios small">{r.priorities.map((p, i) => <li key={i}>{p}</li>)}</ol>}
            </>
          )}
          {(r.status === "revoked" || r.status === "cancelled") && <p className="small muted">{r.status === "revoked" ? "You took this report back. Its link no longer opens." : "This report was cancelled and never went out."}</p>}
          {r.link && <LinkBox link={r.link} id={r.id} />}
          {(r.status === "ready" || r.status === "sent") && (
            asking ? (
              <div className="rp-actions" role="group" aria-label="Take this report back?">
                <span className="small">Its link will stop working{r.status === "sent" ? ", even for the client who has it" : ""}.</span>
                <button type="button" className="btn" aria-disabled={!!busy} onClick={() => void revoke()}>Yes, take it back</button>
                <button type="button" className="btn-plain" onClick={() => setAsking(false)}>Keep it</button>
              </div>
            ) : <button type="button" className="btn rp-revoke" onClick={() => setAsking(true)}>Revoke</button>
          )}
        </div>
      )}
      <Say ok={ok} error={error} />
    </Part>
  );
}
