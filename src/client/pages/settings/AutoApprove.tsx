import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, autoApproveApi } from "../../api";
import SettingsPage, { Callout, Card } from "../../components/SettingsPage";
import { Toggle } from "../../components/settingsBits";
import { outcomeChip, outcomeWho, switchLine, todayLine, whenLine, type AutoApproveState } from "../../autoApproveView";

/**
 * Settings > Auto-approve: a switch for each of two fixed reminders (invoice reminders before the last, onboarding reminders 1 to 3), in plain words what each covers and never covers,
 * today's count against the daily cap, and the last 50 outcomes. A switch saves at once; the worker decides what may actually go, so nothing here widens it.
 */
export default function AutoApprove() {
  const [s, setS] = useState<AutoApproveState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let live = true;
    autoApproveApi.get().then((v) => live && setS(v)).catch(() => live && setLoadFailed(true));
    return () => { live = false; };
  }, []);

  async function flip(kind: string, enabled: boolean) {
    setBusy(kind); setProblem(null);
    try { setS(await autoApproveApi.set(kind, enabled)); }
    catch (e) { setProblem(e instanceof ApiError && e.status !== 401 ? e.message : "Could not save that. Nothing changed; try again."); }
    finally { setBusy(null); }
  }

  return (
    <SettingsPage title="Auto-approve" width={760} sub="Let two fixed reminders go out without your click. Everything else still waits for you.">
      <div className="aa">
        <Callout>Both switches start off. A switch only covers reminders drafted after you turn it on, and at most {s?.cap ?? 20} go on their own in a day; the rest wait for you as usual.</Callout>
        {loadFailed && <p className="aa-problem" role="alert">Could not load this page. Reload to try again.</p>}
        {!s && !loadFailed && <p className="st-loading">Loading…</p>}
        {problem && <p className="aa-problem" role="alert">{problem}</p>}
        {s && (
          <>
            {s.rules.map((r) => (
              <Card key={r.kind} title={r.label} sub={switchLine(r)} action={<Toggle checked={r.enabled} label={`Auto-approve ${r.label.toLowerCase()}`} disabled={busy !== null} onChange={(on) => void flip(r.kind, on)} />}>
                <dl className="aa-words">
                  <div><dt>Covers</dt><dd>{r.covers}</dd></div>
                  <div><dt>Never covers</dt><dd>{r.never}</dd></div>
                </dl>
              </Card>
            ))}
            <Card title="Today" sub="Counted by the day in your booking time zone. A send that failed counts too.">
              <p className="aa-today"><b>{todayLine(s.today, s.cap)}</b></p>
            </Card>
            <Card title="The last 50" sub="What went without a click, newest first. A reminder that could not be sent stays in Approvals with its error.">
              {s.recent.length === 0 ? <p className="aa-empty">Nothing yet.</p> : (
                <ul className="aa-list">
                  {s.recent.map((o) => {
                    const chip = outcomeChip(o);
                    return (
                      <li key={o.approvalId}>
                        <div className="aa-line">
                          {o.businessId ? <Link to={`/clients/${encodeURIComponent(o.businessId)}`}>{outcomeWho(o)}</Link> : <span>{outcomeWho(o)}</span>}
                          <span className="aa-kind">{o.label}</span>
                          <span className={`badge2 ${chip.tone}`}><i className="dot" aria-hidden="true" />{chip.text}</span>
                        </div>
                        <div className="aa-when">{whenLine(o.decidedAt)}</div>
                        {o.error && <p className="aa-err">{o.error}</p>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
    </SettingsPage>
  );
}
