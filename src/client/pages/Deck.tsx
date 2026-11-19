import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { priceDrift } from "../dealView";
import type { Package } from "../packagesView";
import { STAGE_LABEL } from "../pipelineView";
import type { Deal } from "../../worker/db/deals";

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The recommendation deck for a deal, full window: Logan presents from it, downloads the PDF, freezes the prices, and marks the deal recommended afterwards. */
export default function DeckPage() {
  const { id = "" } = useParams();
  const [deal, setDeal] = useState<Deal | null>(null);
  const [catalog, setCatalog] = useState<Package[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Bumped to load the deck again after the prices are frozen anew.
  const [version, setVersion] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let live = true;
    setDeal(null); setFailed(false);
    api.get<Deal>(`/deals/${id}`).then((d) => { if (live) setDeal(d); }).catch(() => { if (live) setFailed(true); });
    api.get<Package[]>("/packages").then((c) => { if (live) setCatalog(c); }).catch(() => {});
    return () => { live = false; };
  }, [id]);

  async function run(fn: () => Promise<void>) { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(errorText(e, "Something went wrong")); } finally { setBusy(false); } }
  const freeze = () => run(async () => { setDeal(await api.post<Deal>(`/deals/${id}/deck/freeze`)); setVersion((v) => v + 1); });
  const markRecommended = () => run(async () => { setDeal(await api.post<Deal>(`/deals/${id}/move`, { to: "recommended" })); });
  /** Gives the deck the keyboard, so the arrow keys work without a click first. */
  const focusDeck = () => { try { frame.current?.contentWindow?.focus(); } catch { /* the deck still works with a click */ } };

  if (failed) return <div className="deck-page"><p className="error" role="alert">Couldn’t load this deal. <Link to="/pipeline">Back to the pipeline</Link></p></div>;
  if (!deal) return <div className="deck-page"><p className="muted">Loading…</p></div>;
  if (!deal.recap || !deal.options) {
    return <div className="deck-page"><p className="muted">Draft the recap first: the deck is built from it. <Link to={`/deals/${id}`}>Back to the deal</Link></p></div>;
  }

  const drift = priceDrift(deal, catalog);
  const closed = deal.stage === "won" || deal.stage === "lost";
  const canMark = !closed && ["booked", "discovery_done", "recommendation_booked"].includes(deal.stage);
  return (
    <div className="deck-page">
      <header className="deck-bar">
        <Link to={`/deals/${id}`}>Back to the deal</Link>
        <span className="muted small">{STAGE_LABEL[deal.stage]}</span>
        <span className="muted small">{deal.deckFrozenAt ? `Prices frozen ${when(deal.deckFrozenAt)}` : "Draft: the prices freeze when you open it"}</span>
        <span className="deck-spacer" />
        <a className="btn" href={`/api/deals/${id}/deck.pdf`} download>Download PDF</a>
        <button type="button" className="btn" disabled={busy || closed} onClick={freeze}>Freeze prices</button>
        {canMark && <button type="button" className="btn" disabled={busy} onClick={markRecommended}>Mark recommended</button>}
      </header>
      {error && <p className="warn small" role="alert">{error}</p>}
      {drift.length > 0 && (
        <div className="warn small" role="status">
          <p>The catalog has changed since the prices were frozen. The deck still shows the frozen prices; “Freeze prices” updates them.</p>
          <ul>{drift.map((d) => <li key={d}>{d}</li>)}</ul>
        </div>
      )}
      <iframe ref={frame} key={version} className="deck-frame" title="Recommendation deck" src={`/api/deals/${id}/deck.html`} sandbox="allow-scripts" onLoad={focusDeck} />
      <p className="muted small">Arrow keys or click to move. Press N for your speaker notes.</p>
    </div>
  );
}
