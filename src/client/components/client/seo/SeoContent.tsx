import { useEffect, useState } from "react";
import { seoApi, type SeoOverview } from "../../../api";
import { safeHref } from "../../../clientView";
import { CONTENT_LIMITS, DRAFT_STUCK_TEXT, contentByMonth, contentCopy, contentStatusLabel, draftStuck, contentStatusTone, kindLabel, type ContentItem } from "../../../seoView";
import { CopyButton, Part, Say, sentence } from "./seoBits";

type Mode = "" | "publish" | "reject";

/**
 * One piece of the month's content. Its title, brief and words are text (Claude's or Logan's): nothing in them is followed or rendered as markup. The app puts nothing on the client's site or Google profile:
 * the owner copies the words, puts them live himself, and "Mark published" only records that he did.
 */
function ContentCard({ item, onChanged }: { item: ContentItem; onChanged: (next: ContentItem) => void }) {
  const gbp = item.kind === "gbp_post";
  const [title, setTitle] = useState(item.title);
  const [metaTitle, setMetaTitle] = useState(item.metaTitle);
  const [metaDescription, setMetaDescription] = useState(item.metaDescription);
  const [body, setBody] = useState(item.body);
  const [mode, setMode] = useState<Mode>("");
  const [reason, setReason] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setTitle(item.title); setMetaTitle(item.metaTitle); setMetaDescription(item.metaDescription); setBody(item.body); }, [item.title, item.metaTitle, item.metaDescription, item.body]);
  const editable = item.status === "drafted" || item.status === "approved";
  const dirty = title !== item.title || metaTitle !== item.metaTitle || metaDescription !== item.metaDescription || body !== item.body;
  async function run(what: string, f: () => Promise<ContentItem>, fallback: string) {
    if (busy) return;
    setBusy(what); setError(""); setSaved(false);
    try { onChanged(await f()); if (what === "save") setSaved(true); setMode(""); }
    catch (e) { setError(sentence(e, fallback)); }
    finally { setBusy(""); }
  }
  const live = safeHref(item.url);
  const canReject = item.status === "planned" || item.status === "drafting" || item.status === "drafted" || item.status === "approved";
  return (
    <li className="sx-content">
      <div className="sx-review-head">
        <b>{kindLabel(item.kind)}</b>
        <span className={`badge2${contentStatusTone(item.status) ? ` ${contentStatusTone(item.status)}` : ""}`}><i className="dot" aria-hidden="true" />{contentStatusLabel(item.status)}</span>
      </div>
      <p className="small muted sx-review-by">{item.brief}</p>
      {draftStuck(item) && <p className="small cr-note" role="status">{DRAFT_STUCK_TEXT}</p>}
      {!editable && item.title && <p className="sx-content-title">{item.title}</p>}
      {item.status === "published" && live && <p className="small"><a href={live} target="_blank" rel="noopener noreferrer">Open the live page</a></p>}
      {editable && (
        <div className="sx-draft">
          <label className="deal-field" htmlFor={`ct-${item.id}`}><span>Title ({title.length} of {CONTENT_LIMITS.title})</span>
            <input id={`ct-${item.id}`} value={title} maxLength={CONTENT_LIMITS.title} onChange={(e) => { setTitle(e.target.value); setSaved(false); }} />
          </label>
          {!gbp && (
            <>
              <label className="deal-field" htmlFor={`cm-${item.id}`}><span>Meta title ({metaTitle.length} of {CONTENT_LIMITS.metaTitle})</span>
                <input id={`cm-${item.id}`} value={metaTitle} maxLength={CONTENT_LIMITS.metaTitle} onChange={(e) => { setMetaTitle(e.target.value); setSaved(false); }} />
              </label>
              <label className="deal-field" htmlFor={`cd-${item.id}`}><span>Meta description ({metaDescription.length} of {CONTENT_LIMITS.metaDescription})</span>
                <input id={`cd-${item.id}`} value={metaDescription} maxLength={CONTENT_LIMITS.metaDescription} onChange={(e) => { setMetaDescription(e.target.value); setSaved(false); }} />
              </label>
            </>
          )}
          <label className="deal-field" htmlFor={`cb-${item.id}`}><span>{gbp ? "Post" : "Body"} ({body.length.toLocaleString("en-US")} of {(gbp ? CONTENT_LIMITS.gbpBody : CONTENT_LIMITS.body).toLocaleString("en-US")})</span>
            <textarea id={`cb-${item.id}`} rows={gbp ? 5 : 10} maxLength={gbp ? CONTENT_LIMITS.gbpBody : CONTENT_LIMITS.body} value={body} onChange={(e) => { setBody(e.target.value); setSaved(false); }} />
          </label>
          <div className="sx-actions">
            <button type="button" className="btn" aria-disabled={!!busy || !dirty} onClick={() => { if (dirty) void run("save", () => seoApi.editContent(item.id, gbp ? { title, body } : { title, metaTitle, metaDescription, body }), "Couldn’t save the words. Try again."); }}>Save my words</button>
            <CopyButton text={contentCopy({ kind: item.kind, title, body })} label="Copy text" />
            {item.status === "drafted" && !dirty && <button type="button" className="btn primary" aria-disabled={!!busy} onClick={() => void run("approve", () => seoApi.approveContent(item.id), "Couldn’t approve it. Try again.")}>Approve</button>}
            {item.status === "approved" && !dirty && mode !== "publish" && <button type="button" className="btn primary" onClick={() => { setMode("publish"); setError(""); }}>Mark published</button>}
          </div>
          {dirty && item.status === "drafted" && <p className="small muted">Save your changes before approving.</p>}
          {item.status === "approved" && <p className="small muted sx-help">Put it on the site or profile yourself, then press Mark published. Nothing is published from here.</p>}
        </div>
      )}
      {mode === "publish" && (
        <div className="sx-ask-block" role="group" aria-label="Mark as published">
          <label className="deal-field" htmlFor={`cu-${item.id}`}><span>Address of the live page (optional, https)</span>
            <input id={`cu-${item.id}`} inputMode="url" value={url} maxLength={500} placeholder="https://" autoComplete="off" onChange={(e) => setUrl(e.target.value)} />
          </label>
          <div className="sx-actions">
            <button type="button" className="btn primary" aria-disabled={!!busy} onClick={() => void run("publish", () => seoApi.markPublished(item.id, url.trim() || undefined), "Couldn’t mark it. Try again.")}>Yes, I put it live</button>
            <button type="button" className="btn-plain" onClick={() => setMode("")}>Not yet</button>
          </div>
        </div>
      )}
      {mode === "reject" && (
        <div className="sx-ask-block" role="group" aria-label="Reject this piece">
          <label className="deal-field" htmlFor={`cr-${item.id}`}><span>Why? (3 to 300 characters; it goes in the client’s timeline)</span>
            <input id={`cr-${item.id}`} value={reason} maxLength={300} autoComplete="off" onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="sx-actions">
            <button type="button" className="btn" aria-disabled={!!busy || reason.trim().length < 3} onClick={() => { if (reason.trim().length >= 3) void run("reject", () => seoApi.rejectContent(item.id, reason.trim()), "Couldn’t reject it. Try again."); }}>Reject it</button>
            <button type="button" className="btn-plain" onClick={() => setMode("")}>Keep it</button>
          </div>
        </div>
      )}
      {canReject && mode === "" && <button type="button" className="btn-plain sx-reject" onClick={() => { setMode("reject"); setError(""); }}>Reject</button>}
      <Say error={error} ok={saved ? "Saved." : undefined} />
    </li>
  );
}

/** The month's pages and posts and Google posts: Claude drafts them, Logan edits, approves, puts them live himself and marks them published. A rejected slot is not planned again that month. */
export function Content({ content, onChanged }: { content: SeoOverview["content"]; onChanged: (next: SeoOverview["content"]) => void }) {
  const months = contentByMonth(content);
  const waiting = content.filter((c) => c.status === "drafted").length;
  const swap = (next: ContentItem) => onChanged(content.map((x) => (x.id === next.id ? next : x)));
  const [first, ...earlier] = months;
  return (
    <Part title="Content" help={content.length ? `${waiting === 0 ? "Nothing is waiting for you." : `${waiting} ${waiting === 1 ? "piece is" : "pieces are"} waiting for you.`} Claude writes the drafts; you put them live yourself.` : undefined}>
      {content.length === 0 && <p className="small muted">No content planned yet. The plan’s pages and posts are set up at the start of each month once there is a search term.</p>}
      {first && (
        <>
          <h4 className="sx-month">{first.label}</h4>
          <ul className="sx-contents">{first.items.map((i) => <ContentCard key={i.id} item={i} onChanged={swap} />)}</ul>
        </>
      )}
      {earlier.length > 0 && (
        <details className="sx-more">
          <summary>Earlier months ({earlier.length})</summary>
          {earlier.map((m) => (
            <div key={m.period}>
              <h4 className="sx-month">{m.label}</h4>
              <ul className="sx-contents">{m.items.map((i) => <ContentCard key={i.id} item={i} onChanged={swap} />)}</ul>
            </div>
          ))}
        </details>
      )}
    </Part>
  );
}
