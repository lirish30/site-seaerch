export type ImportUrl = { ok: true; url: string; host: string } | { ok: false; error: string };

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
// "mailto:x", "javascript:x", "data:x": a scheme with no "//". "acme.com:8080" is a host and port, so a colon followed by digits is not one.
const OPAQUE_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i;
const INTERNAL_HOST = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/i;

const fail = (error: string): ImportUrl => ({ ok: false, error });

/**
 * Decides whether a typed website can be stored and later fetched by the crawler. Pure. Accepts http(s) only (a bare
 * "acme.com" becomes https://acme.com) and a public-looking host: no IP literals, no localhost or internal suffixes,
 * no dotless names, no user:password@, no explicit port. Returns the address with a lowercase scheme and the host without "www.".
 */
export function importUrl(raw: string): ImportUrl {
  const s = raw.trim();
  if (!s) return fail("Enter a web address such as acme.com.");
  if (/\s/.test(s)) return fail("The website has spaces in it, so it is not a web address.");
  const scheme = SCHEME.exec(s)?.[1].toLowerCase();
  if (scheme ? scheme !== "http" && scheme !== "https" : OPAQUE_SCHEME.test(s)) return fail("Only http:// and https:// websites can be imported.");
  const url = scheme ? s.replace(SCHEME, `${scheme}://`) : `https://${s}`;
  let u: URL;
  try { u = new URL(url); } catch { return fail("The website does not look like a web address."); }
  if (u.username || u.password) return fail("Remove the username and password from the website address.");
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") || /^\d+(\.\d+)*$/.test(host) || /\.\d+$/.test(host)) return fail("An IP address is not a business website. Use the site's domain name.");
  if (INTERNAL_HOST.test(host)) return fail("That is a local or internal address, not a public website.");
  if (!host.includes(".")) return fail("The website does not look like a web address (a domain such as acme.com has a dot).");
  if (u.port) return fail("Leave the port off the website address: a business website does not need one.");
  return { ok: true, url, host: host.replace(/^www\./, "") };
}

/** The friendly reason `importUrl` rejects a website, or null when it is fine. */
export const importUrlProblem = (raw: string): string | null => {
  const r = importUrl(raw);
  return r.ok ? null : r.error;
};
