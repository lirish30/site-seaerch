import { useState } from "react";
import { MODE_LABEL, cropView, itemCrop, type CroAudit, type CroItem } from "../cro";

/** The only item fields the server lets a request change (it ignores anything else). */
export type CroItemPatch = Partial<Pick<CroItem, "title" | "observation" | "change" | "why" | "we_can_do_it" | "included" | "rank" | "horizon">>;
type EditKey = "title" | "observation" | "change" | "why" | "we_can_do_it";
const FIELDS: readonly (readonly [EditKey, string, number])[] = [
  ["title", "Title", 200], ["observation", "What we saw", 2000], ["change", "The change", 2000], ["why", "Why it matters", 2000], ["we_can_do_it", "We can do this", 500],
];
type Edit = Record<EditKey, string>;

export default function CroItemCard({ audit, item, n, compact, disabled, canUp, canDown, onPatch, onMove, onEvidence }: {
  audit: CroAudit; item: CroItem; n?: number; compact?: boolean; disabled?: boolean; canUp?: boolean; canDown?: boolean;
  /** Resolves true when saved; the edit form stays open when it doesn't, so nothing typed is lost. */
  onPatch: (p: CroItemPatch) => Promise<boolean>;
  onMove: (dir: -1 | 1) => void;
  onEvidence: (ids: string[], opener: HTMLElement) => void;
}) {
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saving, setSaving] = useState(false);
  const crop = compact ? null : itemCrop(item, audit.evidence);
  const v = crop ? cropView(crop, 300, 260) : null;
  const label = n ? `${n}. ${item.title}` : item.title;
  const movable = item.included;

  async function save() {
    if (!edit) return;
    const title = edit.title.trim();
    if (!title) return;
    setSaving(true);
    try { if (await onPatch({ ...edit, title })) setEdit(null); } finally { setSaving(false); }
  }

  return (
    <article className={`card cro-item${item.included ? "" : " excluded"}`} aria-label={item.title}>
      <header className="cro-item-head">
        <strong>{label}</strong>
        <span className="row">
          <span className={`badge mode-${item.mode}`}>{MODE_LABEL[item.mode]}</span>
          <span className="badge">{item.impact} impact · {item.effort} effort</span>
          {item.edited && <span className="badge">edited</span>}
          {!item.included && <span className="badge">hidden</span>}
        </span>
      </header>
      {edit ? (
        <form className="cro-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {FIELDS.map(([k, text, max]) => (
            <label key={k}>{text}
              <textarea rows={k === "title" ? 1 : 3} maxLength={max} required={k === "title"} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
            </label>
          ))}
          <div className="row">
            <button className="primary" type="submit" disabled={saving || !edit.title.trim()}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => setEdit(null)} disabled={saving}>Cancel</button>
          </div>
        </form>
      ) : compact ? <p className="small">{item.change}</p> : (
        <div className="cro-item-body">
          <div>
            <p><span className="muted small">What we saw</span><br />{item.observation}</p>
            <p><span className="muted small">The change</span><br />{item.change}</p>
            <p><span className="muted small">Why it matters</span><br />{item.why}</p>
            {item.we_can_do_it && <p className="cro-wcd">{item.we_can_do_it}</p>}
          </div>
          {v && crop && (
            <div className="cro-crop" role="img"
              aria-label={`${n ? `Marker ${n} on the` : "The"} ${crop.device === "mobile" ? "phone" : "desktop"} screenshot, showing where this goes: ${item.title}`}
              style={{ width: v.width, height: v.height, backgroundImage: `url(/api/cro-audits/${audit.id}/shot/${crop.pageIndex}/${crop.device})`,
                backgroundSize: `${v.bgWidth}px auto`, backgroundPosition: `${v.bgX}px ${v.bgY}px` }}>
              {n ? <span className="cro-pin" aria-hidden="true" style={{ left: v.markerX, top: v.markerY }}>{n}</span> : null}
            </div>
          )}
        </div>
      )}
      <footer className="cro-item-foot">
        <label className="row small check"><input type="checkbox" checked={item.included} disabled={disabled}
          onChange={(e) => { void onPatch({ included: e.target.checked }); }} />Include in deck &amp; emails</label>
        <button className="link-btn" aria-label={`Show evidence for "${item.title}"`} onClick={(e) => onEvidence(item.evidence_ids, e.currentTarget)}>Evidence ({item.evidence_ids.length})</button>
        {!edit && <button className="link-btn" aria-label={`Edit "${item.title}"`}
          onClick={() => setEdit({ title: item.title, observation: item.observation, change: item.change, why: item.why, we_can_do_it: item.we_can_do_it })}>Edit</button>}
        {movable && <>
          <button className="link-btn" aria-label={`Move "${item.title}" up`} disabled={disabled || !canUp} onClick={() => onMove(-1)}><span aria-hidden="true">↑</span></button>
          <button className="link-btn" aria-label={`Move "${item.title}" down`} disabled={disabled || !canDown} onClick={() => onMove(1)}><span aria-hidden="true">↓</span></button>
        </>}
      </footer>
    </article>
  );
}
