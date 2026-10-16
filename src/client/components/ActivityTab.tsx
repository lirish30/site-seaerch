import { useRef, useState } from "react";
import { ACTIVITY_FILTERS, describeActivity, filterOf, groupActivity, whenLabel, type ActivityFilter } from "../activityView";
import { followUpLabel } from "../leadView";
import { initials } from "../scoreView";
import type { Activity } from "../types";
import Icon from "./Icon";

/** The lead's timeline: a note box on top, filter pills, then events grouped by when they happened. */
export default function ActivityTab({ items, userName, followUp, onAddNote, onSetFollowUp }: {
  items: Activity[]; userName: string; followUp: string | null;
  onAddNote: (text: string) => Promise<boolean>; onSetFollowUp: (date: string | null) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const date = useRef<HTMLInputElement>(null);
  const counts = Object.fromEntries(ACTIVITY_FILTERS.map((f) => [f.key, f.key === "all" ? items.length : items.filter((a) => filterOf(a.kind) === f.key).length])) as Record<ActivityFilter, number>;
  const shown = filter === "all" ? items : items.filter((a) => filterOf(a.kind) === filter);
  const groups = groupActivity(shown);

  async function add() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try { if (await onAddNote(t)) setText(""); } finally { setBusy(false); }
  }

  return (
    <div className="activity-tab">
      <section className="note-composer" aria-label="Add a note">
        <div className="nc-top">
          <span className="avatar-sm" aria-hidden="true">{userName ? initials(userName) : "·"}</span>
          <textarea rows={1} placeholder="Add a note, e.g. what you talked about or what to do next…" aria-label="Note" value={text} maxLength={2000}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void add(); } }} />
        </div>
        <div className="nc-bar">
          <button className="nc-follow" onClick={() => date.current?.showPicker?.()}><Icon name="calendar" size={14} />{followUp ? `Follow up ${followUpLabel(followUp)}` : "Set follow-up"}</button>
          <input ref={date} type="date" className="sr-date" aria-label="Follow-up date" value={followUp ?? ""} onChange={(e) => void onSetFollowUp(e.target.value || null)} />
          <span className="grow" />
          <button className="btn primary sm" onClick={() => void add()} disabled={!text.trim() || busy}>{busy ? "Adding…" : "Add note"}</button>
        </div>
      </section>

      <div className="filter-pills" role="group" aria-label="Filter activity">
        {ACTIVITY_FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? "on" : ""} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label} {counts[f.key]}</button>
        ))}
      </div>

      {groups.length === 0 && <p className="muted">{items.length ? "Nothing here under this filter." : "Nothing yet. Notes, stage changes, drafts and re-audits show up here."}</p>}
      {groups.map((g) => (
        <section key={g.label} className="act-group" aria-label={g.label}>
          <p className="kicker">{g.label}</p>
          <ol className="events">
            {g.items.map((a, i) => {
              const v = describeActivity(a);
              return (
                <li key={a.id} className="event">
                  <span className="ev-rail"><span className={`ev-ico ${v.tone}`}><Icon name={v.icon} size={14} /></span>{i < g.items.length - 1 && <i className="ev-line" />}</span>
                  <div className="ev-body">
                    <div className="ev-head"><b>{v.title}</b><time dateTime={a.created_at}>{whenLabel(a.created_at)}</time></div>
                    {v.detail && (v.bubble ? <p className="ev-note">{v.detail}</p> : <p className="ev-detail">{v.detail}</p>)}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
