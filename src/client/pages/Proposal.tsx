import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import Icon from "../components/Icon";
import { dollars } from "../packagesView";
import { formatExpiry, mailtoOf, payError, safeHttpsUrl, signError, signReady } from "../proposalPageView";
import { isReportToken } from "../reportView";
import type { OpenProposal, PublicPayment, PublicProposal } from "../../worker/documents/public";

type Load = "loading" | "ok" | "gone" | "error";

/** A page that is only a message: link gone, load failed, proposal closed. */
function Notice({ icon, title, children }: { icon: "link" | "alert"; title: string; children?: React.ReactNode }) {
  return (
    <main className="rp">
      <div className="rp-wrap rp-wrap-narrow">
        <section className="rp-card rp-notice">
          <span className="rp-notice-icon" aria-hidden="true"><Icon name={icon} size={20} /></span>
          <h1>{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}

function Skeleton() {
  return (
    <main className="rp" aria-busy="true">
      <div className="rp-wrap">
        <div className="rp-card" role="status" aria-label="Loading proposal">
          <span className="rp-sk" style={{ height: 28, width: "70%" }} />
          <span className="rp-sk" style={{ height: 320, borderRadius: 12 }} />
        </div>
      </div>
    </main>
  );
}

/**
 * Where the deposit stands after signing. The server decides the state; the link is only shown when it is https. When the payment page could not be made,
 * the button asks the server for it again (the same call the owner's retry makes) and shows whatever it answers.
 */
function Payment({ payment, token, onChange }: { payment: PublicPayment; token: string; onChange: (p: PublicPayment) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function again() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/public/p/${token}/pay`, { method: "POST", credentials: "omit" });
      if (!res.ok) { setError(payError(res.status)); return; }
      const next = (await res.json()) as PublicPayment;
      onChange(next);
      if (next.state === "unavailable") setError(payError(200));
    } catch { setError(payError(0)); }
    finally { setBusy(false); }
  }

  if (payment.state === "none") return null;
  if (payment.state === "paid") return <section className="pp-pay" aria-label="Deposit"><p className="pp-pay-title">Deposit received: {dollars(payment.amountCents)}</p><p>Thank you. We will be in touch about the next step.</p></section>;
  if (payment.state === "unavailable") {
    return (
      <section className="pp-pay" aria-label="Deposit">
        <p className="pp-pay-title">We couldn't open the payment page. Try again.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="button" className="btn primary" disabled={busy} onClick={() => void again()}>{busy ? "Opening…" : "Try again"}</button>
      </section>
    );
  }
  const url = safeHttpsUrl(payment.url);
  return (
    <section className="pp-pay" aria-label="Deposit">
      <p className="pp-pay-title">Deposit due: {dollars(payment.amountCents)}</p>
      {url
        ? <a className="btn primary" href={url} target="_blank" rel="noopener noreferrer">Pay deposit</a>
        : <p>We will email you the payment link.</p>}
      <p>The payment page opens in a new tab. A bank transfer (ACH) can take a few days to clear.</p>
    </section>
  );
}

function Signed({ page, token }: { page: OpenProposal; token: string }) {
  const at = page.signed ? new Date(page.signed.at) : null;
  const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
  return (
    <section className="pp-done" role="status">
      <span className="rp-notice-icon" aria-hidden="true"><Icon name="check" size={20} /></span>
      <div>
        <h2>You signed this proposal</h2>
        <p>{page.signed ? `Signed by ${page.signed.name}${when ? ` on ${when}` : ""}.` : "Signed."} The signed document is below.</p>
        <p><a href={`/api/public/p/${token}/pdf`} download>Download the signed PDF</a></p>
      </div>
    </section>
  );
}

// Public page: deliberately bypasses api.ts, whose 401 handling redirects to /login. The proposal itself is HTML from the server, shown only in a sandboxed
// frame (no scripts, no same-origin access); everything else on the page is plain text through React, which escapes it.
export default function Proposal() {
  const rest = useParams()["*"];
  const token = isReportToken(rest) ? rest : undefined;
  const [load, setLoad] = useState<Load>("loading");
  const [page, setPage] = useState<PublicProposal | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [consent, setConsent] = useState(false), [authority, setAuthority] = useState(false), [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Your proposal";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    if (!meta) { meta = document.createElement("meta"); meta.name = "robots"; document.head.appendChild(meta); }
    const prevContent = meta.content;
    meta.content = "noindex, nofollow";
    return () => { document.title = prevTitle; if (created) meta.remove(); else meta.content = prevContent; };
  }, []);

  useEffect(() => {
    if (!token) { setLoad("gone"); return; }
    let cancelled = false;
    setLoad("loading");
    fetch(`/api/public/p/${token}`, { credentials: "omit" })
      .then(async (res) => {
        if (res.status === 404) { if (!cancelled) setLoad("gone"); return; }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as PublicProposal;
        if (!cancelled) { setPage(data); setLoad("ok"); }
      })
      .catch(() => { if (!cancelled) setLoad("error"); });
    return () => { cancelled = true; };
  }, [token, attempt]);

  const reason = signReady({ name, consent, authority });

  async function sign(ev: FormEvent) {
    ev.preventDefault();
    if (busy || reason || !token || !page || page.state !== "open") return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/public/p/${token}/sign`, {
        method: "POST", credentials: "omit", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, consent, authority, sha256: page.contentSha256 }),
      });
      if (res.ok) { setPage((await res.json()) as PublicProposal); window.scrollTo({ top: 0 }); return; }
      setError(signError(res.status));
      // The document changed under them (or closed): show what is there now, and ask for the consent again.
      if (res.status === 409) { setConsent(false); setAuthority(false); setAttempt((n) => n + 1); }
    } catch { setError(signError(0)); }
    finally { setBusy(false); }
  }

  if (load === "loading") return <Skeleton />;
  if (load === "error") return (
    <Notice icon="alert" title="Couldn't load this proposal">
      <p>Something went wrong on our side, or your connection dropped. Please try again.</p>
      <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
    </Notice>
  );
  if (load === "gone" || !page) return <Notice icon="link" title="This link isn't available"><p>It may have expired or been turned off. Reply to the email you got and we'll sort it out.</p></Notice>;

  if (page.state === "closed") {
    const mail = mailtoOf(page.contactEmail);
    return (
      <Notice icon="link" title="This proposal is no longer open">
        <p>The link for {page.clientName} has expired or been withdrawn, so it can't be read or signed any more. Please contact the sender for a new one.</p>
        {mail && <a className="btn primary" href={mail}><Icon name="mail" size={16} />Email {page.contactEmail}</a>}
      </Notice>
    );
  }

  const signed = page.state === "signed";
  return (
    <main className="rp">
      <div className="rp-wrap pp-wrap">
        <header className="rp-bar">
          <span className="rp-bar-name">Proposal for {page.clientName}</span>
          {!signed && page.expiresAt && <span className="rp-expiry pp-expiry">{formatExpiry(page.expiresAt, new Date())}</span>}
        </header>
        <article className="rp-card">
          {signed && token && <Signed page={page} token={token} />}
          {signed && token && <Payment payment={page.payment} token={token} onChange={(payment) => setPage({ ...page, payment })} />}
          <iframe className="pp-frame" title={`Proposal for ${page.clientName}`} sandbox="" srcDoc={page.html} referrerPolicy="no-referrer" />
          {!signed && (
            <form className="pp-sign" onSubmit={(e) => void sign(e)}>
              <h2>Sign this proposal</h2>
              <div className="pp-disclosure" tabIndex={0} role="region" aria-label="Electronic signature disclosure">
                {page.disclosure.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
              </div>
              <label className="pp-check"><input type="checkbox" className="cb" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>{page.consentLabel}</span></label>
              <label className="pp-check"><input type="checkbox" className="cb" checked={authority} onChange={(e) => setAuthority(e.target.checked)} /><span>{page.authorityLabel}</span></label>
              <label className="bk-field">
                <span>Type your full name to sign</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" />
                <small>Typing your name is your legal signature.</small>
              </label>
              {error && <p className="error" role="alert">{error}</p>}
              <button type="submit" className="btn primary pp-submit" disabled={!!reason || busy}>{busy ? "Signing…" : "Sign proposal"}</button>
              {reason && <p className="pp-hint">{reason}</p>}
            </form>
          )}
        </article>
      </div>
    </main>
  );
}
