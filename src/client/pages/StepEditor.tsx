import { useState } from "react";
import { api, ApiError } from "../api";
import { Chip } from "../components/ds";
import Icon, { type IconName } from "../components/Icon";
import { fieldErrors, stepLabel } from "../campaignView";
import type { OffsetKind, SequenceStep } from "../types";

const MAX_VARIANTS = 5;
const KIND: Record<SequenceStep["kind"], { icon: IconName; tone: string; name: string }> = {
  email: { icon: "mail", tone: "info", name: "Email" },
  call: { icon: "phone", tone: "signal", name: "Call" },
  checkin: { icon: "calendar", tone: "positive", name: "Check-in" },
};

/** What the row says about a step before it is opened: the subject, or how the body is written. */
function preview(step: SequenceStep): string {
  if (step.body_source === "draft") return "Written for each lead from its draft";
  if (step.kind === "call") return step.variants[0]?.trim() ? `Call note: ${step.variants[0]}` : "A call on your list for that day";
  const n = step.variants.length;
  return `${step.subject.trim() ? `“${step.subject}”` : "No subject yet"} · ${n} ${n === 1 ? "version" : "versions"}`;
}

/**
 * One step of a campaign's sequence as a row on the step line: its type, when it is due and what it sends. Opening it shows its editor (when it is due, its subject and
 * the versions of its message, one picked per lead); each step saves on its own.
 */
export default function StepEditor({ campaignId, step, locked, open, onToggle, onSaved, last = false }: {
  campaignId: string; step: SequenceStep; locked: boolean; open: boolean; onToggle: () => void; onSaved: (s: SequenceStep) => void; last?: boolean;
}) {
  const [days, setDays] = useState(String(step.offset_days));
  const [kind, setKind] = useState<OffsetKind>(step.offset_kind);
  const [subject, setSubject] = useState(step.subject);
  const [variants, setVariants] = useState<string[]>(step.variants);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ bad: boolean; text: string } | null>(null);
  const fromDraft = step.body_source === "draft";
  const isCall = step.kind === "call";
  const k = KIND[step.kind];
  const id = (f: string) => `step-${campaignId}-${step.idx}-${f}`;
  const clear = (key: string) => setErrs((e) => ({ ...e, [key]: "" }));
  const setVariant = (i: number, v: string) => { setVariants((all) => all.map((x, n) => (n === i ? v : x))); clear("variants"); };
  const dirty = days !== String(step.offset_days) || kind !== step.offset_kind || subject !== step.subject || variants.join("\u0000") !== step.variants.join("\u0000");

  async function save() {
    const n = Number(days);
    const next: Record<string, string> = {};
    if (!/^\d+$/.test(days.trim()) || n > 365) next.offset_days = "Enter a whole number from 0 to 365.";
    if (variants.some((v) => !v.trim())) next.variants = "Fill in or remove the empty versions.";
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
    <li className={`slx-seq${open ? " open" : ""}${last ? " last" : ""}`}>
      <button type="button" className="slx-seq-row" aria-expanded={open} aria-controls={id("panel")} onClick={onToggle}>
        <span className={`ds-tile ${k.tone}`}><Icon name={k.icon} size={16} /></span>
        <span className="slx-seq-text">
          <b>Step {step.idx + 1} · {k.name}</b>
          <small>{preview(step)}</small>
        </span>
        <Chip tone="outline">{stepLabel({ kind: step.kind, offset_days: step.offset_days, offset_kind: step.offset_kind }).split(" · ")[1]}</Chip>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={14} className="ds-chev" />
      </button>
      {open && (
        <fieldset className="slx-seq-form ds-form" id={id("panel")} disabled={busy || locked}>
          <legend className="sr-only">{`Step ${step.idx + 1}: ${stepLabel({ kind: step.kind, offset_days: step.offset_days, offset_kind: step.offset_kind })}`}</legend>
          <div className="wide slx-seq-when">
            <label className="deal-field slx-short" htmlFor={id("days")}><span>Days after the start</span>
              <input id={id("days")} inputMode="numeric" value={days} autoComplete="off" aria-invalid={!!errs.offset_days} onChange={(e) => { setDays(e.target.value); clear("offset_days"); }} />
              {errs.offset_days && <small className="slx-bad">{errs.offset_days}</small>}</label>
            <label className="deal-field slx-mid" htmlFor={id("kind")}><span>Counted in</span>
              <select id={id("kind")} value={kind} onChange={(e) => setKind(e.target.value as OffsetKind)}>
                <option value="business">Business days</option><option value="calendar">Calendar days</option>
              </select>
              {errs.offset_kind && <small className="slx-bad">{errs.offset_kind}</small>}</label>
          </div>
          {fromDraft && <p className="wide slx-seq-note"><Icon name="sparkles" size={14} />This email is written for each lead from its draft, so there is no text to edit here.</p>}
          {!fromDraft && !isCall && (
            <label className="deal-field wide" htmlFor={id("subject")}><span>Subject</span>
              <input id={id("subject")} value={subject} autoComplete="off" aria-invalid={!!errs.subject} onChange={(e) => { setSubject(e.target.value); clear("subject"); }} />
              {errs.subject && <small className="slx-bad">{errs.subject}</small>}</label>
          )}
          {!fromDraft && variants.map((v, i) => (
            <div key={i} className="deal-field wide slx-variant">
              <span className="slx-variant-head"><label htmlFor={id(`v${i}`)}>{isCall ? "Call note" : `Version ${i + 1}`}</label>
                {!isCall && variants.length > 1 && <button type="button" className="slx-link-btn" onClick={() => setVariants((all) => all.filter((_, n) => n !== i))}>Remove version {i + 1}</button>}</span>
              <textarea id={id(`v${i}`)} rows={5} value={v} aria-invalid={i === 0 && !!errs.variants} onChange={(e) => setVariant(i, e.target.value)} />
              {i === 0 && errs.variants && <small className="slx-bad">{errs.variants}</small>}
            </div>
          ))}
          <div className="ds-form-actions">
            <button type="button" className="btn primary" disabled={!dirty} onClick={() => void save()}>{busy ? "Saving…" : `Save step ${step.idx + 1}`}</button>
            {!fromDraft && !isCall && variants.length < MAX_VARIANTS && <button type="button" className="btn" onClick={() => setVariants((all) => [...all, ""])}><Icon name="plus" size={14} />Add a version</button>}
            <span className={`slx-msg${msg?.bad ? " bad" : ""}`} aria-live="polite" aria-atomic="true">{msg?.text}</span>
          </div>
        </fieldset>
      )}
    </li>
  );
}
