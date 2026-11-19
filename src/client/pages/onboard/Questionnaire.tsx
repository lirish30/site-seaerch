import { useEffect, useId, useRef, useState } from "react";
import Icon from "../../components/Icon";
import { canSubmit, dueLabel, type PublicOnboarding } from "../../onboardView";
import type { OnboardApi } from "./api";
import SaveNote from "./SaveNote";
import { useSaver } from "./useSaver";

type Question = PublicOnboarding["questionnaire"]["questions"][number];

export interface PageHooks { onSubmitted: () => void; onLocked: () => void; onGone: () => void; onSaved: () => void }

/** One question. The question text is the owner's and the answer is the client's own: both are shown as React text. */
function Field({ q, value, error, disabled, onChange, onBlur }: {
  q: Question; value: string; error?: string; disabled: boolean; onChange: (v: string) => void; onBlur: () => void;
}) {
  const id = useId();
  const hint = q.help ? `${id}-help` : undefined;
  const err = error ? `${id}-err` : undefined;
  const describedBy = [hint, err].filter(Boolean).join(" ") || undefined;
  const label = <>{q.label}{!q.required && <span className="ob-opt"> (optional)</span>}</>;
  if (q.type === "choice") {
    return (
      <fieldset className="ob-field ob-choice" aria-describedby={describedBy}>
        <legend>{label}</legend>
        {q.help && <small id={hint}>{q.help}</small>}
        {(q.options ?? []).map((opt) => (
          <label key={opt} className="ob-radio"><input type="radio" name={id} checked={value === opt} disabled={disabled} onChange={() => onChange(opt)} /><span>{opt}</span></label>
        ))}
        {error && <p className="ob-err" id={err} role="alert">{error}</p>}
      </fieldset>
    );
  }
  const common = { id, value, disabled, onBlur, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, autoComplete: "off" as const };
  return (
    <div className="ob-field">
      <label htmlFor={id}>{label}</label>
      {q.help && <small id={hint}>{q.help}</small>}
      {q.type === "long"
        ? <textarea {...common} rows={5} maxLength={3000} onChange={(e) => onChange(e.target.value)} />
        : <input {...common} type="text" maxLength={300} onChange={(e) => onChange(e.target.value)} />}
      {error && <p className="ob-err" id={err} role="alert">{error}</p>}
    </div>
  );
}

/** What they sent, read-only: after the questionnaire is handed in, or when the onboarding is closed. */
function Sent({ q }: { q: PublicOnboarding["questionnaire"] }) {
  return (
    <dl className="ob-answers">
      {q.questions.map((x) => <div key={x.id}><dt>{x.label}</dt><dd>{(q.answers[x.id] ?? "").trim() || "No answer"}</dd></div>)}
    </dl>
  );
}

export default function Questionnaire({ page, api, now, closed, hooks }: { page: PublicOnboarding; api: OnboardApi; now: Date; closed: boolean; hooks: PageHooks }) {
  const q = page.questionnaire;
  const [answers, setAnswers] = useState<Record<string, string>>(q.answers);
  const [errors, setErrorsState] = useState<Record<string, string>>({});
  const errorsRef = useRef(errors);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sentNow, setSentNow] = useState(false);
  const confirmBox = useRef<HTMLDivElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);

  /** The marks on refused answers, also kept in a ref so the saver can ask whether any are outstanding right now. */
  function setErrors(update: (prev: Record<string, string>) => Record<string, string>) {
    errorsRef.current = update(errorsRef.current);
    setErrorsState(errorsRef.current);
  }

  // Only the answers that changed are sent. If some are refused, the rest still go and the refused ones are marked.
  const saver = useSaver<Record<string, string>>({
    merge: (a, b) => ({ ...a, ...b }),
    blocked: () => Object.keys(errorsRef.current).length > 0,
    unload: { plan: api.answersUnload, fire: (plan) => api.sendNow(plan, "answers") },
    onSaved: hooks.onSaved, onLocked: hooks.onLocked, onGone: hooks.onGone,
    send: async (delta, gate) => {
      const first = await api.saveAnswers(delta, gate);
      if (first.kind !== "rejected" || !first.fields.length) return first;
      const bad = new Set(first.fields);
      setErrors((prev) => ({ ...prev, ...Object.fromEntries(first.fields.map((f) => [f, first.message])) }));
      const rest = Object.fromEntries(Object.entries(delta).filter(([id]) => !bad.has(id)));
      if (!Object.keys(rest).length) return first;
      const second = await api.saveAnswers(rest);
      return second.kind === "ok" ? first : second;
    },
  });

  const { ok, missing } = canSubmit({ ...q, answers });
  const refused = Object.keys(errors).length > 0;
  const submitted = !!q.submittedAt || sentNow;
  const canSend = ok && !refused && !submitting;

  // Moving to the confirmation moves focus to it; going back returns focus to the button that opened it.
  useEffect(() => { if (confirming) confirmBox.current?.focus(); }, [confirming]);
  // If an answer is cleared or refused while the question is open, it is no longer sendable: close it.
  useEffect(() => { if (confirming && (!ok || refused)) setConfirming(false); }, [confirming, ok, refused]);

  function change(id: string, value: string, flushNow: boolean) {
    setAnswers((a) => ({ ...a, [id]: value }));
    setErrors((e) => { if (!(id in e)) return e; const next = { ...e }; delete next[id]; return next; });
    saver.schedule({ [id]: value });
    if (flushNow) void saver.flush();
  }

  function keep() {
    setConfirming(false);
    setTimeout(() => sendButton.current?.focus(), 0);
  }

  /** Only the "Yes, send" button gets here. Sending locks the answers. */
  async function submit() {
    if (submitting || !canSend) return;
    setSubmitting(true); setSubmitError("");
    try {
      if (!(await saver.flush())) { setSubmitError("Your latest answers aren't saved yet. Fix anything marked above, or check your connection, then try again."); setConfirming(false); return; }
      const o = await api.submit();
      if (o.kind === "ok") { setSentNow(true); setConfirming(false); hooks.onSubmitted(); return; }
      setConfirming(false);
      if (o.kind === "gone") { hooks.onGone(); return; }
      if (o.kind === "locked") { hooks.onLocked(); return; }
      if (o.kind === "rejected") setErrors((prev) => ({ ...prev, ...Object.fromEntries(o.fields.map((f) => [f, "This question needs an answer."])) }));
      setSubmitError(o.message);
    } finally { setSubmitting(false); }
  }

  // Enter in a one-line box must not send the form: sending cannot be undone. Buttons keep Enter, and a long answer keeps its new lines.
  function noEnterSubmit(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
  }

  return (
    <section className="rp-card ob-card" aria-labelledby="ob-q-title">
      <div className="ob-card-head">
        <h2 id="ob-q-title">Your questions</h2>
        <span className={`ob-badge${submitted ? " ob-badge-done" : ""}`}>{submitted ? "Sent" : dueLabel(q.dueAt, now, page.timezone)}</span>
      </div>
      {submitted || closed ? (
        <>
          {submitted && <p className="ob-lead" role="status">{sentNow && !q.submittedAt ? "Sent. Thank you." : "Thank you, we have your answers."}</p>}
          <Sent q={sentNow && !q.submittedAt ? { ...q, answers } : q} />
        </>
      ) : (
        <form className="ob-form" onSubmit={(e) => e.preventDefault()} onKeyDown={noEnterSubmit} noValidate>
          <p className="ob-lead">Answer in your own words. Your answers save as you type, so you can close this page and come back.</p>
          {q.questions.map((x) => (
            <Field key={x.id} q={x} value={answers[x.id] ?? ""} error={errors[x.id]} disabled={submitting}
              onChange={(v) => change(x.id, v, x.type === "choice")} onBlur={() => void saver.flush()} />
          ))}
          <SaveNote state={saver.state} onRetry={() => void saver.flush()} />
          {confirming ? (
            <div className="ob-confirm" ref={confirmBox} tabIndex={-1} role="alertdialog" aria-labelledby="ob-confirm-title" aria-describedby="ob-confirm-text"
              onKeyDown={(e) => { if (e.key === "Escape" && !submitting) { e.stopPropagation(); keep(); } }}>
              <p id="ob-confirm-title" className="ob-confirm-title">Send now?</p>
              <p id="ob-confirm-text">You won't be able to change your answers after this.</p>
              <div className="ob-confirm-actions">
                <button type="button" className="btn primary ob-send" disabled={submitting} onClick={() => void submit()}>{submitting ? "Sending..." : "Yes, send"}</button>
                <button type="button" className="btn ob-keep" disabled={submitting} onClick={keep}>Keep editing</button>
              </div>
            </div>
          ) : (
            <div className="ob-actions">
              <button ref={sendButton} type="button" className="btn primary ob-send" disabled={!canSend} onClick={() => setConfirming(true)}>Send answers</button>
            </div>
          )}
          {submitError && <p className="ob-err" role="alert">{submitError}</p>}
          {refused && <p className="ob-err">Fix the answers marked above before you send.</p>}
          {!ok && (
            <div className="ob-missing">
              <p>Still needed before you can send:</p>
              <ul>{missing.map((id) => <li key={id}>{q.questions.find((x) => x.id === id)?.label ?? id}</li>)}</ul>
            </div>
          )}
          <p className="ob-fine"><Icon name="info" size={14} />Once you send them, they are locked. If something needs to change later, reply to the email you were sent.</p>
        </form>
      )}
    </section>
  );
}
