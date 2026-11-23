import { useCallback, useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import Icon from "../components/Icon";
import { PubBar, PubContact, PubError, PubGone, PubNotice, PubSkeleton, Tile, useNoIndex } from "../components/PublicPage";
import { publicSubscription, startSubscriptionCheckout } from "../api";
import { dollars } from "../packagesView";
import { isReportToken } from "../reportView";
import { CONFIRMING, STILL_PROCESSING, checkoutError, isCheckoutUrl, pollDelay, settled, subscribeCopy, subscribeSteps, type PublicSubscription } from "../subscribeView";

type Load = "loading" | "ok" | "gone" | "error";

const KIND = "Monthly payment";

// Public page: no session and no Shell, and it shows only the public fields the server returns (as React text, which escapes it). The state always comes from the server: `?done=1` only
// means "we were sent back from the payment page", so it makes the page re-read the state a few times and never says "paid" by itself.
export default function Subscribe() {
  const rest = useParams()["*"];
  const token = isReportToken(rest) ? rest : undefined;
  const back = new URLSearchParams(useLocation().search).get("done") === "1";
  const [load, setLoad] = useState<Load>("loading");
  const [page, setPage] = useState<PublicSubscription | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useNoIndex("Your monthly payment");

  // Coming back with the browser's Back button from the payment page can restore this page as it was left, "busy" and all.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) { setBusy(false); setAttempt((n) => n + 1); } };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  useEffect(() => {
    if (!token) { setLoad("gone"); return; }
    let cancelled = false;
    setLoad((l) => (l === "ok" ? l : "loading"));
    void publicSubscription(token).then((r) => {
      if (cancelled) return;
      if (r.status === 404) setLoad("gone");
      else if (r.page) { setPage(r.page); setLoad("ok"); }
      else setLoad("error");
    });
    return () => { cancelled = true; };
  }, [token, attempt]);

  // Back from the payment page and the server still says `ready`: the webhook may land a moment later, so ask again a few times, then stop.
  const waiting = back && load === "ok" && page !== null && !settled(page.state);
  useEffect(() => {
    if (!waiting || !token) return;
    const delay = pollDelay(tries);
    if (delay === null) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void publicSubscription(token).then((r) => {
        if (cancelled) return;
        if (r.status === 404) setLoad("gone");
        else if (r.page) setPage(r.page); // a dropped connection is not an answer: keep what is shown and try again
        setTries((n) => n + 1);
      });
    }, delay);
    return () => { cancelled = true; clearTimeout(t); };
  }, [waiting, token, tries]);

  const start = useCallback(async () => {
    if (busy || !token) return;
    setBusy(true); setError("");
    const r = await startSubscriptionCheckout(token);
    if (isCheckoutUrl(r.url)) { window.location.assign(r.url); return; } // stays busy: the browser is leaving
    setBusy(false);
    setError(checkoutError(r.status));
    // Closed, or active in the meantime: show what the server says now.
    if (r.status === 404 || r.status === 409) setAttempt((n) => n + 1);
  }, [busy, token]);

  if (load === "loading") return <PubSkeleton kind={KIND} label="Loading" />;
  if (load === "error") return <PubError kind={KIND} what="this page" onRetry={() => setAttempt((n) => n + 1)} />;
  if (load === "gone" || !page) return <PubGone kind={KIND} />;

  const copy = subscribeCopy(page);
  const polling = waiting && pollDelay(tries) !== null;
  const stalled = waiting && !polling;

  if (page.state === "closed") return <PubNotice kind={KIND} icon="link" title={copy.heading}><p>{copy.note}</p></PubNotice>;

  const active = page.state === "active";
  const steps = subscribeSteps(page);
  return (
    <main className="ds-page pbx">
      <PubBar name={KIND} right={<>
        {page.clientName && <span className="pbx-bar-meta hide-sm">For {page.clientName}</span>}
        {active && <span className="ds-chip positive"><i className="ds-dot" />Active</span>}
      </>} />
      <div className="pbx-narrow" style={{ paddingTop: 40 }}>
        <div className="pbx-col">
          <article className="pbx-card">
            {active ? (
              <div className="pbx-done"><Tile icon="check" size={32} /><div><b>{copy.heading}</b><p>Your monthly payment is set up. There is nothing more to do.</p></div></div>
            ) : (
              <div className="pbx-intro pbx-col" style={{ gap: 8 }}>
                <p className="pbx-eyebrow">{page.clientName ? `For ${page.clientName}` : "Monthly payment"}</p>
                <h1 style={{ fontSize: 26, lineHeight: "32px" }}>{copy.heading}</h1>
                <p className="pbx-lede">One step: add a card or bank account on our payment processor's page, then you're done.</p>
              </div>
            )}

            <div className="pbx-plan">
              <Tile icon="shield" tone="signal" size={40} />
              <div><b>{page.planName}</b><small>Paid monthly</small></div>
              <span className="pbx-plan-price">{dollars(page.monthlyCents)}<small>a month</small></span>
            </div>

            <ul className="pbx-steps">
              {steps.rows.map((r) => <li key={r.text}><Tile icon={r.icon} tone={r.tone} size={28} />{r.text}</li>)}
            </ul>

            {polling && <div className="pbx-wait" role="status"><Icon name="refresh" size={16} /><div><p>{CONFIRMING}</p></div></div>}
            {stalled && (
              <div className="pbx-wait" role="status">
                <Icon name="clock" size={16} />
                <div><p>{STILL_PROCESSING}</p><button type="button" className="btn sm" onClick={() => setTries(0)}>Check again</button></div>
              </div>
            )}

            {copy.button && !waiting && (
              <button type="button" className="btn primary pbx-go" disabled={busy} onClick={() => void start()}><Icon name="card" size={16} />{busy ? "Opening…" : copy.button}</button>
            )}
            {error && <p className="pbx-error" role="alert">{error}</p>}
            <p className="pbx-note"><Icon name="shield" size={14} /><span>{copy.note}</span></p>
          </article>
          <PubContact />
        </div>
      </div>
    </main>
  );
}
