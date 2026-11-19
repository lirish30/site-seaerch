import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { PLAN_FOR_DELAYS, silenceNote, stageLabel, stageTone, welcomeLine } from "../onboardingView";
import { SILENCE_DAYS } from "../../worker/onboarding/schedule";
import type { OnboardingState } from "../../worker/onboarding/owner";
import AddItem from "./onboarding/AddItem";
import Answers from "./onboarding/Answers";
import ItemsPanel from "./onboarding/ItemsPanel";
import LinkPanel from "./onboarding/LinkPanel";
import OwnerFields from "./onboarding/OwnerFields";
import { errorText, type Act } from "./onboarding/shared";

const TONE = { neutral: "outline", good: "positive", warn: "warning" } as const;

/**
 * A deal's onboarding: where it stands, the welcome mail, the video link and kickoff time, what the client wrote and sent, and the link to give them. Nothing
 * the client typed or named is ever more than text here. The client's link is shown to you and nobody else.
 */
export default function OnboardingTab({ dealId, data, onReload }: { dealId: string; data: OnboardingState | null; onReload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const act: Act = async (fn, done) => {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); await onReload(); if (done) setNotice(done); }
    catch (e) { setError(errorText(e, "Something went wrong")); await onReload().catch(() => {}); }
    finally { setBusy(false); }
  };

  if (!data) return <p className="muted">Loading…</p>;
  const { onboarding: o } = data;

  if (!o) {
    return (
      <section className="deal-form" aria-label="Onboarding">
        <p className="muted small">{PLAN_FOR_DELAYS}</p>
        {data.canStart
          ? <p>The deposit is paid and no onboarding has started. It normally starts by itself; this is the retry.</p>
          : <p className="muted">No onboarding yet. It starts by itself when the client's deposit is paid.</p>}
        {error && <p className="warn small" role="alert">{error}</p>}
        <div className="cp-actions">
          {data.canStart && <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.post(`/deals/${dealId}/onboarding/start`))}>Start the onboarding</button>}
          {data.canStartTest && <button type="button" className="btn-ghost-sm" disabled={busy} onClick={() => act(() => api.post(`/deals/${dealId}/onboarding/test`))}>Start a test onboarding</button>}
        </div>
        {data.canStartTest && <p className="muted small">A test onboarding sends its welcome to your own address only, never to the client. A deal has one onboarding, so a test one stays.</p>}
      </section>
    );
  }

  const closed = !!o.closedAt;
  const welcome = welcomeLine(o, data.welcomeApproval);
  const quiet = !!o.welcomeSentAt && !closed;
  return (
    <section className="deal-form" aria-label="Onboarding">
      <div className="cp-actions">
        {data.stage && <span className={`badge2 ${TONE[stageTone(data.stage)]}`}><i className="dot" />{stageLabel(data.stage)}</span>}
        <span className="muted small">{o.kind === "build" ? "Site build" : "Light onboarding"}{o.test ? ", test" : ""}</span>
        <button type="button" className="btn-ghost-sm" disabled={busy} onClick={() => act(async () => {}, "Refreshed.")}>Refresh</button>
      </div>
      {quiet && <p className={data.silentDays >= SILENCE_DAYS ? "warn small" : "muted small"} role="status">{silenceNote(data.silentDays)}</p>}
      <p className="muted small">{PLAN_FOR_DELAYS}</p>
      {error && <p className="warn small" role="alert">{error}</p>}
      {notice && <p className="small" role="status">{notice}</p>}

      <section aria-label="Welcome">
        <h3>Welcome</h3>
        <p>{welcome.text}{welcome.kind === "pending" && <> <Link to="/">Open Home to approve it</Link></>}</p>
        {welcome.canRequest && <div className="cp-actions"><button type="button" className="btn-ghost-sm" disabled={busy} onClick={() => act(() => api.post(`/onboardings/${o.id}/welcome`), "The welcome is waiting for your approval.")}>Ask for the welcome</button></div>}
        <OwnerFields o={o} act={act} />
      </section>

      <Answers o={o} questions={data.questions} answers={data.answers} />

      <section aria-label="Checklist">
        <h3>Checklist</h3>
        <ItemsPanel items={data.items} closed={closed} act={act} />
        <AddItem id={o.id} closed={closed} act={act} />
      </section>

      <LinkPanel o={o} link={data.link} act={act} />
    </section>
  );
}
