// The Care site probe. Pure: the fetch function and the clock are injected, so this touches no database and
// no network of its own.
//
// Two promises matter more than the rest:
//  - nothing a client's site sends back is ever returned. `ProbeResult.error` is null when the site is up and
//    otherwise exactly `HTTP <status>` or one value of ERROR_TEXT; no body is read and a thrown error's
//    message is never copied.
//  - a private, loopback, link-local or internal address is never fetched (monitorableUrl).

export const PROBE_TIMEOUT_MS = 10_000;
export const SLOW_MS = 5_000;

export const ERROR_TEXT = {
  timeout: "timed out after 10 seconds",
  connect: "could not connect",
  blocked: "this address can't be monitored",
} as const;

export type MonitorableUrl = { ok: true; url: string } | { ok: false; reason: string };

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error: string | null;
  slow: boolean;
}

const BLOCKED: MonitorableUrl = { ok: false, reason: ERROR_TEXT.blocked };

// Host suffixes that only ever resolve inside someone's network.
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan"];

function blockedIPv4(a: number, b: number): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including cloud metadata at 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 and 192.0.2.0/24
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

// `host` is what new URL() leaves in `hostname` for an IPv6 literal: bracketed and compressed, with an embedded
// IPv4 tail already rewritten to hex ("[::ffff:127.0.0.1]" arrives as "[::ffff:7f00:1]").
function parseIPv6(host: string): number[] | null {
  let s = host.slice(1, -1).toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const o = dotted.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, dotted.index) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function blockedIPv6(host: string): boolean {
  const g = parseIPv6(host);
  if (!g) return true; // can't read it, so don't fetch it
  // The first two octets are all the IPv4 rules need; `hi` is the first 16 bits of the embedded address.
  const v4 = (hi: number) => blockedIPv4(hi >> 8, hi & 0xff);
  // Global unicast (2000::/3) is the only range that reaches the public internet.
  if (g[0] >= 0x2000 && g[0] <= 0x3fff) {
    if (g[0] === 0x2002) return v4(g[1]); // 6to4 embeds an IPv4 address
    if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) return true; // Teredo, documentation
    return false;
  }
  // IPv4-mapped (::ffff:a.b.c.d) takes the IPv4 rules.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6]);
  // NAT64 (64:ff9b::/96) embeds an IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6]);
  // Everything else is unspecified, loopback, unique-local (fc00::/7), link-local (fe80::/10), multicast, etc.
  return true;
}

function blockedHost(hostname: string): boolean {
  if (hostname.startsWith("[")) return blockedIPv6(hostname);
  const host = hostname.replace(/\.+$/, "");
  if (host === "") return true;
  // new URL() has already folded 2130706433, 0x7f.0.0.1, 0177.0.0.1 and 127.1 into dotted form.
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) return blockedIPv4(Number(v4[1]), Number(v4[2]));
  if (!host.includes(".")) return true; // "localhost", "intranet": a bare name only resolves inside a network
  return INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** The URL to probe, or a reason it can't be. A bare "acmeplumbing.com" becomes "https://acmeplumbing.com/". */
export function monitorableUrl(raw: string | null): MonitorableUrl {
  if (raw === null) return BLOCKED;
  const s = raw.trim();
  if (s === "") return BLOCKED;
  // "scheme:" counts as a scheme unless it is "host:port"; everything else is a bare host.
  const candidate = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return BLOCKED;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return BLOCKED;
  // An address with a login in it ("https://user:pass@host/") would send that login with every check and could echo it back: never probed.
  if (u.username !== "" || u.password !== "") return BLOCKED;
  if (blockedHost(u.hostname)) return BLOCKED;
  return { ok: true, url: u.href };
}

/**
 * One GET. Down is any throw, a timeout, a 404, a 410 or a status of 500 and above; 401 and 403 mean the site
 * is answering (it is just not open to us), so they are up. No body is read.
 */
export async function probeSite(url: string, fetchFn: typeof fetch, nowMs: () => number): Promise<ProbeResult> {
  const started = nowMs();
  // An AbortController plus setTimeout rather than AbortSignal.timeout: same effect, but the timer is the
  // ordinary one, so tests can drive it with fake timers.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "SitelineMonitor/1.0" },
    });
    const ms = nowMs() - started;
    const status = res.status;
    try {
      void res.body?.cancel().catch(() => {}); // release the connection without reading anything
    } catch {
      // nothing to release
    }
    const down = status === 404 || status === 410 || status >= 500;
    return {
      ok: !down,
      status,
      ms,
      error: down ? `HTTP ${status}` : null,
      slow: !down && ms > SLOW_MS,
    };
  } catch {
    // The thrown message is never copied: it can carry whatever the remote end or the network said.
    return {
      ok: false,
      status: null,
      ms: nowMs() - started,
      error: controller.signal.aborted ? ERROR_TEXT.timeout : ERROR_TEXT.connect,
      slow: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
