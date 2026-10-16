import { useState } from "react";
import Icon from "../../components/Icon";
import SettingsPage, { Callout } from "../../components/SettingsPage";
import WorkSamplesEditor, { MAX_SAMPLES, SamplesLimitNote, useWorkSamples } from "../../components/WorkSamplesEditor";
import { samplesNeeded, samplesNudge } from "../../settingsPagesView";

/** Settings > Outreach > Work samples: the projects full-time emails may link to. Changes save as you make them. */
export default function WorkSamples() {
  const state = useWorkSamples();
  const [adding, setAdding] = useState(false);
  const { samples } = state;
  const full = (samples?.length ?? 0) >= MAX_SAMPLES;
  const needed = samples && samples.length ? samplesNeeded(samples) : 0;
  return (
    <SettingsPage title="Work samples" sub="Full-time emails link only to these. Add a result so drafts can mention it." width={900}
      badge={samples ? <span className="badge2"><i className="dot" />{samples.length} of {MAX_SAMPLES}</span> : undefined}
      action={<button type="button" className="btn primary" disabled={!samples || full} title={full ? `You can keep up to ${MAX_SAMPLES} samples` : undefined} onClick={() => setAdding(true)}><Icon name="plus" size={16} />Add sample</button>}>
      {state.error && <Callout tone="critical" icon="alert">{state.error}</Callout>}
      {!samples && !state.error && <p className="st-loading">Loading…</p>}
      {needed > 0 && <Callout tone="warn" icon="sparkles">{samplesNudge(needed)}</Callout>}
      {full && <SamplesLimitNote />}
      <WorkSamplesEditor state={state} adding={adding && !full} onAdd={() => setAdding(true)} closeAdd={() => setAdding(false)} />
    </SettingsPage>
  );
}
