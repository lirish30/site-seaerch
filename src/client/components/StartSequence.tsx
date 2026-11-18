import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { pickableCampaigns } from "../sequenceView";
import type { Campaign } from "../types";
import Icon from "./Icon";
import InlineError from "./InlineError";

/** What follows a start: Email 1 is on Home waiting for the owner. Nothing has been sent. */
export function WaitingNotice() {
  return <span className="seq-start done" role="status"><Icon name="check" size={14} />Waiting for your OK on Home<Link className="link-btn" to="/today">Open Home</Link></span>;
}

interface Props {
  leadId: string;
  /** Turns the button off (a suppressed lead, no draft). `why` is its tooltip. */
  disabled?: boolean; why?: string;
  /** Runs before the request, so an unsaved draft is saved first. Resolve false to stop the start. */
  beforeStart?: () => Promise<boolean>;
  /** Called once a sequence has been started. */
  onStarted?: () => void;
}

/**
 * "Start sequence…": pick a campaign, then Email 1 (built from the lead's current draft) goes to Home for approval. Nothing is sent from
 * here. The server's reason is shown as it is when the lead cannot be started (suppressed, already in a sequence, no draft, no address).
 */
export default function StartSequence({ leadId, disabled, why, beforeStart, onStarted }: Props) {
  const [stage, setStage] = useState<"idle" | "picking" | "done">("idle");
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");

  async function open() {
    setError(""); setStage("picking");
    try {
      const list = pickableCampaigns(await api.get<Campaign[]>("/campaigns"));
      setCampaigns(list); setPick((p) => (list.some((c) => c.id === p) ? p : list[0]?.id ?? ""));
    } catch (e) { setCampaigns([]); setError(e instanceof ApiError ? e.message : "Couldn't load your campaigns."); }
  }
  async function start() {
    if (!pick || busy) return;
    setBusy(true); setError("");
    try {
      if (beforeStart && !(await beforeStart())) return;
      await api.post(`/leads/${leadId}/sequence/start`, { campaignId: pick });
      setStage("done"); onStarted?.();
    } catch (e) { setError(e instanceof ApiError ? e.message : (e as Error).message || "That didn't work."); }
    finally { setBusy(false); }
  }

  if (stage === "done") return <WaitingNotice />;
  if (stage === "idle") {
    return (
      <span className="seq-start">
        <button type="button" className="btn" onClick={() => void open()} disabled={disabled} title={disabled ? why : "Add this lead to a sequence of follow-up emails"}>
          <Icon name="send" size={16} />Start sequence…
        </button>
        <InlineError message={error} />
      </span>
    );
  }
  return (
    <span className="seq-start picking">
      {campaigns === null ? <span className="muted small">Loading campaigns…</span>
        : campaigns.length === 0 ? <span className="muted small">{error ? "" : <>No campaigns yet. <Link to="/campaigns">Create a campaign</Link> first.</>}</span>
        : <>
          <label className="field seq-pick"><span className="sr-only">Campaign</span>
            <select aria-label="Campaign" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select><Icon name="chevron-down" size={14} className="chev" />
          </label>
          <button type="button" className="btn primary" onClick={() => void start()} disabled={busy || !pick}>{busy ? "Starting…" : "Start"}</button>
        </>}
      <button type="button" className="btn-plain" onClick={() => { setStage("idle"); setError(""); }} disabled={busy}>Cancel</button>
      <InlineError message={error} />
    </span>
  );
}
