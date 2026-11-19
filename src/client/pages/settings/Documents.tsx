import { useEffect, useMemo, useState } from "react";
import SettingsPage, { Callout, Card, Field, Row } from "../../components/SettingsPage";
import { api } from "../../api";
import { CLAUSE_LIBRARY_VERSION, clausesFor } from "../../../worker/documents/clauses";
import { PACKAGE_KEYS } from "../../../worker/db/packages";
import { DEFAULT_DOCUMENTS_CONFIG, legalGate, type DocumentsConfig } from "../../../worker/documents/config";
import type { Package } from "../../packagesView";
import { billingLine, billingProblem, documentsProblem, readDocumentsDraft, type BillingConfig } from "../../settingsPagesView";
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
  const [billing, setBilling] = useState<BillingConfig | null>(null);
  useEffect(() => { api.get<BillingConfig>("/documents/config").then(setBilling).catch(() => setBilling(null)); }, []);
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
    <SettingsPage title="Documents" width={760} doc={doc} sub="The clauses in every proposal and SOW, and what has to be true before one goes to a client.">
      <div className="bx">
        {gate && <Callout tone="warn" icon="alert">{gate}</Callout>}
        <Card title="Legal review" sub="Every clause below needs an Oregon lawyer's review before first use. Until it is recorded here, a proposal can only be a test send.">
          <label className="fl" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={reviewed} onChange={(e) => update(e.target.checked ? { legalReviewedAt: new Date().toISOString() } : { legalReviewedAt: null, legalReviewer: "" })} />
            <span>Reviewed by an Oregon lawyer</span>
          </label>
          {reviewed && (
            <Row>
              <Field label="Reviewed by" htmlFor="dc-reviewer" help="The lawyer or firm, up to 120 characters.">
                <input id="dc-reviewer" className="in" value={cfg.legalReviewer} maxLength={120} aria-invalid={!cfg.legalReviewer.trim()} onChange={(e) => update({ legalReviewer: e.target.value })} />
              </Field>
              <Field label="Review date" htmlFor="dc-date" help={`Clause library version ${CLAUSE_LIBRARY_VERSION}.`}>
                <input id="dc-date" className="in" type="date" value={cfg.legalReviewedAt!.slice(0, 10)}
                  onChange={(e) => { if (e.target.value) update({ legalReviewedAt: `${e.target.value}T00:00:00.000Z` }); }} />
              </Field>
            </Row>
          )}
          {problem && <p className="bx-err" role="alert">{problem}</p>}
        </Card>
        <Card title="Payments" sub="Deposits are invoiced through Stripe. The keys are Worker secrets: this page shows only whether they are set.">
          <p>{billing ? billingLine(billing) : "Checking…"}</p>
          {billing?.stripeMode === "live" && <Callout tone="warn" icon="alert">Live mode: a deposit invoice charges a real client.</Callout>}
          {billingIssue && <Callout tone="info">{billingIssue}</Callout>}
        </Card>
        <Card title="Terms">
          <Row>
            <Field label="Late fee (% per month)" htmlFor="dc-late" help="0 to 10. Written into the late fee clause.">
              <input id="dc-late" className="in" type="number" min={0} max={10} step={0.1} value={cfg.lateFeePercentMonthly} onChange={num("lateFeePercentMonthly")} />
            </Field>
            <Field label="Proposal stays open (days)" htmlFor="dc-expiry" help="7 to 90. After this a sent proposal expires.">
              <input id="dc-expiry" className="in" type="number" min={7} max={90} value={cfg.expiryDays} onChange={num("expiryDays")} />
            </Field>
          </Row>
        </Card>
        <Card title="Clause library" sub="The exact wording the app puts in a document, shown for a client with every optional package. Hand this page to your lawyer.">
          <ol className="dc-clauses">
            {clauses.map((c) => (
              <li key={c.id}>
                <b>{c.title}</b>
                <p>{c.text}</p>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </SettingsPage>
  );
}
