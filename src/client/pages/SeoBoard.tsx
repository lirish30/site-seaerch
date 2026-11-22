import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { seoApi, type SeoBoardRow } from "../api";
import { statusTone } from "../careReportsView";
import { latestOnly } from "../clientView";
import Icon from "../components/Icon";
import { Avatar, Banner, Chip, Empty, Note, PageHeader, Stat, Stats, type Tone } from "../components/ds";
import { boardReportLine, reportChip } from "../seoView";
import { periodLabel } from "../../worker/sop/cadence";
import { sentence } from "../components/client/seo/seoBits";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const clientPath = (id: string) => `/clients/${encodeURIComponent(id)}`;

/** The month's report as a chip and what to press: Build report now when there is none, Approve on Today when it is ready. A refusal is the server's own sentence. */
function ReportCell({ r, period, onBuilt }: { r: SeoBoardRow; period: string; onBuilt: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function build() {
    if (busy) return;
    setBusy(true); setError("");
    try { await seoApi.buildReport(r.clientId); await onBuilt(); }
    catch (e) { setError(sentence(e, "Couldn’t start the report. Try again.")); }
    finally { setBusy(false); }
  }
  const tone = r.report ? statusTone(r.report.status) : "";
  return (
    <>
      <td>
        <span className="crx-next">
          {r.report ? <Chip tone={(tone || "neutral") as Tone} dot>{reportChip(r.report.status)}</Chip> : <Chip tone="outline" dot>No report yet</Chip>}
          <small className="crx-dim">{boardReportLine(r.report, period)}</small>
        </span>
      </td>
      <td>
        <span className="crx-row-actions">
          {error && <span className="crx-err" role="alert">{error}</span>}
          {r.report === null && <button type="button" className="btn sm" aria-disabled={busy} onClick={() => void build()}><Icon name="sparkles" size={14} />{busy ? "Starting…" : "Build report now"}</button>}
          {r.report?.status === "ready" && <Link className="btn sm" to="/today">Approve on Today</Link>}
          <Link className="btn sm" to={clientPath(r.clientId)}>Open client<Icon name="chevron-right" size={14} /></Link>
        </span>
      </td>
    </>
  );
}

/** Local SEO across clients: one row per client whose watch is on, with the next step, the drafts waiting, low-rated reviews and the month's report. Nothing here posts or publishes. */
export default function SeoBoard() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<SeoBoardRow[] | null>(null);
  const [period, setPeriod] = useState("");
  const [failed, setFailed] = useState(false);
  const [guard] = useState(latestOnly);
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const r = await seoApi.board();
      if (!guard.isLatest(ticket)) return;
      setRows(r.rows); setPeriod(r.period); setFailed(false);
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [guard]);
  useEffect(() => { void load(); return () => guard.cancel(); }, [load, guard]);

  const all = rows ?? [];
  const drafts = all.reduce((n, r) => n + r.draftsWaiting, 0);
  const flagged = all.reduce((n, r) => n + r.flaggedReviews, 0);
  const ready = all.filter((r) => r.report?.status === "ready").length;
  const sent = all.filter((r) => r.report?.status === "sent").length;
  const notStarted = all.filter((r) => r.report === null).length;
  const month = period ? periodLabel("monthly", period) : "";

  return (
    <div className="ds-page crx">
      <PageHeader
        title="Local SEO"
        sub={`${month ? `${month} · ` : ""}Every client whose Local SEO watch is on, with what to do next. A report goes out only after you approve it on Today.`}
        actions={<>
          <button type="button" className="ds-icon-btn crx-refresh" aria-label="Refresh" title="Refresh" onClick={() => void load()}><Icon name="refresh" size={16} /></button>
          <Link className="btn" to="/today"><Icon name="home" size={16} />Today</Link>
        </>}
      />
      <div className="ds-body">
        {failed && <Banner tone="critical" title="Couldn't load the board" action={<button type="button" className="btn sm" onClick={() => void load()}>Try again</button>}>{rows ? "What you see may be out of date." : "Check your connection and try again."}</Banner>}
        {rows === null && !failed && <p className="crx-loading">Loading the Local SEO board…</p>}
        {rows !== null && rows.length === 0 && (
          <div className="ds-card"><Empty icon="pin" title="No client has the Local SEO watch on yet" action={<Link className="btn primary" to="/clients"><Icon name="users" size={16} />Choose a client</Link>}>
            Local SEO tracks where a client shows up on Google Maps for the searches that bring them work, and proves it every month. You set it up from the client's own page:
            <ol className="crx-steps">
              <li><span><b>Open the client.</b> The Local SEO panel is on their page.</span></li>
              <li><span><b>Pick their Google listing,</b> then add the search terms people use to find them.</span></li>
              <li><span><b>Take the baseline:</b> a 3 × 3 map rank grid, the name, address and phone check and 12 directories.</span></li>
              <li><span><b>It watches itself.</b> Weekly listing and review checks; a monthly report waits on Today for your OK. The client shows here from then on.</span></li>
            </ol>
          </Empty></div>
        )}
        {rows !== null && rows.length > 0 && (
          <>
            <Stats label="Local SEO at a glance">
              <Stat icon="pin" label="Watched clients" value={all.length} sub="Weekly listing and review checks" />
              <Stat icon="pen" label="Drafts waiting" value={drafts} sub={drafts ? "Look them over on the client's page" : "Nothing to read"} tone={drafts ? "warning" : "positive"} />
              <Stat icon="star" label="Reviews to answer" value={flagged} sub={flagged ? "Low-rated, waiting for a reply" : "No low ratings"} tone={flagged ? "critical" : "positive"} />
              <Stat icon="file-text" label={`${month || "Monthly"} reports`} value={`${sent} of ${all.length}`} sub={ready ? `${ready} ready for your OK` : notStarted ? `${notStarted} not started` : "sent"} tone={ready ? "warning" : undefined} />
            </Stats>

            {ready > 0 ? (
              <Banner tone="warning" title={`${plural(ready, "Local SEO report")} ${ready === 1 ? "waits" : "wait"} for your OK`} action={<Link className="btn sm" to="/today">Approve on Today</Link>}>
                Nothing is mailed until you approve it. Tweak the words on the client's page first if you want.
              </Banner>
            ) : flagged > 0 ? (
              <Banner tone="warning" title={`${plural(flagged, "low-rated review")} to answer`}>Open the client to read each review and the reply Claude drafted.</Banner>
            ) : null}

            <div className="ds-table-wrap">
              <table className="ds-table crx-seo">
                <thead><tr><th>Client</th><th>Next step</th><th className="num">Drafts</th><th className="num">Reviews</th><th>Report</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {all.map((r) => (
                    <tr key={r.clientId} data-href onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) navigate(clientPath(r.clientId)); }}>
                      <td><span className="ds-who"><Avatar name={r.client || "Client"} /><span><b><Link className="ds-row-link" to={clientPath(r.clientId)}>{r.client || "Client"}</Link></b><small>Local SEO</small></span></span></td>
                      <td><span className="crx-next"><b>{r.next}</b></span></td>
                      <td className="num">{r.draftsWaiting === 0 ? <span className="crx-dim crx-zero">0</span> : <Chip tone="warning">{r.draftsWaiting} waiting</Chip>}</td>
                      <td className="num">{r.flaggedReviews === 0 ? <span className="crx-dim crx-zero">0</span> : <Chip tone="critical">{r.flaggedReviews} low-rated</Chip>}</td>
                      <ReportCell r={r} period={period} onBuilt={load} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Note>Nothing here posts or publishes: drafts and review replies are read and copied on each client's page.</Note>
          </>
        )}
      </div>
    </div>
  );
}
