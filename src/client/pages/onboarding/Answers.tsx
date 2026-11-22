import type { OwnerOnboarding } from "../../../worker/onboarding/owner";
import type { Question } from "../../../worker/onboarding/templates";
import { when } from "./shared";

/** What the client typed in the questionnaire, read-only. It is the client's own text, so it is only ever shown as text. */
export default function Answers({ o, questions, answers }: { o: OwnerOnboarding; questions: Question[]; answers: Record<string, string> }) {
  return (
    <section aria-label="Questionnaire answers" className="slx-form">
      <p className="slx-hint">{o.questionnaireSubmittedAt ? `Handed in ${when(o.questionnaireSubmittedAt)}.` : "Not handed in yet. What is here is what the client has saved so far."}</p>
      <dl className="onb-answers">
        {questions.map((q) => (
          <div key={q.id}>
            <dt>{q.label}</dt>
            <dd className="onb-text">{answers[q.id]?.trim() ? answers[q.id] : <span className="slx-hint">No answer</span>}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
