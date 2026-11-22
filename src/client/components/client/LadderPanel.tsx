import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, ladderApi } from "../../api";
import { latestOnly, problemText } from "../../clientView";
import { LADDER_LINK_MAX, STEP_LABEL, dueLine, isOpen, linkProblem, ordered, sendByHand, statusTone, statusWord, takesLink, type LadderRow } from "../../ladderView";

/** One step: its name, day and status, the review link box on a review request, the case study button, and Done and Skip while it is open. Every text is a React text node. */
function Step({ row, today, busy, onRun }: { row: LadderRow; today: string; busy: boolean; onRun: (job: () => Promise<unknown>, fail: string) => Promise<void> }) {
  const [link, setLink] = useState(row.link ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { setLink(row.link ?? ""); setProblem(null); }, [row.id, row.link]);
  const dirty = link.trim() !== (row.link ?? "");
  async function saveLink() {
    const p = linkProblem(link);
    if (p) { setProblem(p); return; }
    setProblem(null);
    await onRun(() => ladderApi.setLink(row.id, link.trim() || null), "Could not save the link.");
  }
  async function startCaseStudy() {
    await onRun(async () => { await ladderApi.startCaseStudy(row.businessId); await ladderApi.done(row.id); }, "Could not start the case study post.");
  }
  return (
    <li className={`lp-step lp-${row.status}`}>
      <div className="lp-head">
        <b>{STEP_LABEL[row.step]}</b>
        <span className={`badge2 ${statusTone(row.status)}`}><i className="dot" aria-hidden="true" />{statusWord(row.status)}</span>
        <span className="muted small">{dueLine(row, today)}</span>
      </div>
      {row.note && <p className="small lp-note">{row.note}</p>}
      {row.status === "drafted" && <p className="small muted">The mail is drafted. Read it and send it from Approvals on <Link to="/today">Home</Link>.</p>}
      {sendByHand(row) && <p className="small muted">This one will not be drafted again. Send it yourself if you still want it to go, then mark it done, or skip it.</p>}
      {takesLink(row) && (
        <div className="lp-link">
          <label className="deal-field" htmlFor={`lp-link-${row.id}`}><span>Google review link</span>
            <input id={`lp-link-${row.id}`} type="url" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={LADDER_LINK_MAX + 20} placeholder="https://… (optional if the client has a Local SEO place)"
              value={link} onChange={(e) => { setLink(e.target.value); setProblem(null); }} />
          </label>
          {dirty && <button type="button" className="btn" disabled={busy} onClick={() => void saveLink()}>Save link</button>}
          {problem && <p className="error small" role="alert">{problem}</p>}
        </div>
      )}
      {isOpen(row) && (
        <div className="lp-actions">
          {row.step === "case_study" && <button type="button" className="btn" disabled={busy} onClick={() => void startCaseStudy()}>Start a case study post</button>}
          <button type="button" className="btn" disabled={busy} aria-label={`Mark done: ${STEP_LABEL[row.step]}`} onClick={() => void onRun(() => ladderApi.done(row.id), "Could not mark that done.")}>Done</button>
          <button type="button" className="btn" disabled={busy} aria-label={`Skip: ${STEP_LABEL[row.step]}`} onClick={() => void onRun(() => ladderApi.skip(row.id), "Could not skip that.")}>Skip</button>
        </div>
      )}
    </li>
  );
}

/**
 * The post-launch ladder on a client's page: the steps owed after a build (a review request on launch day, a testimonial request, a thank-you package, a check-in, a case study post and a December letter each year),
 * each with its day and status. The mail steps wait here as drafts until they are approved in Approvals; the thank-you package and the case study post are Logan's own and show as due. Nothing in this panel sends anything.
 */
export default function LadderPanel({ businessId, today }: { businessId: string; today: string }) {
  const [rows, setRows] = useState<LadderRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [guard] = useState(latestOnly);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const next = await ladderApi.list(businessId);
      if (guard.isLatest(ticket)) { setRows(next); setFailed(false); }
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [businessId, guard]);
  useEffect(() => { setRows(null); setFailed(false); setError(""); void load(); return () => guard.cancel(); }, [load, guard]);

  async function run(job: () => Promise<unknown>, fail: string) {
    if (busy) return;
    setBusy(true); setError("");
    try { await job(); await load(); }
    catch (e) { setError(e instanceof ApiError ? problemText(e, fail) : fail); }
    finally { setBusy(false); }
  }

  if (rows === null) {
    return failed ? <section className="cl-card lp" aria-label="After launch"><h2>After launch</h2><p className="error small" role="alert">Couldn’t load the steps. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p></section> : null;
  }
  if (rows.length === 0) return null;
  return (
    <section className="cl-card lp" aria-label="After launch">
      <h2>After launch</h2>
      <ul className="lp-list">
        {ordered(rows).map((r) => <Step key={r.id} row={r} today={today} busy={busy} onRun={run} />)}
      </ul>
      {error && <p className="error small" role="alert">{error}</p>}
    </section>
  );
}
