import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { STAGE_LABEL, type DealStage } from "../pipelineView";
import { Pill } from "./settingsBits";

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
  if (deal) return <Link to="/pipeline" title="Open the pipeline board" style={{ textDecoration: "none" }}><Pill tone="info">Deal: {STAGE_LABEL[deal.stage]}</Pill></Link>;
  if (!form) return <button type="button" className="chip-link" onClick={() => setForm(true)}>Start a deal</button>;
  return (
    <span className="url-edit">
      <label><input type="checkbox" className="cb" checked={skipCall} onChange={(e) => setSkipCall(e.target.checked)} /> Skip the call, send an agreement</label>
      <button type="button" className="btn primary sm" onClick={() => void start()} disabled={busy}>{busy ? "Starting…" : "Start deal"}</button>
      <button type="button" className="btn sm" onClick={() => setForm(false)} disabled={busy}>Cancel</button>
      {error && <span className="error" role="alert">{error}</span>}
    </span>
  );
}
