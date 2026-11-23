import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, autoApproveApi } from "../../api";
import { Avatar, Chip, Meter } from "../../components/ds";
import Icon from "../../components/Icon";
import SettingsPage, { Callout } from "../../components/SettingsPage";
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
  const on = s ? s.rules.filter((r) => r.enabled).length : 0;
  const failed = s ? s.recent.filter((o) => o.outcome === "failed").length : 0;

  return (
    <SettingsPage title="Auto-approve" width={760} sub="Let two fixed reminders go out without your click. Everything else still waits for you."
      badge={s ? (on ? <Chip tone="signal" dot>{on} of {s.rules.length} on</Chip> : <Chip tone="outline" dot>Off</Chip>) : undefined}>
      <div className="bx sox">
        {loadFailed && <Callout tone="critical" icon="alert">Could not load this page. Reload to try again.</Callout>}
        {!s && !loadFailed && <p className="st-loading">Loading…</p>}
        {problem && <Callout tone="critical" icon="alert">{problem}</Callout>}
        {s && (
          <>
            {s.rules.map((r) => (
              <section key={r.kind} className="st-card">
                <header>
                  <div className="sox-row" style={{ padding: 0 }}>
                    <span className={`sox-tile ${r.enabled ? "signal" : ""}`}><Icon name={r.kind.startsWith("invoice") ? "card" : "send"} size={16} /></span>
                    <div className="sox-main"><div className="sox-title"><h2>{r.label}</h2>{r.enabled && <Chip tone="signal" dot>Going without a click</Chip>}</div><small>{switchLine(r)}</small></div>
                  </div>
                  <Toggle checked={r.enabled} label={`Auto-approve ${r.label.toLowerCase()}`} disabled={busy !== null} onChange={(v) => void flip(r.kind, v)}><span>{busy === r.kind ? "Saving…" : r.enabled ? "On" : "Off"}</span></Toggle>
                </header>
                <div className="sox-rule">
                  <div><span className="sox-tile positive"><Icon name="check" size={16} /></span><div><p className="sox-overline">Covers</p><p>{r.covers}</p></div></div>
                  <div><span className="sox-tile"><Icon name="ban" size={16} /></span><div><p className="sox-overline">Never covers</p><p>{r.never}</p></div></div>
                </div>
              </section>
            ))}

            {(on > 0 || s.today > 0) && <section className="st-card">
              <header><div><h2>Today</h2><p>Counted by the day in your booking time zone. A send that failed counts too.</p></div></header>
              <div className="sox-today">
                <span className="sox-mono">{s.today}<span className="sox-sub"> / {s.cap}</span></span>
                <Meter value={s.today} max={s.cap} tone={s.today >= s.cap ? "warning" : "signal"} label={todayLine(s.today, s.cap)} />
                <span className="sox-sub">{s.today >= s.cap ? "Cap reached: the rest wait for you" : todayLine(s.today, s.cap)}</span>
              </div>
            </section>}

            <section className="st-card">
              <header>
                <div><h2>The last 50</h2><p>What went without a click, newest first. A reminder that could not be sent stays in Approvals with its error.</p></div>
                {failed > 0 && <Chip tone="critical" dot>{failed} failed</Chip>}
              </header>
              {s.recent.length === 0 ? (
                <div className="sox-row">
                  <span className="sox-tile"><Icon name="inbox" size={16} /></span>
                  <div className="sox-main"><b>Nothing has gone on its own yet</b><small>{on ? "When a covered reminder is drafted, it is sent and listed here." : "Switch a reminder on above. Each one it sends is listed here with its client and time."}</small></div>
                </div>
              ) : (
                <ul className="sox-list">
                  {s.recent.map((o) => {
                    const chip = outcomeChip(o);
                    const who = outcomeWho(o);
                    return (
                      <li key={o.approvalId} className="sox-row top">
                        <Avatar name={who} />
                        <div className="sox-main">
                          <div className="sox-title">{o.businessId ? <Link to={`/clients/${encodeURIComponent(o.businessId)}`}>{who}</Link> : <b>{who}</b>}<span className="sox-sub">{o.label}</span></div>
                          <small>{whenLine(o.decidedAt)}</small>
                          {o.error && <small className="bad">{o.error}</small>}
                        </div>
                        <Chip tone={chip.tone} dot>{chip.text}</Chip>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <p className="sox-foot"><Icon name="shield" size={14} />Both switches start off. A switch only covers reminders drafted after you turn it on, and at most {s.cap} go on their own in a day; the rest wait for you as usual.</p>
          </>
        )}
      </div>
    </SettingsPage>
  );
}
