import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import SettingsPage, { Callout, Card, Field, Row } from "../components/SettingsPage";
import { Pill } from "../components/settingsBits";
import { fieldErrors, parseTowns, runResultTone, runSearchesConfirm, runSearchesLines } from "../campaignView";
import type { Campaign, CampaignStatus } from "../types";
import CampaignEditor, { type RunView } from "./CampaignEditor";

const TONE: Record<CampaignStatus, "info" | "positive" | "neutral"> = { testing: "info", active: "positive", archived: "neutral" };
const STATUS_LABEL: Record<CampaignStatus, string> = { testing: "Testing", active: "Active", archived: "Archived" };

/** New campaign: a name, a niche, a region and one to ten towns. The five steps come with it. */
function CreateForm({ onCreated }: { onCreated: (c: Campaign) => void }) {
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
    <Card title="New campaign" sub="Searches one niche across a list of towns, then runs the five-step sequence on what it finds.">
      <form className="cp-form" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Name" htmlFor="cp-new-name" error={errs.name}><input id="cp-new-name" value={f.name} maxLength={100} autoComplete="off" onChange={(e) => set("name", e.target.value)} /></Field>
        <Row>
          <Field label="Niche" htmlFor="cp-new-niche" error={errs.niche}><input id="cp-new-niche" value={f.niche} maxLength={100} autoComplete="off" onChange={(e) => set("niche", e.target.value)} /></Field>
          <Field label="Region" htmlFor="cp-new-region" error={errs.region}><input id="cp-new-region" value={f.region} maxLength={100} autoComplete="off" onChange={(e) => set("region", e.target.value)} /></Field>
        </Row>
        <Field label="Towns" htmlFor="cp-new-towns" error={errs.towns} help="One per line or separated by commas. 1 to 10 towns.">
          <textarea id="cp-new-towns" rows={4} value={f.towns} onChange={(e) => set("towns", e.target.value)} />
        </Field>
        <div className="cp-actions"><button type="submit" className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create campaign"}</button></div>
        <div className={`mb-result${msg?.bad ? " bad" : ""}`} aria-live="polite" aria-atomic="true">{msg && <p>{msg.text}</p>}</div>
      </form>
    </Card>
  );
}

/** Campaigns: create one, open it to change its status, job value and steps, and start its town searches. */
export default function Campaigns() {
  const [list, setList] = useState<Campaign[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(() => api.get<Campaign[]>("/campaigns")
    .then((r) => { if (alive.current) { setList(r); setErr(""); } })
    .catch((e) => { if (alive.current) setErr(e instanceof ApiError ? e.message : "Couldn't load the campaigns."); }), []);
  useEffect(() => { void load(); }, [load]);
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

  return (
    <SettingsPage title="Campaigns" width={900} sub="A niche, a list of towns and the follow-up sequence that runs on the leads they turn up.">
      <CreateForm onCreated={(c) => { setList((all) => [{ ...c, steps: undefined }, ...(all ?? [])]); setOpen(c.id); }} />
      {err ? <Callout tone="critical" icon="alert">{err}</Callout>
        : !list ? <p className="st-loading">Loading…</p>
        : list.length === 0 ? <p className="bx-muted">No campaigns yet. Create one above.</p>
        : list.map((c) => (
          <Card key={c.id} title={c.name} sub={`${c.niche} · ${c.region} · ${c.towns.length} ${c.towns.length === 1 ? "town" : "towns"}: ${c.towns.join(", ")}`}
            action={<div className="cp-head"><Pill tone={TONE[c.status]}>{STATUS_LABEL[c.status]}</Pill>
              <button type="button" className="btn sm" aria-expanded={open === c.id} aria-controls={`cp-panel-${c.id}`} onClick={() => setOpen(open === c.id ? null : c.id)}>
                {open === c.id ? "Close" : "Edit"}<span className="sr-only"> {c.name}</span>
              </button></div>}>
            <div id={`cp-panel-${c.id}`} hidden={open !== c.id}>{open === c.id && <CampaignEditor campaign={c} onChange={replace} run={runs[c.id] ?? null} anyRunning={running !== null} onRun={() => void run(c)} />}</div>
          </Card>
        ))}
    </SettingsPage>
  );
}
