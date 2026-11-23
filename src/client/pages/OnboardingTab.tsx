import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Banner, Card, Chip, Empty, Facts, Meter, Note } from "../components/ds";
import Icon from "../components/Icon";
import { PLAN_FOR_DELAYS_PLAIN, silenceLine, stageLabel, stageTone, welcomeLine } from "../onboardingView";
import { day, when } from "./onboarding/shared";
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

  if (!data) return <p className="slx-muted">Loading the onboarding…</p>;
  const { onboarding: o } = data;
  const messages = <>
    {error && <Banner tone="critical" title="That didn’t work">{error}</Banner>}
    {notice && <Banner tone="positive" title={notice} />}
  </>;

  if (!o) {
    return (
      <>
        {messages}
        <div className="ds-card">
          <Empty icon="inbox" title={data.canStart ? "The deposit is paid, but no onboarding started" : "No onboarding yet"}
            action={(data.canStart || data.canStartTest) && (
              <div className="slx-actions">
                {data.canStart && <button type="button" className="btn primary" disabled={busy} onClick={() => act(() => api.post(`/deals/${dealId}/onboarding/start`))}>Start the onboarding</button>}
                {data.canStartTest && <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.post(`/deals/${dealId}/onboarding/test`))}>Start a test onboarding</button>}
              </div>
            )}>
            {data.canStart ? "It normally starts by itself when the deposit is paid; this is the retry."
              : "It starts by itself when the client’s deposit is paid: a welcome email, a questionnaire and a checklist of what you need from them."}
          </Empty>
          {data.canStartTest && <p className="slx-hint slx-pad">A test onboarding sends its welcome to your own address only, never to the client. It can only be made on a deal that has a signed test proposal and no real one, and it stays on its deal: a deal has one onboarding, so a test one cannot be replaced by a real one.</p>}
        </div>
        <Note>{PLAN_FOR_DELAYS_PLAIN}</Note>
      </>
    );
  }

  const closed = !!o.closedAt;
  const welcome = welcomeLine(o, data.welcomeApproval);
  const quiet = !!o.welcomeSentAt && !closed;
  const waiting = data.items.filter((i) => i.status === "waiting").length;
  const toCheck = data.items.filter((i) => i.status === "received").length;
  const settled = data.items.filter((i) => i.status === "accepted" || i.status === "not_applicable").length;
  const silence = silenceLine(data.silentDays);
  return (
    <>
      {messages}
      {quiet && data.silentDays >= SILENCE_DAYS && <Banner tone="warning" icon="clock" title={`No reply for ${data.silentDays} days`}>Nudge the client, or move them to the back of the queue as the contract says.</Banner>}
      {toCheck > 0 && <Banner tone="signal" icon="inbox" title={`${toCheck} ${toCheck === 1 ? "thing has" : "things have"} come in to check`}>Accept each one in the checklist, or ask again.</Banner>}
      <div className="ds-cols c2">
        <div className="ds-col">
          <Card icon="list" title="Checklist" note={data.items.length ? `${waiting} waiting on the client` : undefined}>
            <ItemsPanel items={data.items} closed={closed} act={act} />
            <AddItem id={o.id} closed={closed} act={act} />
          </Card>
          <Card icon="file-text" title="Questionnaire" note={o.questionnaireSubmittedAt ? "Handed in" : "Not handed in"}>
            <Answers o={o} questions={data.questions} answers={data.answers} />
          </Card>
        </div>
        <div className="ds-col">
          <Card icon="info" title="Where it stands" action={<button type="button" className="btn sm" disabled={busy} onClick={() => act(async () => {}, "Refreshed.")}><Icon name="refresh" size={14} />Refresh</button>}>
            <div className="slx-actions">
              {data.stage && <Chip tone={TONE[stageTone(data.stage)]} dot>{stageLabel(data.stage)}</Chip>}
              <Chip tone="outline">{o.kind === "build" ? "Site build" : "Light onboarding"}{o.test ? ", test" : ""}</Chip>
            </div>
            {data.items.length > 0 && (
              <div className="slx-onb-meter">
                <span><b>{settled} of {data.items.length}</b> checklist items done</span>
                <Meter value={settled} max={data.items.length} tone={settled === data.items.length ? "positive" : "signal"} label={`Checklist ${settled} of ${data.items.length} done`} />
              </div>
            )}
            <Facts rows={[
              { label: "Questions", value: o.questionnaireSubmittedAt ? `Handed in ${day(o.questionnaireSubmittedAt)}` : o.questionnaireDueAt ? `Due ${day(o.questionnaireDueAt)}` : "Not handed in" },
              { label: "Kickoff", value: o.kickoffAt ? when(o.kickoffAt) : "Not set yet" },
              ...(quiet ? [{ label: "Last heard", value: <span className={silence.late ? "slx-error" : ""}>{silence.text}</span> }] : []),
            ]} />
            <p className="slx-hint">{PLAN_FOR_DELAYS_PLAIN}</p>
          </Card>
          <Card icon="mail" title="Welcome">
            <p>{welcome.text}{welcome.kind === "pending" && <> <Link to="/">Open Home to approve it</Link></>}</p>
            {welcome.canRequest && <div className="slx-actions"><button type="button" className="btn sm" disabled={busy} onClick={() => act(() => api.post(`/onboardings/${o.id}/welcome`), "The welcome is waiting for your approval.")}>Ask for the welcome</button></div>}
            <OwnerFields o={o} act={act} />
          </Card>
          <Card icon="link" title="The client’s link">
            <LinkPanel o={o} link={data.link} act={act} />
          </Card>
        </div>
      </div>
    </>
  );
}
