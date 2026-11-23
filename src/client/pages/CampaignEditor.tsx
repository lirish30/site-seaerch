import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { Banner } from "../components/ds";
import { SwitchRow } from "../components/StepFields";
import Icon from "../components/Icon";
import { VIDEO_EMAIL_LABEL, fieldErrors, parseJobValue, videoEmailHelp } from "../campaignView";
import type { Campaign, CampaignStatus, SequenceStep } from "../types";
import StepEditor from "./StepEditor";

/** What the page knows about this campaign's Run searches: the lines to show, how they read, and whether this one is still starting. */
export interface RunView { starting: boolean; tone: "ok" | "warn" | "bad"; lines: string[] }

const MERGE = ["{Business}", "{Name}", "{link}", "{problem_one}"];

/**
 * An open campaign, in two parts. Settings: status, job value and whether Email 1 carries the video audit, with Save and Run searches (and its per-town result).
 * The steps: the five follow-up steps as a line of rows (email, call, check-in) that open one at a time to edit. The run itself (in-flight flag and last result)
 * lives in the page so closing and reopening this editor neither loses it nor re-enables a running button.
 */
export default function CampaignEditor({ campaign, onChange, run, anyRunning, onRun }: {
  campaign: Campaign; onChange: (c: Campaign) => void; run: RunView | null; anyRunning: boolean; onRun: () => void;
}) {
  const [steps, setSteps] = useState<SequenceStep[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [status, setStatus] = useState<CampaignStatus>(campaign.status);
  const [value, setValue] = useState(campaign.est_job_value_usd === null ? "" : String(campaign.est_job_value_usd));
  const [videoEmail, setVideoEmail] = useState<0 | 1>(campaign.video_email);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ bad: boolean; lines: string[] } | null>(null);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    api.get<Campaign>(`/campaigns/${campaign.id}`).then((c) => { if (alive.current) setSteps(c.steps ?? []); })
      .catch((e) => { if (alive.current) setLoadErr(e instanceof ApiError ? e.message : "Couldn't load the steps."); });
  }, [campaign.id]);
  const id = (f: string) => `cp-${campaign.id}-${f}`;
  const say = (bad: boolean, ...lines: string[]) => setResult({ bad, lines });
  const dirty = status !== campaign.status || videoEmail !== campaign.video_email || value.trim() !== (campaign.est_job_value_usd === null ? "" : String(campaign.est_job_value_usd));

  async function save() {
    const job = parseJobValue(value);
    if (!job.ok) { setErrs({ est_job_value_usd: "Enter an amount of 0 or more, or leave it blank." }); say(true, "Not saved: fix the highlighted fields."); return; }
    setSaving(true); setErrs({}); setResult(null);
    try {
      const saved = await api.patch<Campaign>(`/campaigns/${campaign.id}`, { status, est_job_value_usd: job.value, video_email: videoEmail });
      onChange(saved); setStatus(saved.status); setVideoEmail(saved.video_email); setValue(saved.est_job_value_usd === null ? "" : String(saved.est_job_value_usd)); say(false, "Saved.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) { setErrs(fieldErrors(e.fields)); say(true, "Not saved: fix the highlighted fields."); }
      else say(true, `Not saved: ${e instanceof ApiError ? e.message : "request failed"}`);
    } finally { setSaving(false); }
  }

  const off = saving;
  const runText = run?.starting ? "Starting searches…" : anyRunning ? "Another campaign is starting searches. Run searches is off until it finishes." : "";
  return (
    <div className="slx-camp-editor">
      <section className="slx-camp-sec" aria-label="Campaign settings">
        <h3 className="slx-camp-h"><Icon name="sliders" size={14} />Settings</h3>
        <div className="ds-form">
          <label className="deal-field slx-mid" htmlFor={id("status")}><span>Status</span>
            <select id={id("status")} value={status} disabled={off} onChange={(e) => setStatus(e.target.value as CampaignStatus)}>
              <option value="testing">Testing</option><option value="active">Active</option><option value="archived">Archived</option>
            </select>
            {errs.status ? <small className="slx-bad">{errs.status}</small> : <small>Testing tries it on a few leads first.</small>}</label>
          <label className="deal-field slx-short" htmlFor={id("value")}><span>Average job value</span>
            <span className="slx-money-in"><i>$</i><input id={id("value")} inputMode="decimal" value={value} disabled={off} autoComplete="off" placeholder="450" aria-invalid={!!errs.est_job_value_usd}
              onChange={(e) => { setValue(e.target.value); setErrs((x) => ({ ...x, est_job_value_usd: "" })); }} /></span>
            {errs.est_job_value_usd ? <small className="slx-bad">{errs.est_job_value_usd}</small> : <small>Optional. Used to size each lead.</small>}</label>
          <div className="wide">
            <SwitchRow checked={videoEmail === 1} onChange={(on) => !off && setVideoEmail(on ? 1 : 0)} label={VIDEO_EMAIL_LABEL} help={videoEmail === 1 ? videoEmailHelp(videoEmail) : "Off: Email 1 is the written draft only."} />
          </div>
          <div className="ds-form-actions">
            <button type="button" className="btn primary" onClick={() => void save()} disabled={off || !dirty}>{saving ? "Saving…" : "Save settings"}</button>
            <button type="button" className="btn" onClick={onRun} disabled={off || anyRunning || campaign.status === "archived"} aria-describedby={campaign.status === "archived" ? id("archived") : undefined}>
              <Icon name="search" size={14} />{run?.starting ? "Starting searches…" : `Run searches in ${campaign.towns.length} ${campaign.towns.length === 1 ? "town" : "towns"}`}
            </button>
            <span className={`slx-msg${result?.bad ? " bad" : ""}`} aria-live="polite" aria-atomic="true">{result?.lines.join(" ")}</span>
          </div>
        </div>
        {campaign.status === "archived" && <p className="slx-hint" id={id("archived")}>Archived campaigns can’t run searches. Set it to Testing or Active first.</p>}
        <div aria-live="polite" aria-atomic="true">
          {runText ? <p className="slx-hint">{runText}</p>
            : run && run.lines.length > 0 && (
              <Banner tone={run.tone === "ok" ? "positive" : run.tone === "warn" ? "warning" : "critical"} icon="search" title={run.lines[0]}>{run.lines.slice(1).join(" ")}</Banner>
            )}
        </div>
      </section>

      <section className="slx-camp-sec" aria-label="The follow-up steps">
        <h3 className="slx-camp-h"><Icon name="list" size={14} />The follow-up steps<small>Open a step to change when it goes and what it says.</small></h3>
        <p className="slx-merge">Fill-ins: {MERGE.map((m) => <code key={m}>{m}</code>)}<span>Each lead gets one version of each email.</span></p>
        {loadErr ? <Banner tone="critical" icon="alert" title="Couldn’t load the steps">{loadErr}</Banner>
          : !steps ? <p className="slx-muted">Loading steps…</p>
          : (
            <ol className="slx-seq-list">
              {steps.map((s, i) => (
                <StepEditor key={s.id} campaignId={campaign.id} step={s} locked={off} last={i === steps.length - 1} open={openStep === s.idx} onToggle={() => setOpenStep(openStep === s.idx ? null : s.idx)}
                  onSaved={(n) => setSteps((all) => all && all.map((x) => (x.idx === n.idx ? n : x)))} />
              ))}
            </ol>
          )}
      </section>
    </div>
  );
}
