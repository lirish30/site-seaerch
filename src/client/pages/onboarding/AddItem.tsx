import { useState } from "react";
import { api } from "../../api";
import Icon from "../../components/Icon";
import type { Act } from "./shared";

/** An item of the owner's own, last in the checklist (the client sees it on their page). A button under the checklist opens the short form. */
export default function AddItem({ id, closed, act }: { id: string; closed: boolean; act: Act }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState<"text" | "files">("text");
  const [phase, setPhase] = useState<1 | 2>(1);

  const add = () => act(async () => {
    await api.post(`/onboardings/${id}/items`, { label, instructions, kind, phase });
    setLabel(""); setInstructions(""); setOpen(false);
  }, "Added. The client sees it on their page.");

  if (!open) {
    return (
      <div className="slx-add-row">
        <button type="button" className="btn sm" disabled={closed} onClick={() => setOpen(true)}><Icon name="plus" size={14} />Ask for something else</button>
        <span className="slx-hint">It goes at the end of the client’s checklist.</span>
      </div>
    );
  }
  return (
    <form className="ds-form slx-add-form" onSubmit={(e) => { e.preventDefault(); if (label.trim()) void add(); }}>
      <label className="deal-field wide"><span>What you need</span><input maxLength={120} value={label} disabled={closed} autoFocus placeholder="Like: your Google Business Profile login owner" onChange={(e) => setLabel(e.target.value)} />
        <small>Up to 120 characters. This is the title the client sees.</small></label>
      <label className="deal-field wide"><span>How to send it</span><textarea rows={2} maxLength={600} value={instructions} disabled={closed} placeholder="One or two lines on what counts and how to send it" onChange={(e) => setInstructions(e.target.value)} /></label>
      <label className="deal-field"><span>They send</span>
        <select value={kind} disabled={closed} onChange={(e) => setKind(e.target.value as "text" | "files")}><option value="text">Text</option><option value="files">Files</option></select></label>
      <label className="deal-field"><span>Needed by</span>
        <select value={phase} disabled={closed} onChange={(e) => setPhase(e.target.value === "2" ? 2 : 1)}><option value="1">The first week</option><option value="2">The second week</option></select></label>
      <div className="ds-form-actions">
        <button type="submit" className="btn primary" disabled={closed || !label.trim()}>Add to the checklist</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
