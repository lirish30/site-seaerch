import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import Icon from "../components/Icon";
import { PubBar, PubError, PubGone, PubNotice, PubSkeleton, Tile, useNoIndex } from "../components/PublicPage";
import { canSign, closedMessage, declineError, priceLine, scheduleLine, signError, splitConsent, type PublicChangeOrder } from "../changeOrderPageView";
import { dollars } from "../packagesView";
import { isReportToken } from "../reportView";

type Load = "loading" | "ok" | "gone" | "error";

const REASON_MAX = 300;
const KIND = "Change order";

/** "Wednesday, December 9, 2026" from a `YYYY-MM-DD` calendar date, or the date as it came when it does not read. */
function longDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}
/** "Dec 9" for the chip in the bar. */
function shortDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function List({ title, items, crosses = false }: { title: string; items: string[]; crosses?: boolean }) {
  if (items.length === 0) return null;
  return (
    <section className="pbx-card tight">
      <h2>{title}</h2>
      <ul className={crosses ? "pbx-crosses" : "pbx-checks"}>{items.map((t, i) => <li key={i}><Icon name={crosses ? "x" : "check"} size={16} />{t}</li>)}</ul>
    </section>
  );
}

function Signed({ page }: { page: PublicChangeOrder }) {
  const at = page.signed ? new Date(page.signed.signedAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
  const paid = page.payment === "paid";
  return (
    <aside className="pbx-card pbx-sign pbx-side" aria-label="Signed" role="status">
      <h2>{paid ? "Signed and paid" : "Signed"}</h2>
      <div className="pbx-done">
        <Tile icon="check" size={32} />
        <div>
          <b>{page.signed ? `Signed by ${page.signed.signerName}` : "Signed"}</b>
          <p>{when ? `On ${when}.` : ""}</p>
        </div>
      </div>
      <dl className="pbx-sum">
        <div className="due"><dt>{paid ? "Paid" : "To pay"}</dt><dd>{dollars(page.priceCents)}</dd></div>
      </dl>
      <ol className="pbx-steps">
        <li><Tile icon="check" tone="positive" size={28} />You signed</li>
        <li><Tile icon={paid ? "check" : "mail"} tone={paid ? "positive" : "warning"} size={28} />{paid ? "Payment received" : "We email you the invoice"}</li>
        <li><Tile icon={paid ? "zap" : "clock"} tone={paid ? "signal" : "neutral"} size={28} />{paid ? "The work is under way" : "Work starts once it's paid"}</li>
      </ol>
      <p className="pbx-fine">{paid ? "Thank you. The payment is in." : "Nothing else to do here until the invoice arrives."}</p>
    </aside>
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
  useNoIndex("Your change order");

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

  if (load === "loading") return <PubSkeleton kind={KIND} label="Loading change order" two />;
  if (load === "error") return <PubError kind={KIND} what="this change order" onRetry={() => setAttempt((n) => n + 1)} />;
  if (load === "gone" || !page) return <PubGone kind={KIND} />;

  if (page.state === "closed") {
    const declined = page.closedReason === "declined";
    return (
      <PubNotice kind={page.ownerBusiness || KIND} icon={declined ? "check" : "link"} tone={declined ? "neutral" : "warning"} title={declined ? "You turned this down" : "This change order is closed"}>
        <p>{closedMessage(page.closedReason)}</p>
        <p className="pbx-fine">{page.reference} for {page.clientName}</p>
      </PubNotice>
    );
  }

  const signed = page.state === "signed";
  const from = [page.ownerName, page.ownerBusiness].filter(Boolean).join(", ");
  return (
    <main className="ds-page pbx">
      <PubBar name={page.ownerBusiness || KIND} right={<>
        <span className="pbx-bar-meta mono hide-sm">{page.reference}</span>
        {!signed && page.expiresOn && <span className="ds-chip warning" title={`Open until ${longDate(page.expiresOn)}`}>Open until {shortDate(page.expiresOn)}</span>}
        {signed && <span className="ds-chip positive"><i className="ds-dot" />{page.payment === "paid" ? "Signed and paid" : "Signed"}</span>}
      </>} />
      <div className="pbx-grid">
        <div className="pbx-col">
          <article className="pbx-card pbx-intro">
            <p className="pbx-eyebrow">Change order for {page.clientName}</p>
            <h1>{page.title}</h1>
            {page.contactName && <p className="pbx-lede">Hi {page.contactName}. This is extra work on your project{from ? `, from ${from}` : ""}. Nothing starts until you sign and the invoice is paid.</p>}
            <p className="pbx-chips">
              {page.projectName && <span className="ds-chip neutral"><Icon name="briefcase" size={12} />{page.projectName}</span>}
              <span className="ds-chip signal">{dollars(page.priceCents)}</span>
              <span className="ds-chip outline">{page.scheduleImpactDays ? `+${page.scheduleImpactDays} ${page.scheduleImpactDays === 1 ? "day" : "days"}` : "No delay"}</span>
            </p>
          </article>

          {(page.summary || page.reason) && (
            <section className="pbx-card tight">
              {page.summary && <><h2>What we'd do</h2><p className="pbx-text">{page.summary}</p></>}
              {page.reason && <><h2 style={{ marginTop: page.summary ? 6 : 0 }}>Why</h2><p className="pbx-text">{page.reason}</p></>}
            </section>
          )}
          <List title="What you get" items={page.deliverables} />
          <List title="Not included" items={page.notIncluded} crosses />

          <section className="pbx-card tight" aria-label="Price">
            <h2>Price</h2>
            <div className="pbx-price">
              <span className="pbx-price-total">{dollars(page.priceCents)}</span>
              <span className="pbx-price-line">{priceLine(page.hours, page.rateCents, page.priceCents)}</span>
            </div>
            <p className="pbx-impact"><Icon name="clock" size={16} />{scheduleLine(page.scheduleImpactDays)}</p>
          </section>
        </div>

        {signed ? <Signed page={page} /> : (
          <aside className="pbx-card pbx-sign pbx-side" aria-label={declining ? "No thanks" : "Sign"}>
            {!declining ? (
              <form onSubmit={(e) => void sign(e)}>
                <h2>Sign this change order</h2>
                <p className="pbx-sub" style={{ marginTop: -6 }}>Sign here, then we email you the invoice.</p>
                <dl className="pbx-sum">
                  <div><dt>{page.hours} {page.hours === 1 ? "hour" : "hours"} of work</dt><dd>{dollars(page.priceCents)}</dd></div>
                  <div className="due"><dt>Total</dt><dd>{dollars(page.priceCents)}</dd></div>
                </dl>
                <label className="deal-field">
                  <span>Type your full name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" />
                  <small>Typing your name is your legal signature.</small>
                </label>
                <details className="pbx-terms">
                  <summary>Read the e-signature terms</summary>
                  <div tabIndex={0} role="region" aria-label="Electronic signature disclosure">{consentParts?.disclosure.map((p, i) => <p key={i}>{p}</p>)}</div>
                </details>
                <label className="ds-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>{consentParts?.consentLabel}</span></label>
                <label className="ds-check"><input type="checkbox" checked={authority} onChange={(e) => setAuthority(e.target.checked)} /><span>{consentParts?.authorityLabel}</span></label>
                {error && <p className="pbx-error" role="alert">{error}</p>}
                <button type="submit" className="btn primary pbx-go" disabled={!ready.ok || busy}><Icon name="check" size={16} />{busy ? "Signing…" : "Sign the change order"}</button>
                {!ready.ok && <p className="pbx-fine">{ready.missing[0]}</p>}
                <p className="pbx-fine">Questions first? Reply to the email this came with.</p>
                <p className="pbx-fine">Don't want this? <button type="button" className="pbx-linkbtn" disabled={busy} onClick={() => { setDeclining(true); setError(""); }}>No thanks</button></p>
              </form>
            ) : (
              <form onSubmit={(e) => void decline(e)}>
                <h2>No thanks</h2>
                <p className="pbx-sub">Nothing will be done and nothing is owed. If you like, tell us why.</p>
                <label className="deal-field">
                  <span>Your reason (optional)</span>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON_MAX} rows={3} />
                  <small>{reason.length} of {REASON_MAX}</small>
                </label>
                {error && <p className="pbx-error" role="alert">{error}</p>}
                <div className="pbx-actions">
                  <button type="submit" className="btn primary" disabled={busy}>{busy ? "Sending…" : "Turn it down"}</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => { setDeclining(false); setError(""); }}>Back</button>
                </div>
              </form>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}
