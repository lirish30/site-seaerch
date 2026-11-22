import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { Fragment } from "react";
import { Link } from "react-router-dom";
import { Field, Row } from "../components/SettingsPage";
import { Banner, Card, Chip, Empty, Meter, Note, PageHeader } from "../components/ds";
import Icon from "../components/Icon";
import { campaignStats, fieldErrors, parseTowns, runResultTone, runSearchesConfirm, runSearchesLines, townsLine, type CampaignSearch } from "../campaignView";
import type { Campaign, CampaignStatus } from "../types";
import CampaignEditor, { type RunView } from "./CampaignEditor";

const TONE: Record<CampaignStatus, "info" | "positive" | "neutral"> = { testing: "info", active: "positive", archived: "neutral" };
const STATUS_SUB: Record<CampaignStatus, string> = { testing: "Trying it on a few leads", active: "Running", archived: "Stopped" };
const STATUS_LABEL: Record<CampaignStatus, string> = { testing: "Testing", active: "Active", archived: "Archived" };

/** New campaign: a name, a niche, a region and one to ten towns. The five steps come with it. */
function CreateForm({ onCreated, onClose }: { onCreated: (c: Campaign) => void; onClose: () => void }) {
  const [f, setF] = useState({ name: "", niche: "", region: "", towns: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ bad: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f, v: string) => { setF((o) => ({ ...o, [k]: v })); setErrs((e) => ({ ...e, [k]: "" })); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const towns = parseTowns(f.towns);
    const next: Record<string, string> = {};
    for (const k of ["name", "niche", "region"] as const) if (!f[k].trim()) next[k] = "Required.";
    if (towns.length < 1 || towns.length > 10) next.towns = "Enter 1 to 10 towns, one per line or separated by commas.";
    setErrs(next);
    if (Object.keys(next).length) { setMsg({ bad: true, text: "Not created: fix the highlighted fields." }); return; }
    setBusy(true); setMsg(null);
    try {
      const c = await api.post<Campaign>("/campaigns", { name: f.name.trim(), niche: f.niche.trim(), region: f.region.trim(), towns });
      onCreated(c); setF({ name: "", niche: "", region: "", towns: "" }); setMsg({ bad: false, text: `Created ${c.name}.` });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) { setErrs(fieldErrors(err.fields)); setMsg({ bad: true, text: "Not created: fix the highlighted fields." }); }
      else setMsg({ bad: true, text: `Not created: ${err instanceof ApiError ? err.message : "request failed"}` });
    } finally { setBusy(false); }
  }

  return (
    <Card icon="plus" title="New campaign" note="Five follow-up steps come with it" action={<button type="button" className="ds-icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>}>
      <p>Searches one niche across a list of towns, then runs the five-step sequence on what it finds.</p>
      <form className="slx-form slx-campaign-form" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Name" htmlFor="cp-new-name" error={errs.name}><input id="cp-new-name" value={f.name} maxLength={100} autoComplete="off" placeholder="Home services, Sherwood area" onChange={(e) => set("name", e.target.value)} /></Field>
        <Row>
          <Field label="Niche" htmlFor="cp-new-niche" error={errs.niche}><input id="cp-new-niche" value={f.niche} maxLength={100} autoComplete="off" placeholder="Plumbers" onChange={(e) => set("niche", e.target.value)} /></Field>
          <Field label="Region" htmlFor="cp-new-region" error={errs.region}><input id="cp-new-region" value={f.region} maxLength={100} autoComplete="off" placeholder="Oregon" onChange={(e) => set("region", e.target.value)} /></Field>
        </Row>
        <Field label="Towns" htmlFor="cp-new-towns" error={errs.towns} help="One per line or separated by commas. 1 to 10 towns.">
          <textarea id="cp-new-towns" rows={4} value={f.towns} onChange={(e) => set("towns", e.target.value)} />
        </Field>
        <div className="slx-actions"><button type="submit" className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create campaign"}</button>
          <span className={msg?.bad ? "slx-error" : "slx-ok"} aria-live="polite" aria-atomic="true">{msg?.text}</span></div>
      </form>
    </Card>
  );
}

/** Campaigns: a table of every campaign with what its searches found, the New campaign form, and each one's editor (status, job value, steps, Run searches). */
export default function Campaigns() {
  const [list, setList] = useState<Campaign[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [searches, setSearches] = useState<CampaignSearch[]>([]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(() => api.get<Campaign[]>("/campaigns")
    .then((r) => { if (alive.current) { setList(r); setErr(""); } })
    .catch((e) => { if (alive.current) setErr(e instanceof ApiError ? e.message : "Couldn't load the campaigns."); }), []);
  useEffect(() => { void load(); }, [load]);
  // The leads each campaign found come from its searches. A failure only leaves the numbers out.
  useEffect(() => { api.get<CampaignSearch[]>("/searches").then((r) => { if (alive.current) setSearches(Array.isArray(r) ? r : []); }).catch(() => {}); }, []);
  // Run searches lives here, not in the editor: closing an editor must not drop an in-flight run (and re-enable its button) or its result.
  const [running, setRunning] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, RunView>>({});
  async function run(c: Campaign) {
    if (running !== null || !window.confirm(runSearchesConfirm(c.towns.length))) return;
    const put = (v: RunView) => { if (alive.current) setRuns((all) => ({ ...all, [c.id]: v })); };
    setRunning(c.id); put({ starting: true, tone: "ok", lines: [] });
    try {
      const r = await api.post<{ started: number; blocked: { town: string; reason: string }[] }>(`/campaigns/${c.id}/run-searches`);
      put({ starting: false, tone: runResultTone(r), lines: runSearchesLines(r) });
    } catch (e) { put({ starting: false, tone: "bad", lines: [`Couldn't run searches: ${e instanceof ApiError ? e.message : "request failed"}`] }); }
    finally { if (alive.current) setRunning(null); }
  }
  const replace = (c: Campaign) => setList((all) => all && all.map((x) => (x.id === c.id ? { ...c, steps: undefined } : x)));

  const stats = new Map((list ?? []).map((c) => [c.id, campaignStats(c, searches)]));
  const leads = [...stats.values()].reduce((n, s) => n + s.leads, 0);
  const active = (list ?? []).filter((c) => c.status === "active").length;
  const newBtn = <button type="button" className="btn primary" aria-expanded={creating} onClick={() => setCreating(!creating)}><Icon name="plus" size={16} />New campaign</button>;

  return (
    <div className="ds-page slx-campaigns">
      <PageHeader title="Campaigns"
        sub={list && list.length > 0 ? `${list.length} ${list.length === 1 ? "campaign" : "campaigns"} · ${active} running · ${leads} leads found` : "A niche, a list of towns and the follow-up sequence that runs on the leads they turn up."}
        actions={newBtn} />
      <div className="ds-body">
        {creating && <CreateForm onClose={() => setCreating(false)} onCreated={(c) => { setList((all) => [{ ...c, steps: undefined }, ...(all ?? [])]); setOpen(c.id); setCreating(false); }} />}
        {err ? <Banner tone="critical" title="Couldn’t load the campaigns" action={<button type="button" className="btn sm" onClick={() => void load()}>Try again</button>}>{err}</Banner>
          : !list ? <p className="slx-muted">Loading the campaigns…</p>
          : list.length === 0 ? (
            !creating && (
              <div className="ds-card">
                <Empty icon="target" title="No campaigns yet" action={newBtn}>
                  A campaign is one kind of business (plumbers, roofers) in up to ten towns. It searches each town for leads, scores them, and runs a
                  five-step follow-up (emails, a call, a check-in) on the ones you start. Campaigns you make show here with the leads they found.
                </Empty>
              </div>
            )
          ) : (
            <>
              <div className="ds-table-wrap">
                <table className="ds-table slx-camp-table">
                  <thead><tr><th>Campaign</th><th>Towns</th><th className="slx-th-num">Leads found</th><th>Towns searched</th><th>Status</th><th aria-label="Actions" /></tr></thead>
                  <tbody>
                    {list.map((c) => {
                      const s = stats.get(c.id)!;
                      const isOpen = open === c.id;
                      return (
                        <Fragment key={c.id}>
                          <tr className={isOpen ? "open" : ""}>
                            <td>
                              <span className="ds-who">
                                <span className="ds-tile signal slx-camp-tile"><Icon name="target" size={16} /></span>
                                <span><b>{c.name}</b><small>{c.niche} · {c.region}</small></span>
                              </span>
                            </td>
                            <td title={c.towns.join(", ")}>{townsLine(c.towns)}</td>
                            <td className="num">{s.leads > 0 ? <Link to="/leads" className="slx-num-link">{s.leads}</Link> : <span className="slx-hint">0</span>}</td>
                            <td>
                              <span className="slx-progress">
                                <Meter value={s.searchedTowns} max={c.towns.length} tone={s.searchedTowns >= c.towns.length ? "positive" : "neutral"} width={72} label={`${s.searchedTowns} of ${c.towns.length} towns searched`} />
                                <span>{s.running ? "Searching now" : `${s.searchedTowns} of ${c.towns.length}`}</span>
                              </span>
                            </td>
                            <td><Chip tone={TONE[c.status]} dot title={STATUS_SUB[c.status]}>{STATUS_LABEL[c.status]}</Chip></td>
                            <td className="slx-camp-act">
                              <button type="button" className="btn sm" aria-expanded={isOpen} aria-controls={`cp-panel-${c.id}`} onClick={() => setOpen(isOpen ? null : c.id)}>
                                {isOpen ? "Close" : "Open"}<span className="sr-only"> {c.name}</span><Icon name={isOpen ? "chevron-up" : "chevron-down"} size={14} />
                              </button>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="slx-camp-panel"><td colSpan={6} id={`cp-panel-${c.id}`}>
                              <CampaignEditor campaign={c} onChange={replace} run={runs[c.id] ?? null} anyRunning={running !== null} onRun={() => void run(c)} />
                            </td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Note>Leads found counts every lead the campaign’s town searches turned up. Run searches again from a campaign to pick up new businesses.</Note>
            </>
          )}
      </div>
    </div>
  );
}
