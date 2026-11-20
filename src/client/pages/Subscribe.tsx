import { useCallback, useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import Icon from "../components/Icon";
import { publicSubscription, startSubscriptionCheckout } from "../api";
import { isReportToken } from "../reportView";
import { CONFIRMING, STILL_PROCESSING, checkoutError, isCheckoutUrl, localDay, pollDelay, settled, subscribeCopy, type PublicSubscription } from "../subscribeView";

type Load = "loading" | "ok" | "gone" | "error";

/** A page that is only a message: link gone, load failed. */
function Notice({ icon, title, children }: { icon: "link" | "alert" | "check"; title: string; children?: React.ReactNode }) {
  return (
    <main className="rp sb">
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
    <main className="rp sb" aria-busy="true">
      <div className="rp-wrap rp-wrap-narrow">
        <div className="rp-card" role="status" aria-label="Loading">
          <span className="rp-sk" style={{ height: 28, width: "70%" }} />
          <span className="rp-sk" style={{ height: 160, borderRadius: 12 }} />
        </div>
      </div>
    </main>
  );
}

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

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Your monthly payment";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    if (!meta) { meta = document.createElement("meta"); meta.name = "robots"; document.head.appendChild(meta); }
    const prevContent = meta.content;
    meta.content = "noindex, nofollow";
    return () => { document.title = prevTitle; if (created) meta.remove(); else meta.content = prevContent; };
  }, []);

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

  if (load === "loading") return <Skeleton />;
  if (load === "error") return (
    <Notice icon="alert" title="Couldn't load this page">
      <p>Something went wrong on our side, or your connection dropped. Please try again.</p>
      <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
    </Notice>
  );
  if (load === "gone" || !page) return <Notice icon="link" title="This link isn't available"><p>It may have expired or been turned off. Reply to the email you got and we'll sort it out.</p></Notice>;

  const copy = subscribeCopy(page, localDay(new Date()));
  const polling = waiting && pollDelay(tries) !== null;
  const stalled = waiting && !polling;

  if (page.state === "closed") return <Notice icon="link" title={copy.heading}><p>{copy.note}</p></Notice>;

  return (
    <main className="rp sb">
      <div className="rp-wrap rp-wrap-narrow">
        <header className="rp-bar"><span className="rp-bar-name">For {page.clientName}</span></header>
        <article className="rp-card">
          {page.state === "active" && (
            <section className="pp-done" role="status">
              <span className="rp-notice-icon" aria-hidden="true"><Icon name="check" size={20} /></span>
              <div><h1>{copy.heading}</h1></div>
            </section>
          )}
          {page.state === "ready" && <div className="rp-head"><h1>{copy.heading}</h1></div>}

          <ul className="sb-lines">{copy.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>

          {polling && <p className="sb-wait" role="status">{CONFIRMING}</p>}
          {stalled && (
            <div className="sb-wait" role="status">
              <p>{STILL_PROCESSING}</p>
              <div className="co-actions"><button type="button" className="btn pp-submit" onClick={() => setTries(0)}>Check again</button></div>
            </div>
          )}

          {copy.button && !waiting && (
            <div className="co-actions">
              <button type="button" className="btn primary pp-submit" disabled={busy} onClick={() => void start()}>{busy ? "Opening…" : copy.button}</button>
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <p className="sb-note">{copy.note}</p>
        </article>
      </div>
    </main>
  );
}
