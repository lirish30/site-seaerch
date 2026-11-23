import { useEffect, useState } from "react";
import { ApiError, clientsApi } from "../../api";
import { gradeChipLabel, problemText } from "../../clientView";
import type { GradeView } from "../../../worker/clients/grade";
import type { Grade } from "../../../worker/db/grade";
import { Card, Chip, type Tone } from "../ds";
import Icon from "../Icon";

const TONE: Record<Grade, Tone> = { A: "positive", B: "neutral", C: "warning" };
const NOTE_MAX = 300;

/**
 * The grade as a chip that says it in words: "Grade A", or "Grade B suggested" in a lighter style while the owner has not set one. All text is a React text node.
 * `compact` (for a table column that is already headed Grade) drops the visible word "Grade", which screen readers still get.
 */
export function GradeChip({ grade, compact = false }: { grade: Pick<GradeView, "grade" | "suggested">; compact?: boolean }) {
  const { letter, suggested } = gradeChipLabel(grade);
  return (
    <Chip tone={suggested ? "outline" : TONE[letter]} title={suggested ? "Suggested by the rules; you have not set a grade" : undefined}>
      {compact ? <span className="sr-only">Grade </span> : "Grade "}{letter}{suggested && <span className={compact ? "sr-only" : "gr-suggested"}> suggested</span>}
    </Chip>
  );
}

/**
 * The grade card on a client's page: the chip, the picker (A, B, C or no grade), a note of up to 300 characters, and the rules' suggestion with its reasons. The suggestion is only
 * advice: nothing here changes the grade unless the owner picks one. Choosing a letter saves it with the note as typed; "Save note" saves a note on a grade already set.
 */
export default function GradePanel({ businessId, grade, onChanged }: { businessId: string; grade: GradeView; onChanged: () => Promise<void> }) {
  const [note, setNote] = useState(grade.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A newly loaded grade (another client, or a refresh) replaces what was typed.
  useEffect(() => { setNote(grade.note); setError(""); }, [businessId, grade.note, grade.grade]);

  async function save(next: Grade | null) {
    if (busy) return;
    setBusy(true); setError("");
    try { await clientsApi.setGrade(businessId, next, next === null ? "" : note.trim()); await onChanged(); }
    catch (e) { setError(e instanceof ApiError ? problemText(e, "Could not save the grade.") : "Could not save the grade."); }
    finally { setBusy(false); }
  }

  const dirty = grade.grade !== null && note.trim() !== grade.note;
  return (
    <Card icon="star" title="Grade" note={<GradeChip grade={grade} />} className="clx-grade">
      <p className="clx-help">Your own call on how good a client this is. A is a keeper, C is one to think about.</p>
      <div className="ds-seg" role="group" aria-label="Set the grade">
        {(["A", "B", "C"] as const).map((g) => <button key={g} type="button" aria-pressed={grade.grade === g} disabled={busy} onClick={() => void save(g)}>Grade {g}</button>)}
        <button type="button" aria-pressed={grade.grade === null} disabled={busy || grade.grade === null} onClick={() => void save(null)}>No grade</button>
      </div>
      <label className="deal-field" htmlFor="gr-note"><span>Note</span>
        <textarea id="gr-note" rows={2} maxLength={NOTE_MAX} value={note} placeholder="Why this grade (optional)" onChange={(e) => setNote(e.target.value)} />
      </label>
      {dirty && <p><button type="button" className="btn sm" disabled={busy} onClick={() => void save(grade.grade)}>{busy ? "Saving…" : "Save note"}</button></p>}
      {error && <p className="error small" role="alert">{error}</p>}
      <p className="clx-sub">The rules suggest {grade.suggested}</p>
      <ul className="ds-reasons">{grade.reasons.map((r) => <li key={r}><Icon name="info" size={14} />{r}</li>)}</ul>
    </Card>
  );
}
