import { useEffect, useMemo, useState } from "react";
import { Banner, Chip } from "../../components/ds";
import Icon from "../../components/Icon";
import SettingsPage, { Card, Field } from "../../components/SettingsPage";
import { SwitchRow } from "../../components/StepFields";
import { api } from "../../api";
import { CLAUSE_LIBRARY_VERSION, clausesFor } from "../../../worker/documents/clauses";
import { PACKAGE_KEYS } from "../../../worker/db/packages";
import { DEFAULT_DOCUMENTS_CONFIG, legalGate, type DocumentsConfig } from "../../../worker/documents/config";
import type { Package } from "../../packagesView";
import { billingProblem, documentsProblem, readDocumentsDraft, type BillingConfig } from "../../settingsPagesView";
import { useSettingsDoc } from "../../settingsData";

/** Settings > Documents: the lawyer-review record, the late fee, how long a proposal stays open, and every clause as the app writes it. */
export default function Documents() {
  const doc = useSettingsDoc();
  const cfg = readDocumentsDraft(doc.value("documents_config"));
  const update = (patch: Partial<DocumentsConfig>) => doc.set("documents_config", JSON.stringify({ ...cfg, ...patch }));
  const problem = documentsProblem(cfg);
  const gate = legalGate(cfg);
  const reviewed = cfg.legalReviewedAt !== null;
  const [packages, setPackages] = useState<Package[] | null>(null);
  useEffect(() => { api.get<Package[]>("/packages").then(setPackages).catch(() => setPackages([])); }, []);
  const [billing, setBilling] = useState<BillingConfig | null | false>(null);
  useEffect(() => { api.get<BillingConfig>("/documents/config").then(setBilling).catch(() => setBilling(false)); }, []);
  const billingIssue = billing ? billingProblem(billing) : null;
  const hourly = packages?.find((p) => p.key === "hourly");
  const provider = doc.value("business_name").trim() || doc.value("your_name").trim() || "the provider";
  // Every optional clause shows here (all packages, Care declined), so the reviewer reads the whole library once.
  const clauses = useMemo(() => clausesFor({
    providerName: provider, clientName: "the client", keys: [...PACKAGE_KEYS], careDeclined: true,
    hourlyCents: hourly?.priceCents ?? 0, hourlyCareCents: hourly?.altPriceCents ?? null, config: { ...DEFAULT_DOCUMENTS_CONFIG, ...cfg },
  }), [provider, hourly, cfg.lateFeePercentMonthly]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (key: "lateFeePercentMonthly" | "expiryDays") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Number(e.target.value);
    if (e.target.value.trim() !== "" && Number.isFinite(n)) update({ [key]: key === "expiryDays" ? Math.round(n) : n });
  };

  return (
    <SettingsPage title="Documents" width={760} doc={doc} sub="The clauses in every proposal and SOW, and what has to be true before one goes to a client."
      badge={doc.loaded ? (gate ? <Chip tone="warning" dot>Not lawyer-reviewed</Chip> : <Chip tone="positive" dot>Lawyer-reviewed</Chip>) : undefined}>
      <div className="bx sox">
        {gate && <Banner tone="warning" title="Proposals can only be test sends for now">{gate}</Banner>}
        <Card title="Legal review" sub="Every clause below needs an Oregon lawyer's review before first use. Until it is recorded here, a proposal can only be a test send.">
          <SwitchRow checked={reviewed} label="Reviewed by an Oregon lawyer" help={reviewed ? "Proposals and SOWs can go to real clients." : "Switch this on once a lawyer has read the clause library below."}
            onChange={(on) => update(on ? { legalReviewedAt: new Date().toISOString() } : { legalReviewedAt: null, legalReviewer: "" })} />
          {reviewed && (
            <div className="sox-grid">
              <Field label="Reviewed by" htmlFor="dc-reviewer" help="The lawyer or firm, up to 120 characters." error={problem === "Name who reviewed the clauses" ? problem : undefined}>
                <input id="dc-reviewer" value={cfg.legalReviewer} maxLength={120} aria-invalid={!cfg.legalReviewer.trim()} onChange={(e) => update({ legalReviewer: e.target.value })} />
              </Field>
              <Field label="Review date" htmlFor="dc-date" help={`Clause library version ${CLAUSE_LIBRARY_VERSION}.`}>
                <input id="dc-date" className="sox-w" type="date" value={cfg.legalReviewedAt!.slice(0, 10)}
                  onChange={(e) => { if (e.target.value) update({ legalReviewedAt: `${e.target.value}T00:00:00.000Z` }); }} />
              </Field>
            </div>
          )}
        </Card>

        <section className="st-card">
          <header><div><h2>Payments</h2><p>Deposits are invoiced through Stripe. The keys are Worker secrets: this page shows only whether they are set.</p></div></header>
          <div className="st-card-body flush">
            {billing === null && <p className="sox-row sox-sub">Checking…</p>}
            {billing === false && <p className="sox-row bx-err" role="alert">Couldn’t read the Stripe status. Reload the page to try again.</p>}
            {billing && (
              <ul className="sox-list">
                <li className="sox-row">
                  <span className={`sox-tile ${billing.stripeMode === "live" ? "warning" : billing.stripeMode ? "positive" : "warning"}`}><Icon name="card" size={16} /></span>
                  <div className="sox-main"><b>Stripe</b><small>{billing.stripeMode === "live" ? "Live mode: a deposit invoice charges a real client." : billing.stripeMode ? "Test mode: invoices use Stripe's test cards." : "No Stripe key is set, so deposits can't be invoiced."}</small></div>
                  <Chip tone={billing.stripeMode === "live" ? "warning" : billing.stripeMode ? "info" : "outline"} dot>{billing.stripeMode ? `${billing.stripeMode === "live" ? "Live" : "Test"} mode` : "Not set up"}</Chip>
                </li>
                <li className="sox-row">
                  <span className={`sox-tile ${billing.webhookConfigured ? "positive" : "warning"}`}><Icon name={billing.webhookConfigured ? "check" : "alert"} size={16} /></span>
                  <div className="sox-main"><b>Webhook secret</b><small>Lets the app see when a deposit is paid.</small></div>
                  <Chip tone={billing.webhookConfigured ? "positive" : "warning"} dot>{billing.webhookConfigured ? "Set" : "Not set"}</Chip>
                </li>
                <li className="sox-row">
                  <span className={`sox-tile ${billing.clientBase ? "positive" : "warning"}`}><Icon name="link" size={16} /></span>
                  <div className="sox-main"><b>Client links</b><small>{billing.clientBase ? <>Proposals open on <span className="sox-mono">{billing.clientBase}</span></> : "Off: clients can't open a proposal link yet."}</small></div>
                  <Chip tone={billing.clientBase ? "positive" : "warning"} dot>{billing.clientBase ? "On" : "Off"}</Chip>
                </li>
              </ul>
            )}
          </div>
          {billingIssue && <div className="sox-card-foot"><Icon name="info" size={14} /><span className="sox-sub" style={{ color: "var(--text-2)", fontSize: 13 }}>{billingIssue}</span></div>}
        </section>

        <Card title="Terms" sub="Written into every new proposal.">
          <div className="sox-grid">
            <Field label="Late fee (% per month)" htmlFor="dc-late" help="0 to 10. Written into the late fee clause." error={problem?.startsWith("The late fee") ? problem : undefined}>
              <input id="dc-late" className="sox-w" type="number" min={0} max={10} step={0.1} value={cfg.lateFeePercentMonthly} onChange={num("lateFeePercentMonthly")} />
            </Field>
            <Field label="Proposal stays open (days)" htmlFor="dc-expiry" help="7 to 90. After this a sent proposal expires." error={problem?.startsWith("A proposal") ? problem : undefined}>
              <input id="dc-expiry" className="sox-w" type="number" min={7} max={90} value={cfg.expiryDays} onChange={num("expiryDays")} />
            </Field>
          </div>
        </Card>

        <section className="st-card">
          <header>
            <div><h2>Clause library</h2><p>The exact wording the app puts in a document, shown for a client with every optional package. Hand this page to your lawyer.</p></div>
            <Chip tone="outline">{clauses.length} clauses · v{CLAUSE_LIBRARY_VERSION}</Chip>
          </header>
          <ol className="sox-clauses">
            {clauses.map((c) => <li key={c.id}><div><b>{c.title}</b><p>{c.text}</p></div></li>)}
          </ol>
        </section>
      </div>
    </SettingsPage>
  );
}
