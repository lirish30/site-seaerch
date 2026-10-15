import type { Ats } from "../types";
import { TOKEN_RE } from "./ats";

export interface BoardRef { ats: Ats; token: string }

const T = "([A-Za-z0-9][A-Za-z0-9._-]*)";
// Most specific first. The host is anchored at a dot or a scheme/quote so "notjobs.lever.co.evil.example" is not a Lever board.
const PATTERNS: [Ats, RegExp][] = [
  ["greenhouse", new RegExp(`(?:^|[/."'(\\s])boards-api\\.greenhouse\\.io/v1/boards/${T}`, "i")],
  ["greenhouse", new RegExp(`(?:^|[/."'(\\s])boards\\.greenhouse\\.io/embed/job_board(?:/js)?\\?[^"'\\s<>]*?\\bfor=${T}`, "i")],
  ["greenhouse", new RegExp(`(?:^|[/"'(\\s])(?:job-)?boards\\.greenhouse\\.io/(?!embed\\b)${T}`, "i")],
  ["lever", new RegExp(`(?:^|[/"'(\\s])jobs\\.lever\\.co/${T}`, "i")],
  ["ashby", new RegExp(`(?:^|[/"'(\\s])jobs\\.ashbyhq\\.com/${T}`, "i")],
];

/** The first supported job board named in a URL or a page of HTML, or null. Tokens are checked, so a hostile page cannot name a path. */
export function detectBoard(text: string): BoardRef | null {
  for (const [ats, re] of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    // A sentence-ending dot or dash is not part of the name. Greenhouse and Lever names are lowercase; Ashby's are case-sensitive.
    const raw = m[1].replace(/[._-]+$/, "");
    const token = ats === "ashby" ? raw : raw.toLowerCase();
    if (TOKEN_RE.test(token)) return { ats, token };
  }
  return null;
}
