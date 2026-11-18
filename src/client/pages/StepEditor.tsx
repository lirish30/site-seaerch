import { useState } from "react";
import { api, ApiError } from "../api";
import { Field, Row } from "../components/SettingsPage";
import { fieldErrors, stepLabel } from "../campaignView";
import type { OffsetKind, SequenceStep } from "../types";

const MAX_VARIANTS = 5;

/** One step of a campaign's sequence: when it is due, its subject and its message variants. Saves on its own. */
export default function StepEditor({ campaignId, step, locked, onSaved }: { campaignId: string; step: SequenceStep; locked: boolean; onSaved: (s: SequenceStep) => void }) {
  const [days, setDays] = useState(String(step.offset_days));
  const [kind, setKind] = useState<OffsetKind>(step.offset_kind);
  const [subject, setSubject] = useState(step.subject);
  const [variants, setVariants] = useState<string[]>(step.variants);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ bad: boolean; text: string } | null>(null);
  const fromDraft = step.body_source === "draft";
  const isCall = step.kind === "call";
  const id = (f: string) => `step-${campaignId}-${step.idx}-${f}`;
  const clear = (k: string) => setErrs((e) => ({ ...e, [k]: "" }));
  const setVariant = (i: number, v: string) => { setVariants((all) => all.map((x, n) => (n === i ? v : x))); clear("variants"); };

  async function save() {
    const n = Number(days);
    const next: Record<string, string> = {};
    if (!/^\d+$/.test(days.trim()) || n > 365) next.offset_days = "Enter a whole number from 0 to 365.";
    if (variants.some((v) => !v.trim())) next.variants = "Fill in or remove the empty variants.";
    setErrs(next);
    if (Object.keys(next).length) { setMsg({ bad: true, text: `Step ${step.idx + 1} not saved: fix the highlighted fields.` }); return; }
    setBusy(true); setMsg(null);
    try {
      const saved = await api.put<SequenceStep>(`/campaigns/${campaignId}/steps/${step.idx}`, {
        kind: step.kind, offset_days: n, offset_kind: kind, subject, variants: fromDraft ? [] : variants, body_source: step.body_source,
      });
      onSaved(saved); setMsg({ bad: false, text: `Step ${step.idx + 1} saved.` });
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) { setErrs(fieldErrors(e.fields)); setMsg({ bad: true, text: `Step ${step.idx + 1} not saved: ${e.message}.` }); }
      else setMsg({ bad: true, text: `Step ${step.idx + 1} not saved: ${e instanceof ApiError ? e.message : "request failed"}` });
    } finally { setBusy(false); }
  }

  return (
    <fieldset className="cp-step" disabled={busy || locked}>
      <legend>{`Step ${step.idx + 1}: ${stepLabel({ kind: step.kind, offset_days: step.offset_days, offset_kind: step.offset_kind })}`}</legend>
      <Row>
        <Field label="Days after the start" htmlFor={id("days")} error={errs.offset_days}>
          <input id={id("days")} inputMode="numeric" value={days} autoComplete="off" onChange={(e) => { setDays(e.target.value); clear("offset_days"); }} />
        </Field>
        <Field label="Counted in" htmlFor={id("kind")} error={errs.offset_kind}>
          <select id={id("kind")} value={kind} onChange={(e) => setKind(e.target.value as OffsetKind)}>
            <option value="business">Business days</option><option value="calendar">Calendar days</option>
          </select>
        </Field>
      </Row>
      {fromDraft && <p className="bx-muted">Written per lead from the draft</p>}
      {!fromDraft && !isCall && (
        <Field label="Subject" htmlFor={id("subject")} error={errs.subject}>
          <input id={id("subject")} value={subject} autoComplete="off" onChange={(e) => { setSubject(e.target.value); clear("subject"); }} />
        </Field>
      )}
      {!fromDraft && variants.map((v, i) => (
        <Field key={i} label={isCall ? "Call note" : `Variant ${i + 1}`} htmlFor={id(`v${i}`)} error={i === 0 ? errs.variants : undefined}>
          <textarea id={id(`v${i}`)} rows={6} value={v} onChange={(e) => setVariant(i, e.target.value)} />
          {!isCall && variants.length > 1 && (
            <button type="button" className="btn sm cp-remove" onClick={() => setVariants((all) => all.filter((_, n) => n !== i))}>Remove variant {i + 1}</button>
          )}
        </Field>
      ))}
      <div className="cp-actions">
        {!fromDraft && !isCall && variants.length < MAX_VARIANTS && <button type="button" className="btn sm" onClick={() => setVariants((all) => [...all, ""])}>Add a variant</button>}
        <button type="button" className="btn" onClick={() => void save()}>{busy ? "Saving…" : `Save step ${step.idx + 1}`}</button>
      </div>
      <div className={`mb-result${msg?.bad ? " bad" : ""}`} aria-live="polite" aria-atomic="true">{msg && <p>{msg.text}</p>}</div>
    </fieldset>
  );
}
