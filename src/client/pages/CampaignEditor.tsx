import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { Callout, Field, Row } from "../components/SettingsPage";
import { VIDEO_EMAIL_LABEL, fieldErrors, parseJobValue, videoEmailHelp } from "../campaignView";
import type { Campaign, CampaignStatus, SequenceStep } from "../types";
import StepEditor from "./StepEditor";

/** What the page knows about this campaign's Run searches: the lines to show, how they read, and whether this one is still starting. */
export interface RunView { starting: boolean; tone: "ok" | "warn" | "bad"; lines: string[] }

/**
 * An open campaign: status, job value, the Run searches button with its per-town result, and the five steps. The run itself
 * (in-flight flag and last result) lives in the page so closing and reopening this editor neither loses it nor re-enables a running button.
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
      <label className="check" htmlFor={id("video")}>
        <input id={id("video")} className="cb" type="checkbox" checked={videoEmail === 1} disabled={off} aria-describedby={videoEmail === 1 ? id("video-help") : undefined} onChange={(e) => setVideoEmail(e.target.checked ? 1 : 0)} />
        {VIDEO_EMAIL_LABEL}
      </label>
      {videoEmail === 1 && <p className="bx-muted" id={id("video-help")}>{videoEmailHelp(videoEmail)}</p>}
      <div className="cp-actions">
        <button type="button" className="btn primary" onClick={() => void save()} disabled={off || !dirty}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" className="btn" onClick={onRun} disabled={off || anyRunning || campaign.status === "archived"} aria-describedby={campaign.status === "archived" ? id("archived") : undefined}>
          {run?.starting ? "Starting searches…" : "Run searches"}
        </button>
      </div>
      {campaign.status === "archived" && <p className="bx-muted" id={id("archived")}>Archived campaigns can't run searches.</p>}
      <div className={`mb-result${result?.bad ? " bad" : ""}`} aria-live="polite" aria-atomic="true">
        {result?.lines.map((l, i) => <p key={i}>{l}</p>)}
      </div>
      <div className={`mb-result${run && !run.starting && run.tone !== "ok" ? ` ${run.tone}` : ""}`} aria-live="polite" aria-atomic="true">
        {run?.starting ? <p className="mb-note">Starting searches…</p>
          : anyRunning ? <p className="mb-note">Another campaign is starting searches. Run searches is off until it finishes.</p>
          : run?.lines.map((l, i) => <p key={i}>{l}</p>)}
      </div>

      <h3 className="cp-h">Steps</h3>
      <p className="bx-muted">Merge fields: <code>{"{Business}"}</code>, <code>{"{Name}"}</code>, <code>{"{link}"}</code>, <code>{"{problem_one}"}</code>. Each lead gets one of an email's variants.</p>
      {loadErr ? <Callout tone="critical" icon="alert">{loadErr}</Callout>
        : !steps ? <p className="st-loading">Loading steps…</p>
        : steps.map((s) => <StepEditor key={s.id} campaignId={campaign.id} step={s} locked={off} onSaved={(n) => setSteps((all) => all && all.map((x) => (x.idx === n.idx ? n : x)))} />)}
    </div>
  );
}
