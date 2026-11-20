import { ACCESS_KEYS, type AccessItem, type AccessKey, type AccessStatus, type Site } from "../db/sites";
import { cleanText, looksLikeCredential } from "../onboarding/templates";

const VAULT = "Name the password manager item, never the login.";

/** What each checklist line is called and what to record on it. A vault name is the NAME of a password-manager item, never a secret. */
export const ACCESS_LABELS: Record<AccessKey, { label: string; help: string }> = {
  hosting: { label: "Hosting", help: `Where the site is hosted: the host, the plan and who owns the account. ${VAULT}` },
  dns: { label: "DNS", help: `Where the DNS records are managed: the provider and who owns the account. ${VAULT}` },
  registrar: { label: "Registrar", help: `Where the domain is registered and who owns it. ${VAULT}` },
  admin: { label: "Site admin", help: `The site's admin login: which user to use and how you get in. ${VAULT}` },
  gbp: { label: "Google Business Profile", help: `Whether you are a manager on the client's profile and who is the owner. ${VAULT}` },
  analytics: { label: "Analytics", help: `Which analytics and search console properties you can reach, and how. ${VAULT}` },
};

const LOGIN_SENTENCE = "That looks like a login or a key. Type only the name of the password manager item.";
const LINK_SENTENCE = "A password manager item name is a name, not a link.";
const NAME_MAX = 80;
const NOTE_MAX = 500;

/** Shapes that are secrets whatever the spacing: "password: ..." (also pw, passwd, = or a fullwidth colon), a link with a login in it, cloud, payment, GitHub, Slack, OpenAI-style and Google keys, JWTs, private keys, long hex strings. */
function looksSecret(s: string): boolean {
  return looksLikeCredential(s)
    || /\b(?:pw|passwd|pwd|pass(?:word|code|phrase)?|login|api[ _-]?key|secret|token)\s*[:=\uFF1A\uFF1D]/i.test(s)
    || /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@/i.test(s)
    || /-----BEGIN/i.test(s)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(s)
    || /\b(?:sk|pk|rk)_(?:live|test)_/i.test(s)
    || /\beyJ[\w-]{5,}\.[\w-]{5,}\./.test(s)
    || /\bgh[pous]_[A-Za-z0-9]{20,}/.test(s)
    || /\bxox[abprs]-[A-Za-z0-9-]{8,}/.test(s)
    || /\bsk-[\w-]{20,}/.test(s)
    || /\bAIza[\w-]{30,}/.test(s)
    || /\b[0-9a-f]{32,}\b/i.test(s);
}

/** One word with no spaces, long, and mixing at least three kinds of character: a password or a token, not a name. */
function looksLikeSingleToken(s: string): boolean {
  if (/\s/.test(s) || s.length < 16) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
  return kinds >= 3;
}

/** Null when the name is fine (empty is fine: it clears the field); otherwise a plain sentence that never repeats the input. */
export function vaultNameProblem(raw: string): string | null {
  const s = cleanText(raw, raw.length);
  if (!s) return null;
  if (s.length > NAME_MAX) return `A password manager item name is ${NAME_MAX} characters or fewer.`;
  if (looksSecret(s) || looksLikeSingleToken(s)) return LOGIN_SENTENCE;
  if (/:\/\/|^www\./i.test(s)) return LINK_SENTENCE;
  return null;
}

/** The same secret checks for a free-text note, without the single-token rule. A plain link is fine in a note. */
export function noteProblem(raw: string): string | null {
  const s = cleanText(raw, raw.length);
  if (!s) return null;
  if (s.length > NOTE_MAX) return `A note is ${NOTE_MAX} characters or fewer.`;
  if (looksSecret(s)) return "That looks like a login or a key. Describe the access in words and leave the secret out.";
  return null;
}

/** The cleaned vault name to store, or null when it is empty. Check `vaultNameProblem` first. */
export function cleanVaultName(raw: string): string | null {
  return cleanText(raw, NAME_MAX) || null;
}

/** Items that are not yet received, verified or not applicable. */
export const unresolved = <T extends { status: AccessStatus }>(items: T[]): T[] =>
  items.filter((i) => i.status !== "received" && i.status !== "verified" && i.status !== "not_applicable");

/** True for an absolute http or https URL and nothing else (no javascript:, data:, ftp:). */
export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export type SiteFlag = { code: "access_missing" | "client_hosted_no_access"; text: string };

export function siteFlags(o: { site: Site; items: AccessItem[]; careActive: boolean }): SiteFlag[] {
  if (o.site.archivedAt) return [];
  const flags: SiteFlag[] = [];
  const missing = new Set(unresolved(o.items).map((i) => i.key));
  const labels = ACCESS_KEYS.filter((k) => missing.has(k)).map((k) => ACCESS_LABELS[k].label);
  if (labels.length) flags.push({ code: "access_missing", text: `Still missing: ${labels.join(", ")}.` });
  if (o.careActive && o.site.hostingTier === "client_hosted" && (o.site.accessMethod === "none" || o.site.accessMethod === "unknown")) {
    flags.push({
      code: "client_hosted_no_access",
      text: "Care on a client-hosted site needs SSH with WP-CLI or a MainWP connection. Ask for access, or recommend moving the site to your hosting.",
    });
  }
  return flags;
}
