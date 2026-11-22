import { GoogleApiError } from "../google/api";
import { GoogleNotConnected } from "../google/access";

/** One plain sentence for why a pull failed, for the client page and the log. It never repeats what Google said: error bodies can carry a site's address or an account name. */
export function trafficProblem(e: unknown, o: { email: string | null }): string {
  if (e instanceof GoogleNotConnected) return "Google isn't connected. Connect it in Settings.";
  const who = o.email ?? "the connected Google account";
  if (e instanceof GoogleApiError) {
    if (e.status === 403) return `Google says ${who} can't read this one. Ask the client to add ${who} as a viewer, then it will be tried again tomorrow.`;
    if (e.status === 401) return "Google no longer accepts the connection. Reconnect Google in Settings.";
    if (e.status === 429 || e.status >= 500) return "Google did not answer. It will be tried again tomorrow.";
    return `Google refused the request (${e.status}). Check the linked site or property in the client's settings.`;
  }
  // A refresh token Google no longer honours (revoked, expired): the same fix as a 401.
  if (e instanceof Error && e.message.startsWith("Google token error")) return "Google no longer accepts the connection. Reconnect Google in Settings.";
  return "Google could not be read. It will be tried again tomorrow.";
}
