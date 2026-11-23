import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, ladderApi } from "../../api";
import { latestOnly, problemText } from "../../clientView";
import { LADDER_LINK_MAX, STEP_LABEL, dueLine, isOpen, linkProblem, ordered, sendByHand, statusTone, statusWord, takesLink, type LadderRow } from "../../ladderView";
import { Card, Empty } from "../ds";
import Icon, { type IconName } from "../Icon";
import type { LadderStep } from "../../../worker/db/ladder";

const ICON: Record<LadderStep, IconName> = { review_request: "star", testimonial: "pen", thank_you: "send", check_in: "phone", case_study: "file-text", december_letter: "mail" };

/** One step: its name, day and status, the review link box on a review request, the case study button, and Done and Skip while it is open. Every text is a React text node. */
function Step({ row, today, busy, onRun }: { row: LadderRow; today: string; busy: boolean; onRun: (job: () => Promise<unknown>, fail: string) => Promise<boolean> }) {
  const [link, setLink] = useState(row.link ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => { setLink(row.link ?? ""); setProblem(null); }, [row.id, row.link]);
  const dirty = link.trim() !== (row.link ?? "");
  async function saveLink() {
    const p = linkProblem(link);
    if (p) { setProblem(p); return; }
    setProblem(null);
    await onRun(() => ladderApi.setLink(row.id, link.trim() || null), "Could not save the link.");
  }
  async function startCaseStudy() {
    // On success the post is waiting in the Studio for its words.
    if (await onRun(async () => { await ladderApi.startCaseStudy(row.businessId); await ladderApi.done(row.id); }, "Could not start the case study post.")) navigate("/studio");
  }
  const tone = statusTone(row.status);
  const tile = row.status === "done" ? "positive" : row.status === "skipped" ? "neutral" : row.status === "drafted" || row.status === "due" ? "signal" : "neutral";
  return (
    <li className={`clx-lad${isOpen(row) ? " open" : ""}`}>
      <span className={`ds-tile ${tile}`}><Icon name={row.status === "done" ? "check" : row.status === "skipped" ? "x" : ICON[row.step]} size={15} /></span>
      <div className="clx-lad-main">
        <div className="clx-lad-head">
          <span className="clx-setup-text"><b>{STEP_LABEL[row.step]}</b><small>{dueLine(row, today)}</small></span>
          <span className={`badge2 ${tone}`}><i className="dot" aria-hidden="true" />{statusWord(row.status)}</span>
        </div>
        {row.note && <p className="clx-help">{row.note}</p>}
        {row.status === "drafted" && <p className="clx-help">The mail is drafted. Read it and send it from Approvals on <Link to="/today">Home</Link>.</p>}
        {sendByHand(row) && <p className="clx-help">This one will not be drafted again. Send it yourself if you still want it to go, then mark it done, or skip it.</p>}
        {takesLink(row) && (
          <div className="clx-inline-form">
            <label className="deal-field" htmlFor={`lp-link-${row.id}`}><span>Google review link</span>
              <input id={`lp-link-${row.id}`} type="url" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={LADDER_LINK_MAX + 20} placeholder="https://… (optional with a Local SEO place)"
                value={link} onChange={(e) => { setLink(e.target.value); setProblem(null); }} />
            </label>
            {dirty && <button type="button" className="btn sm" disabled={busy} onClick={() => void saveLink()}>Save link</button>}
            {problem && <p className="error small" role="alert">{problem}</p>}
          </div>
        )}
        {isOpen(row) && (
          <div className="ds-row">
            {row.step === "case_study" && <button type="button" className="btn sm" disabled={busy} onClick={() => void startCaseStudy()}><Icon name="sparkles" size={14} />Start a case study post</button>}
            <button type="button" className="btn sm" disabled={busy} aria-label={`Mark done: ${STEP_LABEL[row.step]}`} onClick={() => void onRun(() => ladderApi.done(row.id), "Could not mark that done.")}><Icon name="check" size={14} />Done</button>
            <button type="button" className="btn-ghost-sm" disabled={busy} aria-label={`Skip: ${STEP_LABEL[row.step]}`} onClick={() => void onRun(() => ladderApi.skip(row.id), "Could not skip that.")}>Skip</button>
          </div>
        )}
      </div>
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

  /** Runs one change and reloads; true when it worked. */
  async function run(job: () => Promise<unknown>, fail: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true); setError("");
    try { await job(); await load(); return true; }
    catch (e) { setError(e instanceof ApiError ? problemText(e, fail) : fail); return false; }
    finally { setBusy(false); }
  }

  if (rows === null) {
    return failed ? <Card icon="calendar" title="After launch"><p className="error small" role="alert">Couldn’t load the steps. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p></Card> : null;
  }
  if (rows.length === 0) return <Card icon="calendar" title="After launch"><Empty icon="calendar" title="No after-launch steps">When a website build goes live, the review request, testimonial, thank-you, check-in and case study steps show here with their days.</Empty></Card>;
  return (
    <Card icon="calendar" title="After launch" note={`${rows.filter((r) => r.status === "done" || r.status === "skipped").length} of ${rows.length} done`} flush>
      <ul className="clx-lad-list">
        {ordered(rows).map((r) => <Step key={r.id} row={r} today={today} busy={busy} onRun={run} />)}
      </ul>
      {error && <p className="error small clx-lad-err" role="alert">{error}</p>}
    </Card>
  );
}
