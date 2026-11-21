import { isHttpUrl } from "./access";

/** Schemes with no `//` that are never a website, however they are typed. */
const NOT_WEB = /^(?:javascript|data|vbscript|file|blob|about|mailto|tel|sms):/i;

/**
 * A lead's website as a site record may keep it, or null. One shared rule for what the seed stores:
 * - a bare domain (`acme.com`) gets `https://`, as the client's own links do (`safeHttpUrl`);
 * - a login is dropped whether it has a scheme (`https://user:pw@host`) or not (`user:pw@host`, which `new URL` would read as the scheme `user:`);
 * - a query string and a fragment are dropped (a `?token=` is never stored), and so is a lone `/` path;
 * - anything that is not http or https, or has no dotted host, or cannot be read, is null.
 * The result carries no input a caller could echo from a failure: it never throws.
 */
export function normaliseSiteAddress(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let candidate: string;
  if (/^https?:\/\//i.test(s)) candidate = s;
  else if (s.includes("://") || NOT_WEB.test(s)) return null;
  else {
    const cut = s.search(/[/?#]/);
    const authority = cut === -1 ? s : s.slice(0, cut);
    const rest = cut === -1 ? "" : s.slice(cut);
    candidate = `https://${authority.slice(authority.lastIndexOf("@") + 1).replace(/^\/+/, "")}${rest}`;
  }
  try {
    const u = new URL(candidate);
    if (!isHttpUrl(u.href) || !u.hostname.includes(".")) return null;
    u.username = ""; u.password = ""; u.search = ""; u.hash = "";
    const out = u.href;
    return u.pathname === "/" ? out.slice(0, -1) : out;
  } catch { return null; }
}
