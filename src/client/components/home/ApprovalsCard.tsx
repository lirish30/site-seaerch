import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "../Icon";
import { Chip } from "../ds";
import { approvalLink, canBulkApprove, draftedByLabel, parsePayloadText, whenLabel, type ApprovalGroup, type ApprovalItem } from "../../approvalsView";
import { approvalChip, approvalIcon, approvalSub } from "../../todayHome";

type Mode = "review" | "edit" | "reject";

/**
 * Everything Claude has drafted that is waiting for your OK, as rows inside Home's "Needs you" card: one group per kind with
 * "Approve all" where a batch is safe. Each row opens to show exactly what will go out, then Approve, Edit then approve, or Reject.
 */
export default function ApprovalGroups({ groups, errs, busy, onApprove, onReject, onApproveAll, limit, onShowAll }: {
  groups: ApprovalGroup[]; errs: Readonly<Record<string, string>>; busy: ReadonlySet<string>;
  onApprove: (a: ApprovalItem, payload?: unknown) => void; onReject: (a: ApprovalItem, note: string) => void; onApproveAll: (items: ApprovalItem[]) => void;
  /** Show only the first rows (the All view); the rest are one click away. */ limit?: number; onShowAll?: () => void;
}) {
  const all = groups.flatMap((g) => g.items);
  const shown = limit !== undefined ? all.slice(0, limit) : all;
  const bulk = groups.filter((g) => canBulkApprove(g.kind) && g.items.length > 1);
  return (
    <div className="hox-group" role="group" aria-label="Waiting for your OK">
      <div className="hox-group-head">
        <span>Waiting for your OK<b>{all.length}</b></span>
        {bulk.map((g) => (
          <button key={g.kind} type="button" className="btn sm" disabled={g.items.some((a) => busy.has(a.id))} onClick={() => onApproveAll(g.items)}
            title={`${g.label}: approve all ${g.items.length} at once`}><Icon name="check" size={14} />Approve all {g.items.length} {bulkNoun(g)}</button>
        ))}
      </div>
      <ul className="hox-rows">
        {shown.map((a) => <ApprovalRow key={a.id} item={a} error={errs[a.id]} busy={busy.has(a.id)} onApprove={onApprove} onReject={onReject} />)}
      </ul>
      {shown.length < all.length && onShowAll && (
        <button type="button" className="hox-more" onClick={onShowAll}>Show all {all.length} approvals<Icon name="chevron-right" size={14} /></button>
      )}
    </div>
  );
}

/** "emails", "notes": what an Approve-all button approves, from its group. */
const bulkNoun = (g: ApprovalGroup) => (g.kind.startsWith("email") ? "emails" : g.kind.startsWith("invoice") ? "reminders" : g.kind.startsWith("lead.note") ? "notes" : "");

function ApprovalRow({ item, error, busy, onApprove, onReject }: {
  item: ApprovalItem; error: string | undefined; busy: boolean;
  onApprove: (a: ApprovalItem, payload?: unknown) => void; onReject: (a: ApprovalItem, note: string) => void;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [parseErr, setParseErr] = useState("");
  const link = approvalLink(item);
  const tile = approvalIcon(item.kind), chip = approvalChip(item.kind);

  const openEdit = () => { setText(JSON.stringify(item.payload ?? null, null, 2)); setParseErr(""); setMode("edit"); };
  const submitEdit = () => {
    const r = parsePayloadText(text);
    if (!r.ok) { setParseErr(r.error); return; }
    setParseErr(""); onApprove(item, r.value);
  };

  return (
    <li className={`hox-row-wrap${mode ? " open" : ""}`}>
      <div className="hox-row">
        <span className={`ds-tile ${tile.tone}`} aria-hidden="true"><Icon name={tile.icon} size={16} /></span>
        <div className="hox-row-main">
          <p className="hox-row-title"><span className="hox-what">{item.title}</span></p>
          <p className="hox-row-sub">{approvalSub(item.preview)}</p>
          <p className="hox-row-meta">{draftedByLabel(item.drafted_by)} · {whenLabel(item.created_at)}</p>
        </div>
        <div className="hox-row-acts">
          {error || item.error ? <Chip tone="critical" dot>{error ? "Didn't go" : "Failed last time"}</Chip> : <Chip tone={chip.tone}>{chip.label}</Chip>}
          <button type="button" className="btn sm" aria-expanded={mode !== null} aria-label={`${mode ? "Close" : "Review"}: ${item.title}`}
            onClick={() => setMode(mode ? null : "review")}>{mode ? "Close" : "Review"}</button>
        </div>
      </div>
      {(error || parseErr) ? <p className="hox-row-err" role="alert"><Icon name="alert" size={14} />{error || parseErr}</p>
        : item.error ? <p className="hox-row-err"><Icon name="alert" size={14} />Last try didn't go: {item.error}</p> : null}
      {mode && (
        <div className="hox-review">
          {mode === "review" && (
            <>
              <p className="ds-label">What will go out</p>
              <pre className="hox-preview">{item.preview}</pre>
              {link && <Link to={link.to} className="hox-inline-link"><Icon name="arrow-up-right" size={14} />{link.label}</Link>}
              <div className="hox-review-acts">
                <button type="button" className="btn sm primary" disabled={busy} aria-label={`Approve: ${item.title}`} onClick={() => onApprove(item)}><Icon name="check" size={14} />Approve</button>
                <button type="button" className="btn sm" disabled={busy} aria-label={`Edit then approve: ${item.title}`} onClick={openEdit}><Icon name="pen" size={14} />Edit then approve</button>
                <button type="button" className="btn sm" disabled={busy} aria-label={`Reject: ${item.title}`} onClick={() => { setNote(""); setMode("reject"); }}><Icon name="x" size={14} />Reject</button>
              </div>
            </>
          )}
          {mode === "edit" && (
            <>
              <label className="deal-field" htmlFor={`edit-${item.id}`}><span>Edit what will be sent (JSON)</span></label>
              <textarea id={`edit-${item.id}`} className="hox-json" rows={8} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
              <div className="hox-review-acts">
                <button type="button" className="btn sm primary" disabled={busy} onClick={submitEdit}>Approve with edits</button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => setMode("review")}>Cancel</button>
              </div>
            </>
          )}
          {mode === "reject" && (
            <>
              <label className="deal-field hox-note-field">
                <span>Why not? (optional)</span>
                <input id={`note-${item.id}`} type="text" maxLength={500} value={note} placeholder="What should change" onChange={(e) => setNote(e.target.value)} />
              </label>
              <div className="hox-review-acts">
                <button type="button" className="btn sm" disabled={busy} onClick={() => onReject(item, note)}>Reject</button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => setMode("review")}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}
