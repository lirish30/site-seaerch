import { useEffect, useState } from "react";
import { seoApi, type SeoOverview } from "../../../api";
import { dayLabel } from "../../../careReportPageView";
import { replyStatusLabel, replyStatusTone, sortReviews, starsLabel, type SeoReview } from "../../../seoView";
import { CopyButton, Part, Say, sentence } from "./seoBits";

const EDITABLE = new Set(["new", "drafting", "drafted"]);

/**
 * One review and its reply. The reviewer's name and words are untrusted text from Google: they are shown as plain text and nothing in them is followed. A reply here is words for Logan to copy and post on Google himself;
 * "Mark posted" only records that he did. Nothing in this panel posts anywhere.
 */
function ReviewCard({ r, onChanged }: { r: SeoReview; onChanged: (next: SeoReview) => void }) {
  const [draft, setDraft] = useState(r.replyDraft);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [asking, setAsking] = useState(false);
  useEffect(() => { setDraft(r.replyDraft); }, [r.replyDraft]);
  const editable = EDITABLE.has(r.replyStatus);
  const dirty = draft.trim() !== r.replyDraft;
  async function run(what: string, f: () => Promise<SeoReview>, fallback: string) {
    if (busy) return;
    setBusy(what); setError(""); setSaved(false);
    try { onChanged(await f()); if (what === "save") setSaved(true); setAsking(false); }
    catch (e) { setError(sentence(e, fallback)); }
    finally { setBusy(""); }
  }
  const when = r.publishedAt ? dayLabel(r.publishedAt.slice(0, 10)) : null;
  return (
    <li className="sx-review">
      <div className="sx-review-head">
        <b>{starsLabel(r.rating)}</b>
        {r.flagged && <span className="badge2 critical"><i className="dot" aria-hidden="true" />Low rating</span>}
        <span className={`badge2${replyStatusTone(r.replyStatus) ? ` ${replyStatusTone(r.replyStatus)}` : ""}`}><i className="dot" aria-hidden="true" />{replyStatusLabel(r.replyStatus)}</span>
      </div>
      <p className="small muted sx-review-by">{r.author || "A reviewer"}{when ? ` · ${when}` : ""}</p>
      <p className="sx-quote">{r.body.trim() ? r.body : <span className="muted">No words, only a rating.</span>}</p>
      {editable && (
        <div className="sx-draft">
          <label htmlFor={`rv-${r.id}`} className="small"><b>Reply</b> <span className="muted">{r.replyStatus === "drafting" ? "Claude is still writing. You can write your own." : "Your words replace Claude’s. Up to 700 characters, no links or prices."} ({draft.length} of 700)</span></label>
          <textarea id={`rv-${r.id}`} rows={4} maxLength={700} value={draft} onChange={(e) => { setDraft(e.target.value); setSaved(false); }} />
          <div className="sx-actions">
            <button type="button" className="btn" aria-disabled={!!busy || !dirty || !draft.trim()} onClick={() => { if (dirty && draft.trim()) void run("save", () => seoApi.saveDraft(r.id, draft), "Couldn’t save the reply. Try again."); }}>Save my reply</button>
            <CopyButton text={draft} label="Copy reply" />
            {r.replyStatus === "drafted" && !dirty && <button type="button" className="btn primary" aria-disabled={!!busy} onClick={() => void run("posted", () => seoApi.markPosted(r.id), "Couldn’t mark it. Try again.")}>Mark posted</button>}
            {asking
              ? <span className="sx-ask" role="group" aria-label="Skip this review?"><span className="small">No reply to this one?</span><button type="button" className="btn" aria-disabled={!!busy} onClick={() => void run("skip", () => seoApi.skipReview(r.id), "Couldn’t skip it. Try again.")}>Yes, skip</button><button type="button" className="btn-plain" onClick={() => setAsking(false)}>Keep it</button></span>
              : <button type="button" className="btn-plain" onClick={() => setAsking(true)}>Skip</button>}
          </div>
          {r.replyStatus === "drafted" && dirty && <p className="small muted">Save your changes before marking it posted.</p>}
          <p className="small muted sx-help">Copy the reply, post it on Google yourself, then press Mark posted. Nothing is posted from here.</p>
          <Say error={error} ok={saved ? "Saved." : undefined} />
        </div>
      )}
      {!editable && r.replyDraft && (
        <div className="sx-draft">
          <p className="small"><b>{r.replyStatus === "posted" ? "Reply you posted" : "Reply that was drafted"}</b></p>
          <p className="sx-quote">{r.replyDraft}</p>
        </div>
      )}
    </li>
  );
}

/** The client's reviews, newest first (a hundred at most). Low ratings wait for an answer; the replies are drafts for Logan to copy. */
export function Reviews({ reviews, onChanged }: { reviews: SeoOverview["reviews"]; onChanged: (next: SeoOverview["reviews"]) => void }) {
  const waiting = reviews.filter((r) => r.replyStatus === "drafted").length;
  const [all, setAll] = useState(false);
  const sorted = sortReviews(reviews);
  const shown = all ? sorted : sorted.slice(0, 5);
  return (
    <Part title="Reviews" help={reviews.length ? `${waiting === 0 ? "No reply is waiting for you." : `${waiting} ${waiting === 1 ? "reply is" : "replies are"} waiting for you.`} Replies are posted by you on Google; nothing is posted from here.` : undefined}>
      {reviews.length === 0 && <p className="small muted">No reviews seen yet. New ones are picked up by the daily watch.</p>}
      <ul className="sx-reviews">{shown.map((r) => <ReviewCard key={r.id} r={r} onChanged={(next) => onChanged(reviews.map((x) => (x.id === next.id ? next : x)))} />)}</ul>
      {reviews.length > 5 && <button type="button" className="btn-plain" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${reviews.length}`}</button>}
    </Part>
  );
}
