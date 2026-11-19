import { api } from "../../api";
import { itemActions, itemRows, sizeLabel, statusLabel } from "../../onboardingView";
import type { ItemStatus } from "../../../worker/db/onboardings";
import type { OwnerItem } from "../../../worker/onboarding/owner";
import { day, type Act } from "./shared";

const TONE: Record<ItemStatus, string> = { waiting: "warning", received: "info", accepted: "positive", not_applicable: "outline" };

/** The checklist: what is waiting on the client first, then what has come in. Everything the client wrote or named is shown as text and nothing else. */
export default function ItemsPanel({ items, closed, act }: { items: OwnerItem[]; closed: boolean; act: Act }) {
  if (items.length === 0) return <p className="muted small">There is no checklist: this is a light onboarding (only the questionnaire).</p>;
  return (
    <ul className="onb-items">
      {itemRows(items).map((i) => (
        <li key={i.id} className="onb-item">
          <div className="cp-actions">
            <strong>{i.label}</strong>
            <span className={`badge2 ${TONE[i.status]}`}><i className="dot" />{statusLabel(i.status)}</span>
            <span className="muted small">Phase {i.phase}{i.dueAt ? `, due ${day(i.dueAt)}` : ""}{i.custom ? ", added by you" : ""}</span>
          </div>
          <p className="muted small">{i.instructions}</p>
          {i.textValue && <p className="onb-text">{i.textValue}</p>}
          {i.files.length > 0 && (
            <ul className="onb-files">
              {i.files.map((f) => (
                <li key={f.id}><a href={`/api/onboarding-files/${encodeURIComponent(f.id)}`} download>{f.fileName}</a> <span className="muted small">{sizeLabel(f.sizeBytes)}</span></li>
              ))}
            </ul>
          )}
          <div className="cp-actions">
            {itemActions(i.status).map((a) => (
              <button key={a.status} type="button" className="btn-ghost-sm" disabled={closed} onClick={() => act(() => api.patch(`/onboarding-items/${i.id}`, { status: a.status }))}>{a.label}</button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
