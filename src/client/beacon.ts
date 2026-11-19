export interface WatchEvent { type: "open" | "play" | "progress" | "end"; pct?: number }

const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** A random id for this page load: 22 characters of random URL-safe text. It is kept in this module only, never in storage or a cookie. */
function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return Array.from(bytes, (b) => URL_SAFE[b % 64]).join("");
}
const session = newSessionId();

/**
 * Tells the server what the viewer did with the video. Fire and forget: it never throws and never shows anything. `sendBeacon` queues the request
 * even while the page is closing; where it is missing or refuses, a keepalive fetch does the same. `sendBeacon` sends the site's own cookies (it cannot leave
 * them off), and the server relies on that: a request that carries the owner's session cookie is the owner testing their link, and is not counted. The fetch
 * fallback omits cookies, so there the owner is counted: a rare, harmless miss.
 */
export function sendEvent(token: string, e: WatchEvent): void {
  try {
    const url = `/api/public/report/${encodeURIComponent(token)}/events`;
    const body = JSON.stringify({ session, ...e });
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) return;
    void fetch(url, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true, credentials: "omit" }).catch(() => {});
  } catch { /* nothing to do: a lost beacon is only a missed count */ }
}
