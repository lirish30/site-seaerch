import { useState } from "react";
import { api } from "../../api";
import Icon from "../../components/Icon";
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
    <section aria-label="Client link" className="slx-link-panel">
      {link ? (
        <>
          <div className="slx-copy-row">
            <input readOnly aria-label="Client link" value={link} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn sm" onClick={() => copy(link)}><Icon name={copied ? "check" : "copy"} size={14} />{copied ? "Copied" : "Copy"}</button>
          </div>
          <p className="slx-hint">Only you see this. The client opens their page from it, so send it only to them.</p>
          <div className="slx-actions">
            <button type="button" className="btn sm" onClick={fresh}><Icon name="refresh" size={14} />New link</button>
            <button type="button" className="btn sm" onClick={revoke}><Icon name="ban" size={14} />Turn link off</button>
          </div>
        </>
      ) : o.revokedAt ? (
        <div className="slx-actions">
          <span className="slx-error">The link is turned off: the client’s page does not open.</span>
          <button type="button" className="btn sm" onClick={fresh}>Make a new link</button>
        </div>
      ) : <p className="slx-error">Set CLIENT_LINK_BASE (an https address for client links) to get the client’s link.</p>}
      {copyFailed && <p className="slx-error" role="alert">Could not copy: select the link and copy it by hand.</p>}
      <div className="slx-link-close">
        {o.closedAt ? <p className="slx-hint">Closed {when(o.closedAt)}. The client’s page is read-only.</p> : (
          <><span className="slx-hint">Done collecting? Closing makes their page read-only.</span><button type="button" className="btn sm" onClick={close}>Close the onboarding</button></>
        )}
      </div>
    </section>
  );
}
