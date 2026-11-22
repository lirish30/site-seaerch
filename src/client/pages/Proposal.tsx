import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import Icon from "../components/Icon";
import { dollars } from "../packagesView";
import { formatExpiry, mailtoOf, payError, safeHttpsUrl, signError, signReady, summaryOf, type ProposalSummary } from "../proposalPageView";
import { isReportToken } from "../reportView";
import type { OpenProposal, PublicPayment, PublicProposal } from "../../worker/documents/public";

type Load = "loading" | "ok" | "gone" | "error";

/** The page's top bar: the sender's mark and name, and on the right the reference and when it expires. */
function Bar({ provider, right }: { provider: string; right?: ReactNode }) {
  return (
    <header className="slx-pp-bar">
      <span className="slx-mark" aria-hidden="true"><i /></span>
      <b>{provider}</b>
      <span className="ds-grow" />
      {right}
    </header>
  );
}

/** A page that is only a message: link gone, load failed, proposal closed. */
function Notice({ icon, title, children }: { icon: "link" | "alert"; title: string; children?: ReactNode }) {
  return (
    <main className="slx-pp">
      <div className="slx-pp-narrow">
        <section className="slx-pp-card slx-pp-notice">
          <span className="slx-pp-tile" aria-hidden="true"><Icon name={icon} size={20} /></span>
          <h1>{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}

function Skeleton() {
  return (
    <main className="slx-pp" aria-busy="true">
      <div className="slx-pp-grid" role="status" aria-label="Loading proposal">
        <div className="slx-pp-col"><span className="slx-pp-sk" style={{ height: 220 }} /><span className="slx-pp-sk" style={{ height: 320 }} /></div>
        <span className="slx-pp-sk" style={{ height: 480 }} />
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
  if (payment.state === "paid") return (
    <section className="slx-pp-paid" aria-label="Deposit">
      <span className="slx-pp-tile ok" aria-hidden="true"><Icon name="check" size={18} /></span>
      <div><b>Deposit received: {dollars(payment.amountCents)}</b><p>Thank you. We will be in touch about the next step.</p></div>
    </section>
  );
  if (payment.state === "unavailable") {
    return (
      <section className="slx-pp-step" aria-label="Deposit">
        <p>We couldn't open the payment page. Try again.</p>
        {error && <p className="slx-pp-error" role="alert">{error}</p>}
        <button type="button" className="btn primary slx-pp-go" disabled={busy} onClick={() => void again()}>{busy ? "Opening…" : "Try again"}</button>
      </section>
    );
  }
  const url = safeHttpsUrl(payment.url);
  return (
    <section className="slx-pp-step" aria-label="Deposit">
      {url
        ? <a className="btn primary slx-pp-go" href={url} target="_blank" rel="noopener noreferrer"><Icon name="card" size={16} />Pay the {dollars(payment.amountCents)} deposit</a>
        : <p>Deposit due: {dollars(payment.amountCents)}. We will email you the payment link.</p>}
      <p className="slx-pp-fine">The payment page opens in a new tab. Pay by card or bank account (ACH); a bank transfer can take a few days to clear.</p>
    </section>
  );
}

const firstName = (s: string | null) => (s ?? "").trim().split(/\s+/)[0] || "there";

// Public page: deliberately bypasses api.ts, whose 401 handling redirects to /login. The proposal itself is HTML from the server, shown only in a sandboxed
// frame (no scripts, no same-origin access); the summary cards are read from that HTML as text, and everything on the page is plain text through React.
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

  const html = page && page.state !== "closed" ? page.html : null;
  const sum = useMemo<ProposalSummary | null>(() => {
    if (!html || typeof DOMParser === "undefined") return null;
    try { return summaryOf(new DOMParser().parseFromString(html, "text/html")); } catch { return null; }
  }, [html]);
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

  return <OpenPage page={page} token={token!} sum={sum} setPage={setPage} sign={(e) => void sign(e)} form={{ name, setName, consent, setConsent, authority, setAuthority, busy, error, reason }} />;
}

function OpenPage({ page, token, sum, setPage, sign, form }: {
  page: OpenProposal; token: string; sum: ProposalSummary | null; setPage: (p: PublicProposal) => void; sign: (e: FormEvent) => void;
  form: { name: string; setName: (s: string) => void; consent: boolean; setConsent: (b: boolean) => void; authority: boolean; setAuthority: (b: boolean) => void; busy: boolean; error: string; reason: string | null };
}) {
  const signed = page.state === "signed";
  const expiry = page.expiresAt ? formatExpiry(page.expiresAt, new Date()) : null;
  const expiryDay = page.expiresAt ? new Date(page.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  const provider = sum?.provider ?? "Your proposal";
  const build = sum?.packages[0];
  const deposit = sum?.payments.find((p) => /signing/i.test(p.due));
  const depositText = sum?.deposit ?? deposit?.amount ?? null;
  const at = page.signed ? new Date(page.signed.at) : null;
  const signedOn = at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
  const [fullOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 760);

  return (
    <main className="slx-pp">
      <Bar provider={provider} right={<>
        {sum?.reference && <span className="slx-pp-ref">Proposal {sum.reference}</span>}
        {!signed && expiry && <span className={`ds-chip ${expiry === "expired" ? "critical" : "warning"}`} title={expiry}>{expiry === "expired" ? "Expired" : `Expires ${expiryDay}`}</span>}
        {signed && <span className="ds-chip positive"><i className="ds-dot" />Signed</span>}
      </>} />
      <div className="slx-pp-grid">
        <div className="slx-pp-col">
          <section className="slx-pp-card slx-pp-intro">
            <p className="slx-pp-eyebrow">Proposal for {page.clientName}</p>
            <h1>{sum?.packages.length ? sum.packages.map((p) => p.name).join(" and ") : "Your proposal"}</h1>
            <p className="slx-pp-lede">
              {signed ? `Thanks${sum?.contactName ? `, ${firstName(sum.contactName)}` : ""}. You signed this proposal${signedOn ? ` on ${signedOn}` : ""}. Everything you agreed to is below.`
                : `Hi ${firstName(sum?.contactName ?? null)}, here is what we agreed. Read it through, then sign and pay the deposit${depositText ? ` of ${depositText}` : ""} to get started.`}
            </p>
            {sum && sum.packages.length > 0 && (
              <p className="slx-pp-chips">{sum.packages.map((p, i) => <span key={p.name} className={`ds-chip ${i === 0 ? "signal" : "neutral"}`}>{p.name}{p.price ? ` · ${p.price}` : ""}</span>)}</p>
            )}
          </section>

          {build && build.includes.length > 0 && (
            <section className="slx-pp-card">
              <h2>What you get</h2>
              <ul className="slx-checks">{build.includes.map((x, i) => <li key={i}><Icon name="check" size={16} />{x}</li>)}</ul>
            </section>
          )}

          {sum && (sum.payments.length > 0 || sum.recurring.length > 0) && (
            <section className="slx-pp-card flush">
              <h2>Timeline and payments</h2>
              <ol className="slx-pp-pay">
                {sum.payments.map((p, i) => (
                  <li key={i} className={i === 0 && !signed ? "now" : ""}>
                    <span className="slx-pp-n">{i + 1}</span>
                    <span className="slx-pp-pay-text"><b>{i === 0 && !signed ? `Today · ${p.label.toLowerCase()}` : p.label}</b><small>{p.due}</small></span>
                    <span className="slx-pp-amt">{p.amount}</span>
                  </li>
                ))}
                {sum.recurring.map((r, i) => (
                  <li key={`r${i}`}>
                    <span className="slx-pp-n">{sum.payments.length + i + 1}</span>
                    <span className="slx-pp-pay-text"><b>{r.name}</b><small>{r.line}</small></span>
                    <span className="slx-pp-amt">{(r.line.match(/^\$[\d,.]+/) ?? [""])[0]}{/^\$/.test(r.line) ? " a month" : ""}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <details className="slx-pp-card flush slx-pp-full" open={fullOpen}>
            <summary><Icon name="file-text" size={16} /><span>The full proposal and terms</span><small>{signed ? "What you signed" : "Read before you sign"}</small><Icon name="chevron-down" size={16} className="slx-pp-chev" /></summary>
            <iframe className="slx-pp-frame" title={`Proposal for ${page.clientName}`} sandbox="" srcDoc={page.html} referrerPolicy="no-referrer" />
          </details>
        </div>

        <aside className="slx-pp-card slx-pp-sign" aria-label={signed ? "Signed" : "Sign and pay"}>
          {signed ? (
            <>
              <h2>You signed this proposal</h2>
              <p className="slx-pp-sub">{page.signed ? `Signed by ${page.signed.name}${signedOn ? ` on ${signedOn}` : ""}.` : "Signed."}</p>
              <a className="btn slx-pp-go" href={`/api/public/p/${token}/pdf`} download><Icon name="file-text" size={16} />Download the signed PDF</a>
              <p className="slx-pp-label">Pay the deposit</p>
              <Payment payment={page.payment} token={token} onChange={(payment) => setPage({ ...page, payment })} />
            </>
          ) : (
            <form onSubmit={sign}>
              <h2>Sign and pay the deposit</h2>
              <p className="slx-pp-sub">Two steps, one page.</p>
              {(build || depositText) && (
                <dl className="slx-pp-sum">
                  {build && <div><dt>{build.name}</dt><dd>{build.price}</dd></div>}
                  {depositText && <div className="due"><dt>Due today</dt><dd>{depositText}</dd></div>}
                </dl>
              )}
              <p className="slx-pp-label">1 · Sign</p>
              <label className="slx-pp-field">
                <span>Type your full name</span>
                <input value={form.name} onChange={(e) => form.setName(e.target.value)} maxLength={120} autoComplete="name" />
                <small>Typing your name is your legal signature.</small>
              </label>
              <label className="slx-pp-check"><input type="checkbox" className="cb" checked={form.consent} onChange={(e) => form.setConsent(e.target.checked)} /><span>{page.consentLabel}</span></label>
              <label className="slx-pp-check"><input type="checkbox" className="cb" checked={form.authority} onChange={(e) => form.setAuthority(e.target.checked)} /><span>{page.authorityLabel}</span></label>
              <details className="slx-pp-terms">
                <summary>Read the e-signature terms</summary>
                <div tabIndex={0} role="region" aria-label="Electronic signature disclosure">{page.disclosure.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
              </details>
              {form.error && <p className="slx-pp-error" role="alert">{form.error}</p>}
              <button type="submit" className="btn primary slx-pp-go" disabled={!!form.reason || form.busy}><Icon name="check" size={16} />{form.busy ? "Signing…" : "Sign the proposal"}</button>
              {form.reason && <p className="slx-pp-fine">{form.reason}</p>}
              <p className="slx-pp-label">2 · Pay</p>
              <p className="slx-pp-sub">Once you have signed, the button to pay {depositText ? `the ${depositText} deposit` : "the deposit"} appears here. You pay by card or bank account (ACH) on Stripe’s secure page.</p>
              <p className="slx-pp-fine">Payments are handled by Stripe. We keep your typed signature, the time and your IP address as a record of signing. A signed PDF is emailed to you.</p>
            </form>
          )}
        </aside>
      </div>
    </main>
  );
}
