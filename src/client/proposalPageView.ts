/** Pure helpers for the client's proposal page (`/p/<token>`). The worker uses `nameProblem` too, so the page and the server agree on what a name is. */

export const NAME_MIN = 2;
export const NAME_MAX = 120;

/**
 * Characters a typed signature may not hold: control characters (including the C1 range), line and paragraph separators, the bidi marks, embeddings,
 * overrides and isolates (which can make a name read as another), and zero-width spaces. The joiners U+200C and U+200D stay: some scripts need them.
 */
const UNSAFE = /[\p{Cc}\u2028\u2029\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

/** Why a typed name cannot be a signature, or null when it can. Judged on the trimmed name; length is in characters. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  const length = [...n].length;
  if (length < NAME_MIN) return "Type your full name to sign.";
  if (length > NAME_MAX) return "That name is too long.";
  if (UNSAFE.test(n)) return "Your name has hidden or control characters. Retype it with plain letters.";
  if (!/\p{L}/u.test(n)) return "Your name needs at least one letter.";
  return null;
}

/** The reason the Sign button is disabled, in the order the page asks for things, or null when the form is complete. */
export function signReady(f: { name: string; consent: boolean; authority: boolean }): string | null {
  if (!f.consent) return "Tick the box to agree to sign electronically.";
  if (!f.authority) return "Confirm you can sign for the business.";
  return nameProblem(f.name);
}

const DAY = 86_400_000;

/** "expires in 12 days", "expires in 1 day", "expires today" (less than a day left) or "expired" (the instant itself counts: signing is refused from then). */
export function formatExpiry(iso: string, now: Date): string {
  const left = Date.parse(iso) - now.getTime();
  if (!(left > 0)) return "expired";
  const days = Math.floor(left / DAY);
  if (days < 1) return "expires today";
  return `expires in ${days} ${days === 1 ? "day" : "days"}`;
}

/** What the page says when a sign attempt fails. Nothing the server sent is shown. */
export function signError(status: number): string {
  switch (status) {
    case 400: return "Check your name and both boxes, then try again.";
    case 404: return "This link is no longer available.";
    case 409: return "This proposal changed or is no longer open. We have reloaded it: read it again before you sign.";
    case 413: return "That name is too long. Check it and try again.";
    case 429: return "Too many tries. Wait a minute and try again.";
    case 0: return "We could not reach the server. Check your connection and try again.";
    default: return "Something went wrong on our side. Please try again.";
  }
}

/** The address when it is an https link, otherwise null: a payment link from the server is never put in an href unchecked. */
export function safeHttpsUrl(u: string): string | null {
  if (!u.startsWith("https://")) return null;
  try { return new URL(u).protocol === "https:" ? u : null; } catch { return null; }
}

/** A `mailto:` link for a plain address, or null (no spaces, brackets, quotes or query: nothing that adds a header or a recipient). */
export const mailtoOf = (email: string): string | null => (/^[^\s<>"'?&,;:@]+@[^\s<>"'?&,;:@]+\.[^\s<>"'?&,;:@]+$/.test(email) ? `mailto:${email}` : null);
