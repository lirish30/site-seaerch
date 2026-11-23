import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { strategyApi } from "../../api";
import { latestOnly } from "../../clientView";
import { memoView, revokeQuestion, type MemoRow } from "../../strategyMemoView";
import Icon from "../Icon";
import { copyText, Say, sentence } from "./seo/seoBits";
import { Card } from "../ds";

/** The client's link in a box to select, and a button that copies it. A copy that is refused says so and leaves the link to copy by hand. */
function LinkBox({ link }: { link: string }) {
  const [note, setNote] = useState("");
  async function copy() { setNote((await copyText(link)) ? "Link copied." : "Could not copy: select the link and copy it by hand."); }
  return (
    <div className="rp-link">
      <label className="rp-link-label small" htmlFor="sm-link">Link to the memo page</label>
      <div className="rp-link-row">
        <input id="sm-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn" onClick={() => void copy()}><Icon name="copy" size={16} />Copy link</button>
      </div>
      {note && <p className="small muted" role="status">{note}</p>}
    </div>
  );
}

/**
 * The Strategy memo section of a client's page (Plan 16): the newest memo's status in plain words, the button that drafts one, "Try again" while Claude is still writing, "Revoke" (after a question) once there
 * is something to take back, and the client's link once it has been sent. Nothing here sends anything: the mail goes out only when its approval is approved on Home. A refusal shows the server's sentence.
 */
export default function StrategyMemoSection({ businessId, tz }: { businessId: string; tz: string }) {
  const [rows, setRows] = useState<MemoRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [guard] = useState(latestOnly);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const next = await strategyApi.list(businessId);
      if (guard.isLatest(ticket)) { setRows(next); setFailed(false); }
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [businessId, guard]);
  useEffect(() => { setRows(null); setFailed(false); setAsking(false); setError(""); void load(); return () => guard.cancel(); }, [load, guard]);

  /** Runs one change and reloads, whatever happened, so the section never shows a state the server has left. */
  async function run(name: string, fail: string, job: () => Promise<void>) {
    if (busy) return;
    setBusy(name); setError("");
    try { await job(); setAsking(false); }
    catch (e) { setError(sentence(e, fail)); }
    finally { await load(); setBusy(""); }
  }

  const v = rows === null ? null : memoView(rows, tz);
  const latest = v?.latest ?? null;
  const sent = latest?.status === "sent";
  return (
    <Card icon="file-text" title="Strategy memo" note={latest ? `Version ${latest.version}` : undefined}>
      {failed && <p className="error small" role="alert">Couldn’t load the memo. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p>}
      {rows === null && !failed && <p className="clx-muted">Loading…</p>}
      {v && (
        <>
          <div className="clx-memo-state">
            <span className={`ds-tile ${sent ? "positive" : latest?.status === "ready" ? "signal" : "neutral"}`}><Icon name={sent ? "check" : "file-text"} size={15} /></span>
            <span className="clx-setup-text" role="status">
              <b>{v.status ?? "No memo yet"}{v.test && <> <span className="badge2 outline">Test</span></>}</b>
              <small>{v.status === null ? "A one-page plan in plain words: where the client stands on Google, three priorities and what you need from them." : latest?.status === "ready" ? "Waiting for you on Home. Nothing is mailed before you approve it." : "Written by Claude from what Google counted for this client."}</small>
            </span>
          </div>
          {latest?.status === "ready" && <p><Link to="/today" className="btn sm">Open Home to read and approve it</Link></p>}
          {v.link && <LinkBox link={v.link} />}
          {(v.draft || v.tryAgain || (v.revoke && !asking)) && (
            <div className="rp-actions">
              {v.draft && <button type="button" className={`btn${latest ? "" : " primary"}`} aria-disabled={!!busy} onClick={() => void run("draft", "Couldn’t start the memo. Try again.", async () => { await strategyApi.start(businessId); })}><Icon name="sparkles" size={16} />{busy === "draft" ? "Starting…" : latest ? "Draft a new memo" : "Draft strategy memo"}</button>}
              {v.tryAgain && latest && (
                <button type="button" className="btn" aria-disabled={!!busy} onClick={() => void run("again", "Couldn’t start again. Try again.", async () => { await strategyApi.cancel(businessId, latest.id); await strategyApi.start(businessId); })}>
                  {busy === "again" ? "Starting again…" : "Try again"}
                </button>
              )}
              <span className="ds-grow" />
              {v.revoke && latest && !asking && <button type="button" className="btn-plain clx-danger" onClick={() => setAsking(true)}>Revoke</button>}
            </div>
          )}
          {v.revoke && latest && asking && (
            <div className="clx-confirm" role="group" aria-label="Take this memo back?">
              <span>{revokeQuestion(latest)}</span>
              <div className="ds-row">
                <button type="button" className="btn sm" aria-disabled={!!busy} onClick={() => void run("revoke", "Couldn’t take it back. Try again.", async () => { await strategyApi.revoke(businessId, latest.id); })}>Yes, take it back</button>
                <button type="button" className="btn-plain" onClick={() => setAsking(false)}>Keep it</button>
              </div>
            </div>
          )}
        </>
      )}
      <Say error={error} />
    </Card>
  );
}
