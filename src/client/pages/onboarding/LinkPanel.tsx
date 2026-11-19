import { useState } from "react";
import { api } from "../../api";
import type { OwnerOnboarding } from "../../../worker/onboarding/owner";
import { when, type Act } from "./shared";

/** The client's link (shown to you only), and turning it off, making a new one, and closing the onboarding. */
export default function LinkPanel({ o, link, act }: { o: OwnerOnboarding; link: string | null; act: Act }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(true); setCopyFailed(false); setTimeout(() => setCopied(false), 2000); } catch { setCopyFailed(true); }
  }
  const revoke = () => { if (window.confirm("Turn the client's link off? Their page stops opening until you make a new link. If the welcome email has not been approved yet, approving it will fail until you make a new link.")) return act(() => api.post(`/onboardings/${o.id}/link/revoke`), "The link is off."); };
  const fresh = () => { if (window.confirm("Make a new link? The old one stops working for good, so send the new one to the client.")) return act(() => api.post(`/onboardings/${o.id}/link/new`), "New link made."); };
  const close = () => { if (window.confirm("Close this onboarding? The client's page becomes read-only and they can send nothing more.")) return act(() => api.post(`/onboardings/${o.id}/close`), "Closed."); };

  return (
    <section aria-label="Client link">
      <h3>The client's link</h3>
      {link ? (
        <div className="cp-actions">
          <input readOnly aria-label="Client link" className="proposal-link" value={link} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn-ghost-sm" onClick={() => copy(link)}>{copied ? "Copied" : "Copy link"}</button>
          <button type="button" className="btn-ghost-sm" onClick={revoke}>Turn link off</button>
          <button type="button" className="btn-ghost-sm" onClick={fresh}>New link</button>
        </div>
      ) : o.revokedAt ? (
        <div className="cp-actions">
          <span className="warn small">The link is turned off: the client's page does not open.</span>
          <button type="button" className="btn-ghost-sm" onClick={fresh}>Make a new link</button>
        </div>
      ) : <p className="warn small">Set CLIENT_LINK_BASE (an https address for client links) to get the client's link.</p>}
      {copyFailed && <p className="warn small" role="alert">Could not copy: select the link and copy it by hand.</p>}
      {o.closedAt ? <p className="muted small">Closed {when(o.closedAt)}. The client's page is read-only.</p> : (
        <div className="cp-actions"><button type="button" className="btn-ghost-sm" onClick={close}>Close the onboarding</button></div>
      )}
    </section>
  );
}
