// The refusals every Claude kind that writes words a person will read shares (the Local SEO report's and the Studio's): Claude's words are shown to a client or posted for a business, so a result that fails any of
// these is refused (`TaskRefused`) and the task stays claimed. They live here so both kinds are held to the same rules.
import { z } from "zod";

/** No address, no email, no dollar amount and no markdown (two or more of a markdown character in a row). */
export const REFUSED = /https?:\/\/|www\.|@|\$\s?\d|[`#*_]{2}/i;
export const BLANK_LINES = /(?:\r?\n){3,}/;
/** Markdown that survives the two-character check: a link `[x](y)` and a line that starts as a heading or a bullet. */
export const MARKDOWN = /\]\(|^\s*(#|[-*]\s)/m;
/** Nothing that sounds like a promise about a ranking or a result, or a boast that cannot be checked ("best in", "first page", "#1"). */
export const PROMISE = /guarantee|promise|#1|number one|best in\b|first page|top spot|will rank|will (?:improve|increase|rise|climb|grow|get)/i;

/** A trimmed, non-empty string of at most `max` characters that passes every refusal above. */
export const words = (max: number) => z.string().trim().min(1).max(max)
  .refine((s) => !REFUSED.test(s) && !MARKDOWN.test(s), "must not contain a link, an email address, a price or markdown")
  .refine((s) => !BLANK_LINES.test(s), "must not contain a run of blank lines")
  .refine((s) => !PROMISE.test(s), "must not promise a ranking or a result");
