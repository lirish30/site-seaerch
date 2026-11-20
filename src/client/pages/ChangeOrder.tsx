import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import Icon from "../components/Icon";
import { canSign, closedMessage, declineError, priceLine, scheduleLine, signError, splitConsent, type PublicChangeOrder } from "../changeOrderPageView";
import { dollars } from "../packagesView";
import { isReportToken } from "../reportView";

type Load = "loading" | "ok" | "gone" | "error";

const REASON_MAX = 300;

/** A page that is only a message: link gone, load failed, order closed. */
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
        <div className="rp-card" role="status" aria-label="Loading change order">
          <span className="rp-sk" style={{ height: 28, width: "70%" }} />
          <span className="rp-sk" style={{ height: 240, borderRadius: 12 }} />
        </div>
      </div>
    </main>
  );
}

/** "Wednesday, December 9, 2026" from a `YYYY-MM-DD` calendar date, or the date as it came when it does not read. */
function longDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="co-section">
      <h2>{title}</h2>
      <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </section>
  );
}

function Signed({ page }: { page: PublicChangeOrder }) {
  const at = page.signed ? new Date(page.signed.signedAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
  return (
    <section className="pp-done" role="status">
      <span className="rp-notice-icon" aria-hidden="true"><Icon name="check" size={20} /></span>
      <div>
        <h2>{page.payment === "paid" ? "Signed and paid" : "Signed"}</h2>
        <p>{page.payment === "paid" ? "Thank you. The payment is in and the work is under way." : "Signed. We'll email the invoice; work starts once it's paid."}</p>
        {page.signed && <p>Signed by {page.signed.signerName}{when ? ` on ${when}` : ""}.</p>}
      </div>
    </section>
  );
}

// Public page: deliberately bypasses api.ts, whose 401 handling redirects to /login. Every string from the server (names, titles, the text of the change) is shown as
// React text, which escapes it; there are no links in it and nothing is rendered as HTML.
export default function ChangeOrder() {
  const rest = useParams()["*"];
  const token = isReportToken(rest) ? rest : undefined;
  const [load, setLoad] = useState<Load>("loading");
  const [page, setPage] = useState<PublicChangeOrder | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [consent, setConsent] = useState(false), [authority, setAuthority] = useState(false), [name, setName] = useState("");
  const [declining, setDeclining] = useState(false), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Your change order";
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
    fetch(`/api/public/c/${token}`, { credentials: "omit" })
      .then(async (res) => {
        if (res.status === 404) { if (!cancelled) setLoad("gone"); return; }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as PublicChangeOrder;
        if (!cancelled) { setPage(data); setLoad("ok"); }
      })
      .catch(() => { if (!cancelled) setLoad("error"); });
    return () => { cancelled = true; };
  }, [token, attempt]);

  const ready = canSign({ name, consent, authority });
  const consentParts = page ? splitConsent(page.consentText) : null;

  async function sign(ev: FormEvent) {
    ev.preventDefault();
    if (busy || !ready.ok || !token || !page || page.state !== "open") return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/public/c/${token}/sign`, {
        method: "POST", credentials: "omit", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, consent, authority, sha256: page.contentSha256 }),
      });
      if (res.ok) { setPage((await res.json()) as PublicChangeOrder); window.scrollTo({ top: 0 }); return; }
      setError(signError(res.status));
      // The order changed under them (or closed): show what is there now, and ask for the consent again.
      if (res.status === 409) { setConsent(false); setAuthority(false); setAttempt((n) => n + 1); }
    } catch { setError(signError(0)); }
    finally { setBusy(false); }
  }

  async function decline(ev: FormEvent) {
    ev.preventDefault();
    if (busy || !token || !page || page.state !== "open") return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/public/c/${token}/decline`, {
        method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }),
      });
      if (res.ok) { setPage((await res.json()) as PublicChangeOrder); window.scrollTo({ top: 0 }); return; }
      setError(declineError(res.status));
      if (res.status === 409) { setDeclining(false); setAttempt((n) => n + 1); }
    } catch { setError(declineError(0)); }
    finally { setBusy(false); }
  }

  if (load === "loading") return <Skeleton />;
  if (load === "error") return (
    <Notice icon="alert" title="Couldn't load this change order">
      <p>Something went wrong on our side, or your connection dropped. Please try again.</p>
      <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
    </Notice>
  );
  if (load === "gone" || !page) return <Notice icon="link" title="This link isn't available"><p>It may have expired or been turned off. Reply to the email you got and we'll sort it out.</p></Notice>;

  if (page.state === "closed") {
    return (
      <Notice icon="link" title={page.closedReason === "declined" ? "You turned this down" : "This change order is closed"}>
        <p>{closedMessage(page.closedReason)}</p>
        <p>{page.reference} for {page.clientName}</p>
      </Notice>
    );
  }

  const signed = page.state === "signed";
  const from = [page.ownerName, page.ownerBusiness].filter(Boolean).join(", ");
  return (
    <main className="rp">
      <div className="rp-wrap co-wrap">
        <header className="rp-bar">
          <span className="rp-bar-name">Change order for {page.clientName}</span>
          {!signed && page.expiresOn && <span className="rp-expiry pp-expiry">Open until {longDate(page.expiresOn)}</span>}
        </header>
        <article className="rp-card">
          {signed && <Signed page={page} />}
          <div className="rp-head">
            <span className="rp-eyebrow">{page.reference}{page.projectName ? ` · ${page.projectName}` : ""}</span>
            <h1>{page.title}</h1>
            {page.contactName && <p className="rp-based">Hi {page.contactName}. This is extra work on your project{from ? `, from ${from}` : ""}. Nothing starts until you sign and the invoice is paid.</p>}
          </div>

          {page.summary && <section className="co-section"><h2>What we'd do</h2><p className="co-text">{page.summary}</p></section>}
          {page.reason && <section className="co-section"><h2>Why</h2><p className="co-text">{page.reason}</p></section>}
          <List title="What you get" items={page.deliverables} />
          <List title="Not included" items={page.notIncluded} />

          <section className="co-price" aria-label="Price">
            <p className="co-price-line">{priceLine(page.hours, page.rateCents, page.priceCents)}</p>
            <p className="co-price-total">{dollars(page.priceCents)}</p>
            <p className="co-price-note">{scheduleLine(page.scheduleImpactDays)}</p>
          </section>

          {!signed && (
            <form className="pp-sign" onSubmit={(e) => void sign(e)}>
              <h2>Sign this change order</h2>
              <div className="pp-disclosure" tabIndex={0} role="region" aria-label="Electronic signature disclosure">
                {consentParts?.disclosure.map((p, i) => <p key={i}>{p}</p>)}
              </div>
              <label className="pp-check"><input type="checkbox" className="cb" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>{consentParts?.consentLabel}</span></label>
              <label className="pp-check"><input type="checkbox" className="cb" checked={authority} onChange={(e) => setAuthority(e.target.checked)} /><span>{consentParts?.authorityLabel}</span></label>
              <label className="bk-field">
                <span>Type your full name to sign</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" />
                <small>Typing your name is your legal signature.</small>
              </label>
              {error && !declining && <p className="error" role="alert">{error}</p>}
              <div className="co-actions">
                <button type="submit" className="btn primary pp-submit" disabled={!ready.ok || busy}>{busy && !declining ? "Signing…" : "Sign"}</button>
                <button type="button" className="btn pp-submit" disabled={busy} onClick={() => { setDeclining(true); setError(""); }}>No thanks</button>
              </div>
              {!ready.ok && <p className="pp-hint">{ready.missing[0]}</p>}
            </form>
          )}

          {!signed && declining && (
            <form className="co-decline" onSubmit={(e) => void decline(e)}>
              <h2>No thanks</h2>
              <p>Nothing will be done and nothing is owed. If you like, tell us why.</p>
              <label className="bk-field">
                <span>Your reason (optional)</span>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON_MAX} rows={3} />
                <small>{reason.length} of {REASON_MAX}</small>
              </label>
              {error && <p className="error" role="alert">{error}</p>}
              <div className="co-actions">
                <button type="submit" className="btn primary pp-submit" disabled={busy}>{busy ? "Sending…" : "Turn it down"}</button>
                <button type="button" className="btn pp-submit" disabled={busy} onClick={() => { setDeclining(false); setError(""); }}>Back</button>
              </div>
            </form>
          )}
        </article>
      </div>
    </main>
  );
}
