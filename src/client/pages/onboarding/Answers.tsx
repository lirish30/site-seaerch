import type { OwnerOnboarding } from "../../../worker/onboarding/owner";
import type { Question } from "../../../worker/onboarding/templates";
import { when } from "./shared";

/** What the client typed in the questionnaire, read-only, one question after another. It is the client's own text, so it is only ever shown as text. */
export default function Answers({ o, questions, answers }: { o: OwnerOnboarding; questions: Question[]; answers: Record<string, string> }) {
  const done = questions.filter((q) => answers[q.id]?.trim()).length;
  return (
    <section aria-label="Questionnaire answers" className="slx-answers">
      <p className="slx-hint">{o.questionnaireSubmittedAt ? `Handed in ${when(o.questionnaireSubmittedAt)}.` : `Not handed in yet. ${done} of ${questions.length} answered so far; this is what the client has saved.`}</p>
      <ol className="onb-answers slx-answer-list">
        {questions.map((q, i) => (
          <li key={q.id}>
            <span className="slx-q-num">{i + 1}</span>
            <div>
              <p className="slx-q">{q.label}{q.required && <span className="slx-hint"> · needed</span>}</p>
              {answers[q.id]?.trim() ? <p className="onb-text slx-a">{answers[q.id]}</p> : <p className="slx-hint">No answer yet</p>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
