import type { CallPrep } from "../worker/queue/callPrep";
import type { Package } from "../worker/db/packages";
import { BASE_PUSHBACKS, DISCOVERY_QUESTIONS, DISCOVERY_STRUCTURE, mergePrices } from "../worker/sales/discovery";

export interface PrepDisplay {
  structure: typeof DISCOVERY_STRUCTURE;
  questions: { n: number; text: string; tailored?: string }[];
  flags: CallPrep["flags"];
  pushbacks: { objection: string; answer: string }[];
}

/**
 * What the call-prep panel shows. The fixed 20-minute structure and the ten questions are always there, with or without Claude's prep (Claude only adds
 * a tailored note per question). Pushbacks are Claude's when it has written them and Logan's six from the Web Kit when it has not, prices merged in
 * from the catalog either way.
 */
export function prepForDisplay(prep: CallPrep | null, catalog: Package[]): PrepDisplay {
  const notes = new Map<number, string>();
  for (const x of prep?.questionNotes ?? []) if (!notes.has(x.n)) notes.set(x.n, x.tailored);
  const pushbacks = prep && prep.pushbacks.length > 0 ? prep.pushbacks : BASE_PUSHBACKS;
  return {
    structure: DISCOVERY_STRUCTURE,
    questions: DISCOVERY_QUESTIONS.map((text, i) => ({ n: i + 1, text, ...(notes.has(i + 1) ? { tailored: notes.get(i + 1) } : {}) })),
    flags: prep?.flags ?? [],
    pushbacks: pushbacks.map((p) => ({ objection: p.objection, answer: mergePrices(p.answer, catalog) })),
  };
}

/** The evidence text of the finding a flag cites, or null when the audit on screen has no such finding (it was re-run since). */
export function evidenceFor(findings: { code: string; evidence: string }[], code: string): string | null {
  return findings.find((f) => f.code === code)?.evidence || null;
}
