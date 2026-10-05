import type { Finding } from "../types";

/** What a finding is matched on across audits: AI findings carry a per-topic `ai_*` code, CRO findings are `cro:<id>`. */
export const findingKey = (f: Finding): string => f.code;

export function diffFindings(prev: Finding[], next: Finding[]): { added: Finding[]; resolved: Finding[]; unchanged: Finding[] } {
  const before = new Set(prev.map(findingKey)), after = new Set(next.map(findingKey));
  return {
    added: next.filter((f) => !before.has(findingKey(f))),
    resolved: prev.filter((f) => !after.has(findingKey(f))),
    unchanged: next.filter((f) => before.has(findingKey(f))),
  };
}
