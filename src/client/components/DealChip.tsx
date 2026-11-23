import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { STAGE_LABEL, type DealStage } from "../pipelineView";
import Icon from "./Icon";

interface OpenDeal { id: string; stage: DealStage }

/** The lead's open deal as a stage chip linking to the board, or "Start a deal" when it has none. */
export default function DealChip({ leadId, onChanged }: { leadId: string; onChanged?: () => void }) {
  const [deal, setDeal] = useState<OpenDeal | null | undefined>(undefined); // undefined while loading
  const [form, setForm] = useState(false);
  const [skipCall, setSkipCall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setDeal(undefined); setForm(false); setError("");
    api.get<(OpenDeal & { businessId: string })[]>("/deals?open=1")
      .then((all) => { if (live) setDeal(all.find((d) => d.businessId === leadId) ?? null); })
      .catch(() => { if (live) setDeal(null); });
    return () => { live = false; };
  }, [leadId]);

  async function start() {
    setBusy(true); setError("");
    try {
      const d = await api.post<OpenDeal>(`/leads/${leadId}/deal`, skipCall ? { skipCall: true } : {});
      setDeal(d); setForm(false); onChanged?.();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Couldn’t start the deal. Try again."); }
    finally { setBusy(false); }
  }

  if (deal === undefined) return null;
  if (deal) return <Link to={`/deals/${encodeURIComponent(deal.id)}`} className="chip-link clx-lead-deal" title="Open the deal"><Icon name="kanban" size={13} />Deal: {STAGE_LABEL[deal.stage]}<Icon name="arrow-right" size={12} /></Link>;
  return (
    <span className="clx-lead-dealwrap">
      <button type="button" className="chip-link clx-lead-deal-start" aria-expanded={form} onClick={() => { setForm((f) => !f); setError(""); }}><Icon name="plus" size={13} />Start a deal</button>
      {form && (
        <span className="clx-lead-pop" role="dialog" aria-label="Start a deal">
          <b>Start a deal</b>
          <small>It goes on the pipeline board under Call booked.</small>
          <label className="clx-lead-check">
            <input type="checkbox" className="cb" checked={skipCall} onChange={(e) => setSkipCall(e.target.checked)} />
            <span>Skip the call<small>Start it at Discovery done, so you can send a proposal straight away.</small></span>
          </label>
          {error && <span className="error small" role="alert">{error}</span>}
          <span className="clx-lead-form-actions">
            <button type="button" className="btn primary sm" onClick={() => void start()} disabled={busy}>{busy ? "Starting…" : "Start deal"}</button>
            <button type="button" className="btn sm" onClick={() => setForm(false)} disabled={busy}>Cancel</button>
          </span>
        </span>
      )}
    </span>
  );
}
