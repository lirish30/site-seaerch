import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { Callout, Field, Row } from "../components/SettingsPage";
import { fieldErrors, parseJobValue, runSearchesLines } from "../campaignView";
import type { Campaign, CampaignStatus, SequenceStep } from "../types";
import StepEditor from "./StepEditor";

type Action = "save" | "run";

/** An open campaign: status, job value, the Run searches button with its per-town result, and the five steps. */
export default function CampaignEditor({ campaign, onChange }: { campaign: Campaign; onChange: (c: Campaign) => void }) {
  const [steps, setSteps] = useState<SequenceStep[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [status, setStatus] = useState<CampaignStatus>(campaign.status);
  const [value, setValue] = useState(campaign.est_job_value_usd === null ? "" : String(campaign.est_job_value_usd));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Action | null>(null);
  const [result, setResult] = useState<{ bad: boolean; lines: string[] } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    api.get<Campaign>(`/campaigns/${campaign.id}`).then((c) => { if (alive.current) setSteps(c.steps ?? []); })
      .catch((e) => { if (alive.current) setLoadErr(e instanceof ApiError ? e.message : "Couldn't load the steps."); });
  }, [campaign.id]);
  const id = (f: string) => `cp-${campaign.id}-${f}`;
  const say = (bad: boolean, ...lines: string[]) => setResult({ bad, lines });
  const dirty = status !== campaign.status || value.trim() !== (campaign.est_job_value_usd === null ? "" : String(campaign.est_job_value_usd));

  async function save() {
    const job = parseJobValue(value);
    if (!job.ok) { setErrs({ est_job_value_usd: "Enter an amount of 0 or more, or leave it blank." }); say(true, "Not saved: fix the highlighted fields."); return; }
    setBusy("save"); setErrs({}); setResult(null);
    try {
      const saved = await api.patch<Campaign>(`/campaigns/${campaign.id}`, { status, est_job_value_usd: job.value });
      onChange(saved); say(false, "Saved.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) { setErrs(fieldErrors(e.fields)); say(true, "Not saved: fix the highlighted fields."); }
      else say(true, `Not saved: ${e instanceof ApiError ? e.message : "request failed"}`);
    } finally { setBusy(null); }
  }

  async function run() {
    setBusy("run"); setResult(null);
    try {
      const r = await api.post<{ started: number; blocked: { town: string; reason: string }[] }>(`/campaigns/${campaign.id}/run-searches`);
      say(r.blocked.length > 0 && r.started === 0, ...runSearchesLines(r));
    } catch (e) { say(true, `Couldn't run searches: ${e instanceof ApiError ? e.message : "request failed"}`); }
    finally { setBusy(null); }
  }

  const off = busy !== null;
  return (
    <div className="cp-editor">
      <Row>
        <Field label="Status" htmlFor={id("status")} error={errs.status}>
          <select id={id("status")} value={status} disabled={off} onChange={(e) => setStatus(e.target.value as CampaignStatus)}>
            <option value="testing">Testing</option><option value="active">Active</option><option value="archived">Archived</option>
          </select>
        </Field>
        <Field label="Job value (USD)" htmlFor={id("value")} error={errs.est_job_value_usd} help="Optional. Leave blank if you are not sure yet.">
          <input id={id("value")} inputMode="decimal" value={value} disabled={off} autoComplete="off" onChange={(e) => { setValue(e.target.value); setErrs((x) => ({ ...x, est_job_value_usd: "" })); }} />
        </Field>
      </Row>
      <div className="cp-actions">
        <button type="button" className="btn primary" onClick={() => void save()} disabled={off || !dirty}>{busy === "save" ? "Saving…" : "Save"}</button>
        <button type="button" className="btn" onClick={() => void run()} disabled={off || campaign.status === "archived"} aria-describedby={campaign.status === "archived" ? id("archived") : undefined}>
          {busy === "run" ? "Starting searches…" : "Run searches"}
        </button>
      </div>
      {campaign.status === "archived" && <p className="bx-muted" id={id("archived")}>Archived campaigns can't run searches.</p>}
      <div className={`mb-result${result?.bad ? " bad" : ""}`} aria-live="polite" aria-atomic="true">
        {result?.lines.map((l, i) => <p key={i}>{l}</p>)}
      </div>

      <h3 className="cp-h">Steps</h3>
      <p className="bx-muted">Merge fields: <code>{"{Business}"}</code>, <code>{"{Name}"}</code>, <code>{"{link}"}</code>, <code>{"{problem_one}"}</code>. Each lead gets one of an email's variants.</p>
      {loadErr ? <Callout tone="critical" icon="alert">{loadErr}</Callout>
        : !steps ? <p className="st-loading">Loading steps…</p>
        : steps.map((s) => <StepEditor key={s.id} campaignId={campaign.id} step={s} locked={off} onSaved={(n) => setSteps((all) => all && all.map((x) => (x.idx === n.idx ? n : x)))} />)}
    </div>
  );
}
