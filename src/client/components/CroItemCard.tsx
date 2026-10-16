import { useId, useState } from "react";
import { MODE_LABEL, MODE_TONE, levelWord, cropView, itemCrop, type CroAudit, type CroItem } from "../cro";
import Icon from "./Icon";
import { Badge } from "./Score";

/** The only item fields the server lets a request change (it ignores anything else). */
export type CroItemPatch = Partial<Pick<CroItem, "title" | "observation" | "change" | "why" | "we_can_do_it" | "included" | "rank" | "horizon">>;
type EditKey = "title" | "observation" | "change" | "why" | "we_can_do_it";
const FIELDS: readonly (readonly [EditKey, string, number])[] = [
  ["title", "Title", 200], ["observation", "What we saw", 2000], ["change", "The change", 2000], ["why", "Why it matters", 2000], ["we_can_do_it", "We can do this", 500],
];
type Edit = Record<EditKey, string>;

/** "month" is a full "Do this month" card, "compact" a roadmap card that opens on click, "hidden" a row in "Hidden from the PDF and emails". */
export type CroCardVariant = "month" | "compact" | "hidden";

export default function CroItemCard({ audit, item, n, variant = "month", disabled, canUp, canDown, onPatch, onMove, onEvidence }: {
  audit: CroAudit; item: CroItem; n?: number; variant?: CroCardVariant; disabled?: boolean; canUp?: boolean; canDown?: boolean;
  /** Resolves true when saved; the edit form stays open when it doesn't, so nothing typed is lost. */
  onPatch: (p: CroItemPatch) => Promise<boolean>;
  onMove: (dir: -1 | 1) => void;
  onEvidence: (ids: string[], opener: HTMLElement) => void;
}) {
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(variant === "month"); // month cards start open; compact roadmap cards start closed
  const bodyId = useId();

  async function save() {
    if (!edit) return;
    const title = edit.title.trim();
    if (!title) return;
    setSaving(true);
    try { if (await onPatch({ ...edit, title })) setEdit(null); } finally { setSaving(false); }
  }

  if (variant === "hidden") {
    return (
      <label className="cro-hid">
        <input type="checkbox" className="cb" checked={false} disabled={disabled} onChange={() => { void onPatch({ included: true }); }} />
        <span>{item.title}</span><span className="sr-only"> (hidden; tick to include in the PDF and emails)</span>
      </label>
    );
  }

  const compact = variant === "compact";
  const crop = compact ? null : itemCrop(item, audit.evidence);
  const v = crop ? cropView(crop, 218, 112) : null;
  const shown = open || !!edit;

  const editForm = edit && (
    <form className="cro-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {FIELDS.map(([k, text, max]) => (
        <label key={k}><span className="cro-lbl">{text}</span>
          <textarea rows={k === "title" ? 1 : 3} maxLength={max} required={k === "title"} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
        </label>
      ))}
      <div className="cro-actions">
        <button className="btn primary sm" type="submit" disabled={saving || !edit.title.trim()}>{saving ? "Saving…" : "Save"}</button>
        <button className="btn sm" type="button" onClick={() => setEdit(null)} disabled={saving}>Cancel</button>
      </div>
    </form>
  );

  const foot = (
    <footer className="cro-foot">
      <label className="cro-inc"><input type="checkbox" className="cb" checked={item.included} disabled={disabled}
        onChange={(e) => { void onPatch({ included: e.target.checked }); }} />Include in PDF &amp; emails</label>
      <span className="cro-grow" />
      {item.included && <span className="cro-move">
        <button className="cro-ico" aria-label={`Move "${item.title}" up`} disabled={disabled || !canUp} onClick={() => onMove(-1)}><Icon name="chevron-down" size={14} className="flip" /></button>
        <button className="cro-ico" aria-label={`Move "${item.title}" down`} disabled={disabled || !canDown} onClick={() => onMove(1)}><Icon name="chevron-down" size={14} /></button>
      </span>}
      <button className="cro-link" aria-label={`Show evidence for "${item.title}"`} onClick={(e) => onEvidence(item.evidence_ids, e.currentTarget)}>Evidence ({item.evidence_ids.length})</button>
      {!edit && <button className="cro-link" aria-label={`Edit "${item.title}"`}
        onClick={() => setEdit({ title: item.title, observation: item.observation, change: item.change, why: item.why, we_can_do_it: item.we_can_do_it })}>Edit</button>}
      {!compact && <button className="cro-ico cro-chev" aria-expanded={open} aria-controls={bodyId} aria-label={`${open ? "Collapse" : "Expand"} "${item.title}"`} onClick={() => setOpen(!open)}><Icon name="chevron-down" size={14} /></button>}
    </footer>
  );

  if (compact) {
    return (
      <article className={`cro-mini${open || edit ? " open" : ""}`} aria-label={item.title}>
        <button className="cro-mini-t" aria-expanded={shown} aria-controls={bodyId} onClick={() => setOpen(!open)} disabled={!!edit}>{item.title}</button>
        <span className="cro-tags">
          <Badge tone={MODE_TONE[item.mode]}>{MODE_LABEL[item.mode]}</Badge>
          {item.edited && <Badge>edited</Badge>}
        </span>
        {shown && <div id={bodyId} className="cro-mini-more">
          {editForm || <p>{item.change}</p>}
          {foot}
        </div>}
      </article>
    );
  }

  return (
    <article className={`section-card cro-item${open ? "" : " collapsed"}`} aria-label={item.title}>
      <header className="cro-item-head">
        {n ? <span className="cro-num" aria-hidden="true">{n}</span> : null}
        <h4>{item.title}</h4>
        <Badge tone={MODE_TONE[item.mode]}>{MODE_LABEL[item.mode]}</Badge>
        <Badge tone="outline">{levelWord(item.impact)} impact · {levelWord(item.effort)} effort</Badge>
        {item.edited && <Badge>edited</Badge>}
      </header>
      <div id={bodyId} hidden={!shown}>
        {editForm ? <div className="cro-item-body">{editForm}</div> : (
          <div className="cro-item-body">
            <div className="cro-rows">
              <p><span>What we saw</span>{item.observation}</p>
              <p><span>The change</span>{item.change}</p>
              <p><span>Why it matters</span>{item.why}</p>
              {item.we_can_do_it && <div className="cro-wcd"><Icon name="zap" size={13} />{item.we_can_do_it}</div>}
            </div>
            {v && crop && (
              <div className="cro-shot" role="img"
                aria-label={`${n ? `Marker ${n} on the` : "The"} ${crop.device === "mobile" ? "phone" : "desktop"} screenshot, showing where this goes: ${item.title}`}>
                <div className="cro-shot-bar" aria-hidden="true"><i /><i /><i /></div>
                <div className="cro-shot-view" style={{ height: v.height, backgroundImage: `url(/api/cro-audits/${audit.id}/shot/${crop.pageIndex}/${crop.device}), var(--cro-skeleton)`,
                  backgroundSize: `${v.bgWidth}px auto, 218px 56px`, backgroundPosition: `${v.bgX}px ${v.bgY}px, 0 0` }}>
                  {n ? <span className="cro-pin" aria-hidden="true" style={{ left: v.markerX, top: v.markerY }}>{n}</span> : null}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {foot}
    </article>
  );
}
