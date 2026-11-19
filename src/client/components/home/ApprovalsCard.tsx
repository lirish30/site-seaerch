import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "../Icon";
import { approvalLink, approvalsLine, canBulkApprove, draftedByLabel, groupApprovals, parsePayloadText, whenLabel, type ApprovalItem } from "../../approvalsView";
import type { Part } from "./useHome";

type Mode = "edit" | "reject";

/** Everything Claude has drafted that is waiting for your OK: approve, edit then approve, reject, or approve a whole group. */
export default function ApprovalsCard({ approvals, errs, busy, onApprove, onReject, onApproveAll, onRetry }: {
  approvals: Part<ApprovalItem[]>; errs: Readonly<Record<string, string>>; busy: ReadonlySet<string>;
  onApprove: (a: ApprovalItem, payload?: unknown) => void; onReject: (a: ApprovalItem, note: string) => void;
  onApproveAll: (items: ApprovalItem[]) => void; onRetry: () => void;
}) {
  const items = approvals.data;
  const groups = useMemo(() => groupApprovals(items ?? []), [items]);
  const failed = items ? items.filter((a) => errs[a.id]) : [];
  return (
    <section className="hm-card hm-approvals" id="approvals" aria-labelledby="hm-appr-h">
      <header className="hm-card-head">
        <Icon name="check" size={16} />
        <h2 id="hm-appr-h">Waiting for your OK</h2>
        {items && <span className="hm-head-note small">{approvalsLine(items.length)}</span>}
      </header>
      {!items && approvals.error ? (
        <div className="hm-state sm" role="alert"><p>{approvals.error}</p><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : !items ? (
        <div className="hm-card-body"><i className="hm-skel" style={{ width: "60%", height: 18 }} /></div>
      ) : groups.length === 0 ? (
        <div className="hm-state sm"><p>{approvalsLine(0)}</p></div>
      ) : (
        groups.map((g) => {
          const groupBusy = g.items.some((a) => busy.has(a.id));
          return (
            <div className="hm-appr-group" key={g.kind}>
              <div className="hm-appr-ghead">
                <h3>{g.label} <span>{g.items.length}</span></h3>
                {canBulkApprove(g.kind) && <button type="button" className="btn sm" disabled={groupBusy} onClick={() => onApproveAll(g.items)}>Approve all {g.items.length}</button>}
              </div>
              <ul className="hm-appr-list">
                {g.items.map((a) => (
                  <ApprovalRow key={a.id} item={a} error={errs[a.id]} busy={busy.has(a.id)} onApprove={onApprove} onReject={onReject} />
                ))}
              </ul>
            </div>
          );
        })
      )}
      {/* Errors are read out as they appear; the same text also sits beside the item that failed. */}
      <div className="sr-only" aria-live="polite" role="status">{failed.map((a) => `${a.title}: ${errs[a.id]}`).join(". ")}</div>
    </section>
  );
}

function ApprovalRow({ item, error, busy, onApprove, onReject }: {
  item: ApprovalItem; error: string | undefined; busy: boolean;
  onApprove: (a: ApprovalItem, payload?: unknown) => void; onReject: (a: ApprovalItem, note: string) => void;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [parseErr, setParseErr] = useState("");
  const link = approvalLink(item);

  const openEdit = () => { setText(JSON.stringify(item.payload ?? null, null, 2)); setParseErr(""); setMode("edit"); };
  const submitEdit = () => {
    const r = parsePayloadText(text);
    if (!r.ok) { setParseErr(r.error); return; }
    setParseErr(""); onApprove(item, r.value);
  };

  return (
    <li className="hm-row hm-appr-row">
      <div className="hm-main">
        <p className="hm-name">{item.title}</p>
        <p className="hm-reason">{item.preview}</p>
        {link && <p className="hm-appr-meta"><Link to={link.to}>{link.label}</Link></p>}
        <p className="hm-appr-meta">{draftedByLabel(item.drafted_by)} · {whenLabel(item.created_at)}</p>
        {(error || parseErr) && <p className="hm-err">{error || parseErr}</p>}
        {mode === "edit" && (
          <div className="hm-appr-form">
            <label htmlFor={`edit-${item.id}`}>Edit what will be sent (JSON)</label>
            <textarea id={`edit-${item.id}`} rows={6} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
            <div className="hm-appr-formacts">
              <button type="button" className="btn sm primary" disabled={busy} onClick={submitEdit}>Approve with edits</button>
              <button type="button" className="btn sm" disabled={busy} onClick={() => setMode(null)}>Cancel</button>
            </div>
          </div>
        )}
        {mode === "reject" && (
          <div className="hm-appr-form">
            <label htmlFor={`note-${item.id}`}>Note (optional)</label>
            <input id={`note-${item.id}`} type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="hm-appr-formacts">
              <button type="button" className="btn sm" disabled={busy} onClick={() => onReject(item, note)}>Reject</button>
              <button type="button" className="btn sm" disabled={busy} onClick={() => setMode(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      {mode === null && (
        <div className="hm-acts">
          <button type="button" className="btn sm primary" disabled={busy} aria-label={`Approve: ${item.title}`} onClick={() => onApprove(item)}>Approve</button>
          <button type="button" className="btn sm" disabled={busy} aria-label={`Edit then approve: ${item.title}`} onClick={openEdit}>Edit</button>
          <button type="button" className="btn sm" disabled={busy} aria-label={`Reject: ${item.title}`} onClick={() => { setNote(""); setMode("reject"); }}>Reject</button>
        </div>
      )}
    </li>
  );
}
