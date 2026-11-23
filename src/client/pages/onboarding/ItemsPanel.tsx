import { api } from "../../api";
import { Chip } from "../../components/ds";
import Icon, { type IconName } from "../../components/Icon";
import { itemActions, itemRows, sizeLabel, statusLabel } from "../../onboardingView";
import type { ItemStatus } from "../../../worker/db/onboardings";
import type { OwnerItem } from "../../../worker/onboarding/owner";
import { day, type Act } from "./shared";

const TONE: Record<ItemStatus, "warning" | "info" | "positive" | "outline"> = { waiting: "warning", received: "info", accepted: "positive", not_applicable: "outline" };
const TILE: Record<ItemStatus, { icon: IconName; tone: string }> = {
  waiting: { icon: "clock", tone: "warning" }, received: { icon: "inbox", tone: "info" }, accepted: { icon: "check", tone: "positive" }, not_applicable: { icon: "ban", tone: "neutral" },
};

/**
 * The checklist: what is waiting on the client first, then what has come in, then what is done. Each item is a row with a status tile, what was asked, what came back
 * (text or files) and what you can do with it. Everything the client wrote or named is shown as text and nothing else.
 */
export default function ItemsPanel({ items, closed, act }: { items: OwnerItem[]; closed: boolean; act: Act }) {
  if (items.length === 0) return <p className="slx-hint slx-pad">There is no checklist: this is a light onboarding (only the questionnaire).</p>;
  return (
    <ul className="onb-items slx-onb-items">
      {itemRows(items).map((i) => {
        const t = TILE[i.status];
        const acts = itemActions(i.status);
        return (
          <li key={i.id} className={`slx-onb-item ${i.status}`}>
            <span className={`ds-tile ${t.tone}`}><Icon name={t.icon} size={16} /></span>
            <div className="slx-onb-main">
              <div className="slx-onb-head">
                <b>{i.label}</b>
                <Chip tone={TONE[i.status]} dot>{statusLabel(i.status)}</Chip>
                <span className="slx-hint">{i.kind === "files" ? "Files" : "Text"} · {i.dueAt ? `due ${day(i.dueAt)}` : `week ${i.phase}`}{i.custom ? " · added by you" : ""}</span>
              </div>
              <p className="slx-hint">{i.instructions}</p>
              {i.textValue && <p className="onb-text slx-onb-text">{i.textValue}</p>}
              {i.files.length > 0 && (
                <ul className="onb-files slx-onb-files">
                  {i.files.map((f) => (
                    <li key={f.id}><Icon name="file-text" size={14} /><a href={`/api/onboarding-files/${encodeURIComponent(f.id)}`} download>{f.fileName}</a><span className="slx-hint">{sizeLabel(f.sizeBytes)}</span></li>
                  ))}
                </ul>
              )}
            </div>
            {acts.length > 0 && (
              <div className="slx-onb-acts">
                {acts.map((a) => (
                  <button key={a.status} type="button" className={`btn sm${a.status === "accepted" ? " primary" : ""}`} disabled={closed} onClick={() => act(() => api.patch(`/onboarding-items/${i.id}`, { status: a.status }))}>{a.label}</button>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
