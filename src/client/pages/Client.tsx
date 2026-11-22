import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, clientsApi } from "../api";
import { useOwnerClock } from "../billingData";
import { addressProblem, carePastDue, latestOnly, moneyLabel, problemText, renewalLabel, safeHref } from "../clientView";
import ActivityTab from "../components/ActivityTab";
import Icon from "../components/Icon";
import MeetingsPanel from "../components/MeetingsPanel";
import CarePanel from "../components/client/CarePanel";
import GradePanel, { GradeChip } from "../components/client/GradePanel";
import ClientSeoPanel from "../components/client/ClientSeoPanel";
import LadderPanel from "../components/client/LadderPanel";
import LinkedPanel from "../components/client/LinkedPanel";
import SitePanel from "../components/client/SitePanel";
import StrategyMemoSection from "../components/client/StrategyMemoSection";
import TrafficPanel from "../components/client/TrafficPanel";
import { hasSeoOnboarding, hasSeoPlan } from "../seoView";
import { workError } from "../workData";
import type { ClientRecord } from "../../worker/clients/record";

/** A link only when the address is a plain http or https one; anything else is shown as text. */
function WebLink({ url }: { url: string | null }) {
  const href = safeHref(url);
  if (!url) return null;
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{url.replace(/^https?:\/\//i, "").replace(/\/$/, "")}</a> : <span>{url}</span>;
}

/** A form to add a site by hand. The address is optional: a site with no domain yet is fine. */
function AddSite({ clientId, onAdded }: { clientId: string; onAdded: () => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const v = url.trim();
    const problem = addressProblem(v);
    if (problem) { setError(problem); return; }
    setBusy(true); setError("");
    try { await clientsApi.addSite(clientId, v ? { url: v } : {}); setUrl(""); await onAdded(); }
    catch (err) { setError(err instanceof ApiError ? problemText(err, "Could not add the site.") : "Could not add the site."); }
    finally { setBusy(false); }
  }
  return (
    <form className="cl-add" onSubmit={(e) => void add(e)} noValidate aria-label="Add a site">
      <label className="deal-field" htmlFor="cl-add-url"><span>Add a site</span>
        <input id="cl-add-url" type="text" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="https://example.com (optional)" aria-label="Add a site: address of the new site"
          value={url} onChange={(e) => { setUrl(e.target.value); setError(""); }} />
      </label>
      <button type="submit" className="btn" disabled={busy}>{busy ? "Adding…" : "Add site"}</button>
      {error && <p className="error small cl-add-msg" role="alert">{error}</p>}
    </form>
  );
}

/**
 * One client: a header strip (name, Care label, MRR, hold, renewal), then About and the sites with their access checklists, the timeline, and everything linked. The vault item names and owner notes
 * on this page are for you alone; the timeline only ever says which line changed.
 */
export default function ClientPage() {
  const { id = "" } = useParams();
  const { today, tz } = useOwnerClock();
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [failed, setFailed] = useState<"" | "missing" | "error">("");
  const [userName, setUserName] = useState("");
  const [error, setError] = useState("");
  // The component is reused when the route changes from one client to another, so an answer is applied only while it is the latest ask for the client in the address bar.
  const [guard] = useState(latestOnly);

  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const next = await clientsApi.get(id);
      if (!guard.isLatest(ticket) || next.business.id !== id) return;
      setClient(next); setFailed("");
    } catch (e) {
      if (!guard.isLatest(ticket)) return;
      setFailed(e instanceof ApiError && e.status === 404 ? "missing" : "error");
    }
  }, [id, guard]);
  useEffect(() => { setClient(null); setFailed(""); setError(""); void load(); return () => guard.cancel(); }, [load, guard]);
  useEffect(() => { api.get<{ settings: { your_name?: string } }>("/settings").then((r) => setUserName(r.settings.your_name ?? "")).catch(() => {}); }, []);

  if (failed === "missing") return <div className="cl"><p className="error cl-body" role="alert">That client was not found. It may still be a lead. <Link to="/clients">Back to clients</Link></p></div>;
  if (failed === "error" && !client) return <div className="cl"><p className="error cl-body" role="alert">Couldn’t load this client. <button type="button" className="btn" onClick={() => void load()}>Try again</button> <Link to="/clients">Back to clients</Link></p></div>;
  if (!client || client.business.id !== id) return <div className="cl"><p className="muted cl-body">Loading…</p></div>;

  const { business: b } = client;
  const late = carePastDue(client.subscriptions);
  const people = [...client.people].sort((x, y) => Number(y.is_poc) - Number(x.is_poc));
  const refresh = async () => { await load(); };

  return (
    <div className="cl">
      <header className="page-header">
        <div>
          <p><Link to="/clients">Clients</Link></p>
          <h1>{b.name}</h1>
        </div>
        <div className="header-actions">
          <Link to={`/leads/${encodeURIComponent(b.id)}`} className="btn">Lead record</Link>
          <Link to={`/billing?businessId=${encodeURIComponent(b.id)}`} className="btn">Billing</Link>
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>

      <div className="cl-body">
        <div className="cl-strip" role="group" aria-label={`${b.name}: summary`}>
          <div className="cl-chip">
            <span className="cl-chip-label">Care</span>
            <span className="cl-chip-value">
              {client.careLabel ?? <span className="muted">No Care plan</span>}
              {late && <span className="badge2 warning"><i className="dot" />Payment late</span>}
            </span>
          </div>
          <div className="cl-chip"><span className="cl-chip-label">Grade</span><span className="cl-chip-value"><GradeChip grade={client.grade} /></span></div>
          <div className="cl-chip"><span className="cl-chip-label">MRR</span><span className="cl-chip-value">{moneyLabel(client.mrrCents, { monthly: true })}</span></div>
          {client.held && (
            <div className="cl-chip"><span className="cl-chip-label">Billing</span><span className="cl-chip-value"><span className="badge2 warning"><i className="dot" />On hold</span></span></div>
          )}
          <div className="cl-chip"><span className="cl-chip-label">Renewal</span><span className="cl-chip-value">{renewalLabel(client.nextRenewalOn, today)}</span></div>
        </div>
        {failed === "error" && <p className="error small" role="alert">Couldn’t refresh just now. What you see may be out of date. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p>}
        {error && <p className="error" role="alert">{error}</p>}

        <div className="cl-cols">
          <div className="cl-col">
            <section className="cl-card" aria-label="About">
              <h2>About</h2>
              {people.length === 0 && <p className="muted small">No people saved. Add a point of contact on the lead record.</p>}
              <ul className="cl-people">
                {people.map((p) => (
                  <li key={p.id}>
                    <b>{p.name}</b>{p.is_poc && <span className="badge2 outline">Point of contact</span>}
                    {p.role && <span className="muted small">{p.role}</span>}
                    <span className="cl-people-meta small">
                      {p.phone && <a href={`tel:${p.phone}`}>{p.phone}</a>}
                      {p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}
                    </span>
                  </li>
                ))}
              </ul>
              <dl className="co-facts">
                {b.website_url && <><dt>Website</dt><dd><WebLink url={b.website_url} /></dd></>}
                {b.phone && <><dt>Phone</dt><dd><a href={`tel:${b.phone}`}>{b.phone}</a></dd></>}
                {b.address && <><dt>Address</dt><dd>{b.address}</dd></>}
              </dl>
              {b.notes && <><p className="wk-sub">Notes</p><p className="wk-text">{b.notes}</p></>}
            </section>

            <section className="cl-sites" aria-label="Sites">
              <h2>Sites ({client.sites.length})</h2>
              {client.sites.length === 0 && <p className="muted small">No site yet. Add one below; it comes with the six access lines.</p>}
              {client.sites.map(({ site, access, flags }) => (
                <SitePanel key={site.id} clientId={b.id} site={site} access={access} flags={flags} onChanged={refresh} />
              ))}
              <AddSite clientId={b.id} onAdded={refresh} />
            </section>
          </div>

          <div className="cl-col">
            <GradePanel businessId={b.id} grade={client.grade} onChanged={refresh} />
            <CarePanel businessId={b.id} health={client.health} sites={client.sites.map(({ site, monitoring }) => ({ site, monitoring }))} zone={tz} onChanged={refresh} />
            <LadderPanel businessId={b.id} today={today} />
            <MeetingsPanel businessId={b.id} />
            <section className="cl-card" aria-label="Timeline">
              <h2>Timeline</h2>
              <ActivityTab items={client.activity} userName={userName} followUp={b.follow_up_at}
                onSetFollowUp={async (day) => { try { await api.patch(`/leads/${encodeURIComponent(b.id)}`, { followUpAt: day }); await load(); return true; } catch (e) { setError(workError(e)); return false; } }}
                onAddNote={async (text) => { try { await api.post(`/leads/${encodeURIComponent(b.id)}/notes`, { text }); await load(); return true; } catch (e) { setError(workError(e)); return false; } }} />
            </section>
          </div>

          <div className="cl-col">
            <LinkedPanel client={client} today={today} />
          </div>
        </div>
        {client.sites.length > 0 && (
          <TrafficPanel businessId={b.id} clientName={b.name} today={today} access={Object.fromEntries(client.sites.map(({ site, access }) => [site.id, access.map((a) => ({ key: a.key, status: a.status }))]))} />
        )}
        <StrategyMemoSection businessId={b.id} tz={tz} />
        <ClientSeoPanel businessId={b.id} clientName={b.name} clientAddress={b.address ?? ""} hasPlan={hasSeoPlan(client.subscriptions) || hasSeoOnboarding(client.projects)}
          sites={client.sites.flatMap(({ site, monitoring }) => (monitoring.domain ? [{ id: site.id, domain: monitoring.domain }] : []))} />
      </div>
    </div>
  );
}
