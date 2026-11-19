import { useId, useState } from "react";
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // Only the answers that changed are sent. If some are refused, the rest still go and the refused ones are marked.
  const saver = useSaver<Record<string, string>>({
    merge: (a, b) => ({ ...a, ...b }),
    onSaved: hooks.onSaved, onLocked: hooks.onLocked, onGone: hooks.onGone,
    send: async (delta) => {
      const first = await api.saveAnswers(delta);
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
  const submitted = !!q.submittedAt;

  function change(id: string, value: string, flushNow: boolean) {
    setAnswers((a) => ({ ...a, [id]: value }));
    setErrors((e) => { if (!(id in e)) return e; const next = { ...e }; delete next[id]; return next; });
    saver.schedule({ [id]: value });
    if (flushNow) void saver.flush();
  }

  async function submit() {
    if (submitting || !ok) return;
    setSubmitting(true); setSubmitError("");
    try {
      if (!(await saver.flush())) { setSubmitError("Your latest answers aren't saved yet. Fix anything marked above, or check your connection, then try again."); return; }
      const o = await api.submit();
      if (o.kind === "ok") { hooks.onSubmitted(); return; }
      if (o.kind === "gone") { hooks.onGone(); return; }
      if (o.kind === "locked") { hooks.onLocked(); return; }
      if (o.kind === "rejected") setErrors((prev) => ({ ...prev, ...Object.fromEntries(o.fields.map((f) => [f, "This question needs an answer."])) }));
      setSubmitError(o.message);
    } finally { setSubmitting(false); }
  }

  return (
    <section className="rp-card ob-card" aria-labelledby="ob-q-title">
      <div className="ob-card-head">
        <h2 id="ob-q-title">Your questions</h2>
        <span className={`ob-badge${submitted ? " ob-badge-done" : ""}`}>{submitted ? "Sent" : dueLabel(q.dueAt, now, page.timezone)}</span>
      </div>
      {submitted || closed ? (
        <>
          {submitted && <p className="ob-lead">Thank you, we have your answers.</p>}
          <Sent q={q} />
        </>
      ) : (
        <form className="ob-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
          <p className="ob-lead">Answer in your own words. Your answers save as you type, so you can close this page and come back.</p>
          {q.questions.map((x) => (
            <Field key={x.id} q={x} value={answers[x.id] ?? ""} error={errors[x.id]} disabled={submitting}
              onChange={(v) => change(x.id, v, x.type === "choice")} onBlur={() => void saver.flush()} />
          ))}
          <SaveNote state={saver.state} onRetry={() => void saver.flush()} />
          <div className="ob-actions">
            <button type="submit" className="btn primary ob-send" disabled={!ok || submitting}>{submitting ? "Sending..." : "Send answers"}</button>
          </div>
          {submitError && <p className="ob-err" role="alert">{submitError}</p>}
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
