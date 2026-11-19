import { useState } from "react";
import { api } from "../../api";
import type { Act } from "./shared";

/** An item of the owner's own, last in the checklist (the client sees it on their page). */
export default function AddItem({ id, closed, act }: { id: string; closed: boolean; act: Act }) {
  const [label, setLabel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState<"text" | "files">("text");
  const [phase, setPhase] = useState<1 | 2>(1);

  const add = () => act(async () => {
    await api.post(`/onboardings/${id}/items`, { label, instructions, kind, phase });
    setLabel(""); setInstructions("");
  }, "Added. The client sees it on their page.");

  return (
    <details>
      <summary>Ask for something else</summary>
      <div className="deal-form">
        <label className="deal-field"><span>What you need (up to 120 characters)</span><input maxLength={120} value={label} disabled={closed} onChange={(e) => setLabel(e.target.value)} /></label>
        <label className="deal-field"><span>How to send it (up to 600 characters)</span><textarea rows={2} maxLength={600} value={instructions} disabled={closed} onChange={(e) => setInstructions(e.target.value)} /></label>
        <div className="field-row">
          <label className="deal-field"><span>They send</span>
            <select value={kind} disabled={closed} onChange={(e) => setKind(e.target.value as "text" | "files")}><option value="text">Text</option><option value="files">Files</option></select></label>
          <label className="deal-field"><span>Needed by</span>
            <select value={phase} disabled={closed} onChange={(e) => setPhase(e.target.value === "2" ? 2 : 1)}><option value="1">The first week (phase 1)</option><option value="2">The second week (phase 2)</option></select></label>
        </div>
        <div className="cp-actions"><button type="button" className="btn-ghost-sm" disabled={closed || !label.trim()} onClick={add}>Add to the checklist</button></div>
      </div>
    </details>
  );
}
