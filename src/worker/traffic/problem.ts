import { GoogleApiError } from "../google/api";
import { GoogleNotConnected } from "../google/access";

/** A call that ran out of time (`timedFetch`'s abort): Google did not answer, which is not a dead connection. */
export const isTimeout = (e: unknown): boolean => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

const DISABLED_REASON = /^(SERVICE_DISABLED|accessNotConfigured|API_NOT_ENABLED|API_DISABLED|SERVICE_NOT_ENABLED)$/;
const API_NAME = { search: "Google Search Console API", analytics: "Google Analytics Data and Admin APIs", profile: "Google My Business API", both: "Google Search Console API and the Google Analytics Data and Admin APIs" } as const;

/** One plain sentence for why a pull failed, for the client page and the log. It never repeats what Google said: error bodies can carry a site's address or an account name. `which` names the source (Search Console, Analytics or Business Profile: a disabled API names the one to turn on); `"profile"` also words a 403 for Business Profile, whose 403 means Google has not approved the API access (or the location is not one the account manages). */
export function trafficProblem(e: unknown, o: { email: string | null; which?: "search" | "analytics" | "profile" }): string {
  if (e instanceof GoogleNotConnected) return "Google isn't connected. Connect it in Settings.";
  if (isTimeout(e)) return "Google did not answer. It will be tried again tomorrow.";
  const who = o.email ?? "the connected Google account";
  if (e instanceof GoogleApiError) {
    if (e.status === 403 && e.reason && DISABLED_REASON.test(e.reason)) return `Turn on the ${API_NAME[o.which ?? "both"]} for your Google Cloud project, then try again.`;
    if (o.which === "profile" && e.status === 403) return "Google has not given this account Business Profile API access yet, or this location is not one it manages.";
    if (e.status === 403) return `Google says ${who} can't read this one. Ask the client to add ${who} as a viewer, then it will be tried again tomorrow.`;
    if (e.status === 401) return "Google no longer accepts the connection. Reconnect Google in Settings.";
    if (e.status === 429 || e.status >= 500) return "Google did not answer. It will be tried again tomorrow.";
    return o.which === "profile"
      ? `Google refused the Business Profile request (${e.status}). Check the location id in the client's settings.`
      : `Google refused the request (${e.status}). Check the linked site or property in the client's settings.`;
  }
  // A refresh token Google no longer honours (revoked, expired): the same fix as a 401.
  if (e instanceof Error && e.message.startsWith("Google token error")) return "Google no longer accepts the connection. Reconnect Google in Settings.";
  return "Google could not be read. It will be tried again tomorrow.";
}
