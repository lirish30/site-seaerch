import { Fragment, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, careApi } from "../api";
import { dayLabel } from "../careReportPageView";
import { ledgerBar, MONTH_STAGES, monthStage, stageLabel, type MonthStage, type ReportRow } from "../careReportsView";
import { latestOnly, moneyLabel } from "../clientView";
import { formatUptime } from "../careView";
import Icon from "../components/Icon";
import { Avatar, Banner, Card, Chip, Empty, Meter, Note, PageHeader, type Tone } from "../components/ds";
import { periodLabel } from "../../worker/sop/cadence";
import type { CareRow } from "../../worker/monitoring/fleet";

const sentence = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);
const SUMMARY_MAX = 600;
const RECOMMENDATION_MAX = 300;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const STAGE_TONE: Record<MonthStage, Tone> = { none: "outline", collecting: "info", ready: "warning", sent: "positive", opened: "positive", off: "critical" };
const STAGE_ORDER: Record<MonthStage, number> = { ready: 0, collecting: 1, none: 2, sent: 3, opened: 4, off: 5 };
const BAR_TONE = { ok: "positive", warn: "warning", over: "critical", none: "neutral" } as const;

/** The report's link in a box to select, and a button that copies it. A copy that is refused says so and leaves the link to copy by hand. */
function LinkBox({ link }: { link: string }) {
  const [note, setNote] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(link); setNote("Link copied."); }
    catch { setNote("Could not copy: select the link and copy it by hand."); }
  }
  const id = `link-${link.slice(-12)}`;
  return (
    <div className="crx-field">
      <span><label htmlFor={id}>Link to the report page</label></span>
      <div className="crx-link-row">
        <input id={id} readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn sm" onClick={() => void copy()}><Icon name="copy" size={14} />Copy link</button>
      </div>
      {note && <p className="crx-ok" role="status">{note}</p>}
    </div>
  );
}

/** The two boxes for a `ready` report. The server's words show again after a save; Save is off until something changed. */
function WordsForm({ r, onSaved }: { r: ReportRow; onSaved: (next: ReportRow) => void }) {
  const [summary, setSummary] = useState(r.summary);
  const [recommendation, setRecommendation] = useState(r.recommendation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setSummary(r.summary); setRecommendation(r.recommendation); }, [r.summary, r.recommendation]);
  const dirty = summary.trim() !== r.summary || recommendation.trim() !== r.recommendation;
  async function save() {
    if (busy || !dirty) return;
    setBusy(true); setError(""); setSaved(false);
    try { onSaved(await careApi.editReport(r.id, { summary, recommendation })); setSaved(true); }
    catch (e) { setError(sentence(e, "Couldn’t save the words. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <div className="crx-words">
      <label className="crx-field" htmlFor={`sum-${r.id}`}>
        <span>Summary <em>what the client reads in the mail · {summary.length} of {SUMMARY_MAX}</em></span>
        <textarea id={`sum-${r.id}`} rows={4} maxLength={SUMMARY_MAX} value={summary} onChange={(e) => { setSummary(e.target.value); setSaved(false); }} />
      </label>
      <label className="crx-field" htmlFor={`rec-${r.id}`}>
        <span>Recommendation <em>on the report page · {recommendation.length} of {RECOMMENDATION_MAX}</em></span>
        <textarea id={`rec-${r.id}`} rows={2} maxLength={RECOMMENDATION_MAX} value={recommendation} onChange={(e) => { setRecommendation(e.target.value); setSaved(false); }} />
      </label>
      <div className="crx-actions">
        <button type="button" className="btn primary sm" aria-disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save my words"}</button>
        {saved ? <span className="crx-ok" role="status">Saved. The card on Today shows these words now.</span> : !dirty && <span className="crx-ok">Change the words to save them.</span>}
      </div>
      {error && <p className="crx-err" role="alert">{error}</p>}
    </div>
  );
}

/** Revoke, with a plain question first: the link stops working, even for a client who already has it. */
function Revoke({ r, onChanged }: { r: ReportRow; onChanged: (next: ReportRow) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function revoke() {
    if (busy) return;
    setBusy(true); setError("");
    try { onChanged(await careApi.revokeReport(r.id)); setAsking(false); }
    catch (e) { setError(sentence(e, "Couldn’t take it back. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <>
      {asking ? (
        <div className="crx-ask" role="group" aria-label="Take this report back?">
          <p>Take this report back? Its link will stop working{r.status === "sent" ? ", even for the client who has it" : ""}.</p>
          <div className="crx-actions">
            <button type="button" className="btn sm crx-btn-danger" aria-disabled={busy} onClick={() => void revoke()}>Yes, take it back</button>
            <button type="button" className="btn sm" onClick={() => setAsking(false)}>Keep it</button>
          </div>
        </div>
      ) : <div className="crx-actions"><button type="button" className="btn sm" onClick={() => setAsking(true)}><Icon name="ban" size={14} />Revoke</button><span className="crx-ok">Stops the link working.</span></div>}
      {error && <p className="crx-err" role="alert">{error}</p>}
    </>
  );
}

/** What opens under a report's row: the words (editable while ready), the link to copy and Revoke. */
function Detail({ r, onChanged }: { r: ReportRow; onChanged: (next: ReportRow) => void }) {
  if (r.status === "revoked" || r.status === "cancelled") {
    return <div className="crx-detail-box one"><p className="crx-quote-sub">{r.status === "revoked" ? "You took this report back. Its link no longer opens." : "This report was cancelled and never went out."}</p></div>;
  }
  return (
    <div className="crx-detail-box">
      {r.status === "ready" ? <WordsForm r={r} onSaved={onChanged} /> : (
        <div className="crx-words">
          <p className="crx-quote">{r.summary}</p>
          {r.recommendation && <p className="crx-quote-sub"><b>Recommendation:</b> {r.recommendation}</p>}
        </div>
      )}
      <div className="crx-detail-side">
        {r.link && <LinkBox link={r.link} />}
        {r.status === "ready" && <Note><span>Approve it on <Link to="/today">Today</Link> to send it. Nothing is mailed before that.</span></Note>}
        {(r.status === "ready" || r.status === "sent") && <Revoke r={r} onChanged={onChanged} />}
      </div>
    </div>
  );
}

/** "Build now" for a Care client with no report this month. A refusal is shown as the server's sentence. */
function BuildNow({ c, onBuilt }: { c: CareRow; onBuilt: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function build() {
    if (busy) return;
    setBusy(true); setError("");
    try { await careApi.buildReport(c.businessId); await onBuilt(); }
    catch (e) { setError(sentence(e, "Couldn’t start the report. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <span className="crx-row-actions">
      {error && <span className="crx-err" role="alert">{error}</span>}
      <button type="button" className="btn sm" aria-disabled={busy} onClick={() => void build()}><Icon name="sparkles" size={14} />{busy ? "Starting…" : "Build now"}</button>
    </span>
  );
}

/** The edit-hours meter of a report's month, with the figure and a note in words. */
function Hours({ r }: { r: ReportRow }) {
  const bar = r.status === "revoked" || r.status === "cancelled" ? null : ledgerBar(r.ledger);
  if (!bar) return <span className="crx-dim">–</span>;
  return (
    <span className="crx-hours">
      <Meter value={bar.width} max={100} tone={BAR_TONE[bar.tone]} label={`Edit hours: ${bar.label}`} />
      <small className={bar.tone}>{bar.note || bar.label}</small>
    </span>
  );
}

type Line = { key: string; stage: MonthStage; clientId: string; name: string; sub: string; report: ReportRow | null; care: CareRow | null };

/** The month's Care reports: each Care client's report and where it stands, the words to edit while it is ready, the link to copy, Revoke, and Build now for clients with none yet. */
export default function CareReports() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<string | null>(null);
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [fleet, setFleet] = useState<CareRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [guard] = useState(latestOnly);
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const [list, clients] = await Promise.all([careApi.reports(), careApi.fleet().catch(() => null)]);
      if (!guard.isLatest(ticket)) return;
      setPeriod(list.period); setReports(list.reports); setFleet(clients); setFailed(false);
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [guard]);
  useEffect(() => { void load(); return () => guard.cancel(); }, [load, guard]);

  const replace = (next: ReportRow) => setReports((rs) => rs && rs.map((r) => (r.id === next.id ? next : r)));
  const list = reports ?? [];
  const byClient = new Map((fleet ?? []).map((c) => [c.businessId, c]));
  const withReport = new Set(list.map((r) => r.clientId));
  const missing = (fleet ?? []).filter((c) => !withReport.has(c.businessId) && c.careLabel !== null);
  const lines: Line[] = [
    ...list.map((r) => ({ key: r.id, stage: monthStage(r), clientId: r.clientId, name: r.client || "Client", sub: byClient.get(r.clientId)?.careLabel ?? "Care", report: r, care: byClient.get(r.clientId) ?? null })),
    ...missing.map((c) => ({
      key: `m-${c.businessId}`, stage: "none" as const, clientId: c.businessId, name: c.name, report: null, care: c,
      sub: `${c.careLabel ?? "Care"} · ${c.uptime30 === null ? "no uptime checks yet" : `uptime ${formatUptime(c.uptime30)}`}${c.openIncidents.length ? ` · ${plural(c.openIncidents.length, "open incident")}` : ""}`,
    })),
  ].sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || a.name.localeCompare(b.name));
  const count = (s: MonthStage) => lines.filter((l) => l.stage === s).length;
  const live = lines.filter((l) => l.stage !== "off");
  const due = live.length;
  const sentAll = count("sent") + count("opened");
  const ready = count("ready");
  const careMrr = (fleet ?? []).filter((c) => c.careLabel !== null).reduce((n, c) => n + c.mrrCents, 0);
  const loaded = reports !== null;
  const month = period ? periodLabel("monthly", period) : "This month";
  const isOpen = (l: Line) => open[l.key] ?? l.stage === "ready";
  const toggle = (l: Line) => setOpen((o) => ({ ...o, [l.key]: !isOpen(l) }));

  return (
    <div className="ds-page crx">
      <PageHeader
        title="Care reports"
        sub={loaded && lines.length > 0 ? `${month} · ${sentAll} of ${due} sent · the monthly proof each Care client gets that their site was looked after.` : "The monthly proof each Care client gets that their site was looked after."}
        actions={<>
          <button type="button" className="ds-icon-btn crx-refresh" aria-label="Refresh" title="Refresh" onClick={() => void load()}><Icon name="refresh" size={16} /></button>
          <Link className="btn" to="/care"><Icon name="shield" size={16} />Care board</Link>
          <Link className="btn" to="/care/updates"><Icon name="zap" size={16} />Updates</Link>
        </>}
      />
      <div className="ds-body">
        {failed && <Banner tone="critical" title="Couldn't load the reports" action={<button type="button" className="btn sm" onClick={() => void load()}>Try again</button>}>{reports ? "What you see may be out of date." : "Check your connection and try again."}</Banner>}
        {!loaded && !failed && <p className="crx-loading">Loading this month's reports…</p>}
        {loaded && lines.length === 0 && (
          <div className="ds-card"><Empty icon="file-text" title="No Care clients to report on yet" action={<Link className="btn primary" to="/clients"><Icon name="users" size={16} />Go to clients</Link>}>
            Each month every Care client gets a short report: how their site did, what was done and what's next.
            <ol className="crx-steps">
              <li><span><b>Put a client on Care.</b> It starts from a signed proposal or the client's Billing. Their sites are then watched every day.</span></li>
              <li><span><b>The report builds itself.</b> Early each month the uptime, updates, edit hours and traffic are collected and Claude writes the summary.</span></li>
              <li><span><b>You read, tweak, approve.</b> Edit the words here, then approve on Today. Only then is it mailed with a private link.</span></li>
            </ol>
          </Empty></div>
        )}
        {loaded && lines.length > 0 && (
          <>
            {ready > 0 && (
              <Banner tone="warning" title={`${plural(ready, "report")} ${ready === 1 ? "waits" : "wait"} for your OK`}
                action={<Link className="btn sm" to="/today">Approve on Today</Link>}>
                Read and tweak the words below, then approve on Today. Nothing is mailed before that.
              </Banner>
            )}

            <Card icon="calendar" title={`${month} at a glance`} note={`Care revenue ${moneyLabel(careMrr)} a month`} flush>
              <div className="crx-progress">
                <div className="crx-progress-top">
                  <p className="ds-big">{sentAll}<small>of {due} sent</small></p>
                  <p>{sentAll === due && due > 0 ? "Every report for the month is out." : `${plural(due - sentAll, "report")} still to go.`} {count("opened")} opened by the client{sentAll > count("opened") ? "; a nudge on your next call helps the rest" : ""}.</p>
                </div>
                <div className="crx-stack" role="img" aria-label={MONTH_STAGES.map((s) => `${s.label} ${count(s.stage)}`).join(", ")}>
                  {MONTH_STAGES.map((s) => count(s.stage) > 0 && <i key={s.stage} className={`t-${s.stage}`} style={{ flex: count(s.stage) }} />)}
                </div>
                <ul className="crx-stages">
                  {MONTH_STAGES.map((s) => (
                    <li key={s.stage} className={s.stage === "ready" && count("ready") > 0 ? "on" : ""}>
                      <b><i className={`crx-key crx-stack-key t-${s.stage}`} aria-hidden="true" />{count(s.stage)}</b>
                      <span>{s.label}</span>
                      <small>{s.hint}</small>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>

            <div className="ds-table-wrap">
              <table className="ds-table crx-reports">
                <thead><tr><th>Client</th><th>Status</th><th>Edit hours used</th><th>Sent</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {lines.map((l) => {
                    const r = l.report;
                    const expandable = r !== null && r.status !== "collecting";
                    const shown = expandable && isOpen(l);
                    return (
                      <Fragment key={l.key}>
                        <tr className={shown ? "crx-open" : ""} data-href onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button,input,textarea")) { if (expandable) toggle(l); else navigate(`/clients/${encodeURIComponent(l.clientId)}`); } }}>
                          <td>
                            <span className="ds-who"><Avatar name={l.name} />
                              <span><b><Link className="ds-row-link" to={`/clients/${encodeURIComponent(l.clientId)}`}>{l.name}</Link></b><small>{l.sub}</small></span>
                            </span>
                          </td>
                          <td><span className="crx-inline"><Chip tone={STAGE_TONE[l.stage]} dot>{stageLabel(l.stage, r?.status)}</Chip>{r?.test && <Chip tone="outline">Test</Chip>}</span></td>
                          <td>{r ? <Hours r={r} /> : <span className="crx-dim">–</span>}</td>
                          <td>
                            {r?.sentOn ? (
                              <span className="crx-next"><b>{dayLabel(r.sentOn) ?? r.sentOn}</b><small className="crx-dim">{r.status === "sent" ? (r.views === 0 ? "Not opened yet" : `Opened ${r.views} ${r.views === 1 ? "time" : "times"}`) : ""}</small></span>
                            ) : <span className="crx-dim">{l.stage === "collecting" ? "Being written" : l.stage === "ready" ? "Waits for you" : l.stage === "none" ? "Starts on its own early in the month" : "–"}</span>}
                          </td>
                          <td>
                            {l.stage === "none" && l.care ? <BuildNow c={l.care} onBuilt={load} /> : expandable ? (
                              <span className="crx-row-actions">
                                <button type="button" className="btn sm" aria-expanded={shown} onClick={() => toggle(l)}>
                                  {shown ? "Hide" : r!.status === "ready" ? "Edit words" : "Details"}<Icon name={shown ? "chevron-up" : "chevron-down"} size={14} />
                                </button>
                              </span>
                            ) : null}
                          </td>
                        </tr>
                        {shown && r && <tr className="crx-detail"><td colSpan={5}><Detail r={r} onChanged={replace} /></td></tr>}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Note>A Care client with no report starts by themselves in the first days of the month; Build now makes one straight away. Each client gets a mail with your summary and a private link to the full page: uptime and health, updates and fixes, edit hours used, traffic once Google is linked, and one thing we suggest next.</Note>
          </>
        )}
      </div>
    </div>
  );
}
