import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { Banner, Card, Chip, Empty, type Tone } from "../components/ds";
import Icon from "../components/Icon";
import { optionSummary } from "../dealView";
import { dollars, formatPrice, type Package } from "../packagesView";
import { contactOf, depositLine, editsOf, proposalSteps, sendBlockers, type ProposalForm } from "../proposalView";
import type { Deal } from "../../worker/db/deals";
import type { Document } from "../../worker/db/documents";
import type { InvoiceRow } from "../../worker/db/invoices";
import { DEFAULT_ASSUMPTIONS, DEFAULT_OUT_OF_SCOPE } from "../../worker/documents/proposal";

/** What the server says about a deal's proposal (`GET /api/deals/:id/proposal`). */
export interface ProposalData {
  current: Document | null;
  /** The current document's deposit invoice, once it has one. */
  invoice: InvoiceRow | null;
  /** How many times the client opened the current document. */
  views: number;
  history: Document[]; legalGate: string | null; clientBase: string | null; defaultContact: { name: string; email: string } | null;
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
export const DOC_STATUS: Record<Document["status"], string> = { draft: "Draft", sent: "Sent", viewed: "Viewed", signed: "Signed", void: "Void", expired: "Expired" };
export const DOC_TONE: Record<Document["status"], Tone> = { draft: "info", sent: "signal", viewed: "signal", signed: "positive", void: "neutral", expired: "warning" };
const DUE: Record<string, string> = { signing: "Due at signing", design_approved: "Due when the design is approved", site_finished: "Due when the site is finished" };
const STARTS: Record<string, string> = { signing: "from signing", launch: "from launch", kickoff: "from kickoff" };
const CARE_KEYS = ["care", "care_plus", "care_fallback"];
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

/** What the proposal's buttons do. It lives in the Deal page (the header carries Save draft and Send for approval) and is handed to the tab. */
export interface ProposalActions {
  busy: boolean; error: string; notice: string; problems: string[]; copied: boolean; canSend: boolean; blockers: string[];
  clear: () => void; save: () => void; test: () => void; send: () => void; retryDeposit: () => void; voidIt: (reason: string, done: () => void) => void; copyLink: (url: string) => void;
}

/**
 * The proposal's actions: save the draft, send a test to yourself, send it for your approval (the approval is your countersignature; nothing reaches the client
 * before it), retry the deposit invoice, void a version. Safe to call before anything has loaded: every action waits for the deal and its proposal.
 */
export function useProposalActions({ deal, data, form, dirty, onReload }: {
  deal: Deal | null; data: ProposalData | null; form: ProposalForm | null; dirty: boolean; onReload: (fresh: Document | null | undefined) => Promise<void>;
}): ProposalActions {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const current = data?.current ?? null;
  const closed = deal?.stage === "won" || deal?.stage === "lost";

  async function run(fn: () => Promise<void>) {
    if (!deal || !data) return;
    setBusy(true); setError(""); setNotice(""); setProblems([]);
    try { await fn(); }
    catch (e) {
      const body = e instanceof ApiError ? (e.body as { problems?: string[] } | undefined) : undefined;
      setError(errorText(e, "Something went wrong"));
      if (body?.problems?.length) setProblems(body.problems);
      await onReload(undefined).catch(() => {});
    } finally { setBusy(false); }
  }

  const save = () => run(async () => {
    if (!form || !deal) return;
    const contact = contactOf(form);
    if (contact === "incomplete") throw new Error("Give both the contact's name and email, or leave both blank to use the person who booked the call.");
    const sameBase = current?.status === "draft" && current.optionId === form.optionId && contact !== null
      && current.content.header.contactName === contact.name && current.content.header.contactEmail === contact.email;
    const doc = sameBase
      ? await api.put<Document>(`/documents/${current!.id}`, { edits: editsOf(form) })
      : await api.post<Document>(`/deals/${deal.id}/proposal`, { optionId: form.optionId, edits: editsOf(form), ...(contact ? { contact } : {}) });
    await onReload(doc);
    setNotice("Draft saved.");
  });
  const test = () => run(async () => {
    const doc = await api.post<Document>(`/documents/${current!.id}/test-send`);
    await onReload(doc);
    setNotice("A test copy was sent to your own address. It is a real link: open it, read it, then void it before you make the version to send.");
  });
  const send = () => run(async () => {
    await api.post<{ approvalId: string }>(`/documents/${current!.id}/send`);
    setNotice("Sent for your approval. Approving it on the Home page sends the link and countersigns it as you.");
  });
  const retryDeposit = () => run(async () => {
    const out = await api.post<{ state: string }>(`/documents/${current!.id}/deposit`);
    await onReload(undefined);
    setNotice(out.state === "open" || out.state === "paid" ? "The deposit invoice is ready." : "Stripe could not make the invoice. The reason is on the lead's timeline.");
  });
  const voidIt = (reason: string, done: () => void) => run(async () => {
    if (!reason.trim()) throw new Error("Say why you are voiding it (it is kept in the history).");
    const doc = await api.post<Document>(`/documents/${current!.id}/void`, { reason: reason.trim() });
    done();
    await onReload(doc);
    setNotice("Voided. Save a draft to start a new version.");
  });
  async function copyLink(url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError("Could not copy: select the link and copy it by hand."); }
  }

  const blockers = current && data ? sendBlockers({ legalGate: data.legalGate, clientBase: data.clientBase, doc: current }) : [];
  const canSend = !!current && current.status === "draft" && !dirty && !busy && !closed && blockers.length === 0;
  return {
    busy, error, notice, problems, copied, canSend, blockers,
    clear: () => { setNotice(""); setError(""); setProblems([]); },
    save: () => void save(), test: () => void test(), send: () => void send(), retryDeposit: () => void retryDeposit(), voidIt: (r, d) => void voidIt(r, d), copyLink: (u) => void copyLink(u),
  };
}

/**
 * The proposal builder: the proposal as the client will read it on the left (what they get, what is not included, what we assume, the timeline and payments,
 * the Care plan), and on the right the option and its price, who it goes to, the contract clauses and how it gets sent. The form lives on the Deal page so
 * typing survives a switch of tab; Save draft and Send for approval sit in the page header.
 */
export default function ProposalTab({ deal, catalog, data, form, setForm, dirty, actions: pa, onRecap }: {
  deal: Deal; catalog: Package[]; data: ProposalData | null; form: ProposalForm; setForm: (f: ProposalForm) => void; dirty: boolean; actions: ProposalActions; onRecap: () => void;
}) {
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<"scope" | "out" | "assume" | null>(null);

  if (!deal.options || !deal.recap) {
    return (
      <div className="ds-card">
        <Empty icon="file-text" title="No proposal yet" action={<button type="button" className="btn primary" onClick={onRecap}>Go to the recap</button>}>
          The proposal is built from the three options on the Recap tab. Draft the recap first, then pick the option the owner chose here.
        </Empty>
      </div>
    );
  }
  if (!data) return <p className="slx-muted">Loading the proposal…</p>;

  const { current } = data;
  const closed = deal.stage === "won" || deal.stage === "lost";
  const option = deal.options.find((o) => o.id === form.optionId);
  const optionHasCare = !!option?.items.some((i) => CARE_KEYS.includes(i.key));
  const editable = (!current || current.status === "draft") && !closed;
  const set = (patch: Partial<ProposalForm>) => { setForm({ ...form, ...patch }); pa.clear(); };
  // The document shows what is saved when it matches the option picked; otherwise what the option will hold, from the catalog.
  const saved = current && current.optionId === form.optionId ? current.content : null;
  const pkgs = saved ? saved.packages : (option?.items ?? []).map((i) => {
    const p = catalog.find((c) => c.key === i.key);
    return { key: i.key, name: p?.name ?? i.key, priceLine: p ? formatPrice(p) : "", includes: p?.includes ?? [] };
  });
  const buildPkgs = pkgs.filter((p) => !CARE_KEYS.includes(p.key));
  const carePkg = pkgs.find((p) => CARE_KEYS.includes(p.key));
  const care = carePkg ? catalog.find((c) => c.key === carePkg.key) : undefined;
  const careRecurring = saved?.schedule.recurring.find((r) => CARE_KEYS.includes(r.key));
  const header = current?.content.header;
  const contactName = form.contactName.trim() || data.defaultContact?.name || header?.contactName || "the client";
  const firstName = contactName.split(/\s+/)[0];
  const deposit = current ? depositLine(current, data.invoice) : null;
  const link = current?.token && data.clientBase ? `${data.clientBase}/p/${current.token}` : null;
  const host = data.clientBase ? data.clientBase.replace(/^https?:\/\//, "") : null;
  const sum = option ? optionSummary(option, catalog) : null;
  const canVoid = !!current && (current.status === "draft" || current.status === "sent" || current.status === "viewed" || (current.status === "signed" && current.test));
  let n = 0;
  const editBtn = (key: "scope" | "out" | "assume") => editable && (
    <button type="button" className="slx-edit" aria-expanded={editing === key} onClick={() => setEditing(editing === key ? null : key)}><Icon name="pen" size={14} />{editing === key ? "Done" : "Edit"}</button>
  );

  return (
    <>
      {pa.error && (
        <Banner tone="critical" title={pa.error}>
          {pa.problems.length > 0 && pa.problems.join(" ")}
        </Banner>
      )}
      {pa.notice && <Banner tone="positive" title={pa.notice} action={pa.notice.startsWith("Sent for your approval") ? <Link className="btn sm" to="/">Open Home</Link> : undefined} />}
      {dirty && editable && <Banner tone="info" icon="pen" title="Unsaved changes" action={<button type="button" className="btn sm" disabled={pa.busy} onClick={pa.save}>Save draft</button>}>Save the draft before you test or send it.</Banner>}
      {current && current.status === "draft" && pa.blockers.length > 0 && (
        <Banner tone="warning" title="Not ready to send yet">
          {pa.blockers.join(" ")}
        </Banner>
      )}

      <div className="slx-builder">
        <article className="ds-card slx-doc" aria-label="The proposal as the client reads it">
          <header className="slx-doc-head">
            <span className="slx-mark" aria-hidden="true"><i /></span>
            <div className="slx-doc-title">
              <h2>Proposal and statement of work</h2>
              <p>Prepared for {contactName}{header ? ` · ${header.clientName}` : ""}</p>
            </div>
            <div className="slx-doc-ref">
              {header ? <code>{header.reference} · v{header.version}</code> : <code>Not saved yet</code>}
              <small>{current?.expiresAt ? `Expires ${dayOf(current.expiresAt)}` : "Expiry is set when it is sent"}</small>
            </div>
          </header>

          <section className="slx-doc-sec">
            <div className="slx-sec-head"><span className="slx-num">{++n}</span><h3>What you get</h3>{editBtn("scope")}</div>
            {pkgs.length === 0 && <p className="slx-hint">This option has no packages.</p>}
            {(buildPkgs.length ? buildPkgs : pkgs).map((p) => (
              <div key={p.key} className="slx-doc-pkg">
                <p className="slx-doc-pkg-top"><b>{p.name}</b><span>{p.priceLine}</span></p>
                <ul className="slx-checks">{p.includes.map((x, i) => <li key={i}><Icon name="check" size={14} />{x}</li>)}</ul>
              </div>
            ))}
            {editing === "scope"
              ? <label className="slx-field"><span>Scope notes (shown in the proposal; leave blank for none)</span>
                  <textarea rows={4} maxLength={4000} value={form.scopeNotes} onChange={(e) => set({ scopeNotes: e.target.value })} autoFocus /></label>
              : form.scopeNotes.trim() && <p className="slx-doc-note">{form.scopeNotes}</p>}
          </section>

          <section className="slx-doc-sec">
            <div className="slx-sec-head"><span className="slx-num">{++n}</span><h3>Not included</h3>{editBtn("out")}</div>
            <ul className="slx-crosses">{[...DEFAULT_OUT_OF_SCOPE, ...lines(form.extraOutOfScope)].map((x, i) => <li key={i}><Icon name="x" size={14} />{x}</li>)}</ul>
            {editing === "out" && <label className="slx-field"><span>Your own exclusions, one per line (up to 20). The standard ones above always stay.</span>
              <textarea rows={3} value={form.extraOutOfScope} onChange={(e) => set({ extraOutOfScope: e.target.value })} autoFocus /></label>}
          </section>

          <section className="slx-doc-sec">
            <div className="slx-sec-head"><span className="slx-num">{++n}</span><h3>What we assume</h3>{editBtn("assume")}</div>
            <ul className="slx-dots">{[...DEFAULT_ASSUMPTIONS, ...lines(form.extraAssumptions)].map((x, i) => <li key={i}>{x}</li>)}</ul>
            {editing === "assume" && <label className="slx-field"><span>Your own assumptions, one per line (up to 20). The standard ones above always stay.</span>
              <textarea rows={3} value={form.extraAssumptions} onChange={(e) => set({ extraAssumptions: e.target.value })} autoFocus /></label>}
          </section>

          <section className="slx-doc-sec">
            <div className="slx-sec-head"><span className="slx-num">{++n}</span><h3>Timeline and payments</h3></div>
            {saved ? (
              <div className="slx-table-wrap">
                <table className="ds-table slx-doc-table">
                  <thead><tr><th>Phase</th><th>What happens</th><th>Payment</th></tr></thead>
                  <tbody>
                    {saved.schedule.milestones.filter((m) => m.dueOn === "signing").map((m) => (
                      <tr key={m.id}><th scope="row">Signing</th><td>You sign and pay the {m.label.toLowerCase()}</td><td className="slx-pay">{dollars(m.amountCents)}</td></tr>
                    ))}
                    {saved.phases.map((p, i) => {
                      const m = p.milestoneId ? saved.schedule.milestones.find((x) => x.id === p.milestoneId) : undefined;
                      return <tr key={i}><th scope="row">{p.name}</th><td>{p.summary}</td><td className="slx-pay">{m ? `${dollars(m.amountCents)} ${m.label.toLowerCase()}` : "None"}</td></tr>;
                    })}
                    {saved.schedule.recurring.map((r) => (
                      <tr key={r.key}><th scope="row">{r.name}</th><td>Monthly {STARTS[r.startsOn]}{r.termMonths ? `, for ${r.termMonths} months` : ", until cancelled"}</td><td className="slx-pay">{dollars(r.monthlyCents)} a month</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="slx-hint">The phases and the payment schedule are worked out from the option when you save the draft.</p>}
          </section>

          {(carePkg || form.careDeclined) && (
            <section className="slx-doc-sec">
              <div className="slx-sec-head"><span className="slx-num">{++n}</span><h3>Care plan</h3></div>
              {carePkg ? (
                <div className="slx-care">
                  <Icon name="shield" size={18} />
                  <div>
                    <b>{carePkg.name} · {care ? `${dollars(care.priceCents)} a month` : carePkg.priceLine}, starting {careRecurring ? STARTS[careRecurring.startsOn].replace("from ", "at ") : "at launch"}</b>
                    <p>{carePkg.includes.map((x, i) => (i ? x.charAt(0).toLowerCase() + x.slice(1) : x)).join(", ")}.</p>
                  </div>
                  <Chip tone="positive">On by default</Chip>
                </div>
              ) : (
                <div className="slx-care declined">
                  <Icon name="alert" size={18} />
                  <div><b>The client declined Care</b><p>The proposal records that they said no to Care, with the opt-out clause.</p></div>
                </div>
              )}
            </section>
          )}
        </article>

        <div className="ds-col">
          <Card icon="tag" title="Package and price" flush note={editable ? undefined : "Locked: void to change"}>
            <div role="radiogroup" aria-label="Which option">
              {deal.options.map((o) => {
                const s = optionSummary(o, catalog);
                const on = form.optionId === o.id;
                return (
                  <label key={o.id} className={`slx-opt${on ? " on" : ""}${!editable ? " off" : ""}`}>
                    <input type="radio" name="proposal-option" checked={on} disabled={!editable} onChange={() => set({ optionId: o.id })} />
                    <span className="slx-opt-text"><b>{o.label}{o.recommended && <Chip tone="signal">Recommended</Chip>}</b><small>{s.items.map((x) => x.split(":")[0]).join(" · ")}</small></span>
                    <span className="slx-opt-price">{s.upfront ?? ""}{s.upfront && s.monthly ? <br /> : null}{s.monthly ?? ""}</span>
                  </label>
                );
              })}
              <label className={`slx-opt toggle${!editable || optionHasCare ? " off" : ""}`}>
                <span className="slx-opt-text"><b>Client declined Care</b><small>{optionHasCare ? "This option includes Care, so it can’t be declined." : "Only when the option builds a site, has no Care, and they said no."}</small></span>
                <span className="switch"><input type="checkbox" checked={form.careDeclined} disabled={!editable || optionHasCare} onChange={(e) => set({ careDeclined: e.target.checked })} /><i /></span>
              </label>
            </div>
            <dl className="slx-totals">
              {saved ? (
                <>
                  {saved.schedule.milestones.map((m) => <div key={m.id}><dt>{DUE[m.dueOn]}</dt><dd>{dollars(m.amountCents)}</dd></div>)}
                  {saved.schedule.recurring.map((r) => <div key={r.key}><dt>Then monthly {STARTS[r.startsOn]} ({r.name})</dt><dd>{dollars(r.monthlyCents)}</dd></div>)}
                </>
              ) : (
                <>
                  <div><dt>Up front</dt><dd>{sum?.upfront ?? "None"}</dd></div>
                  <div><dt>Monthly</dt><dd>{sum?.monthly ?? "None"}</dd></div>
                  <div className="note"><dt>The exact schedule shows once the draft is saved.</dt></div>
                </>
              )}
            </dl>
          </Card>

          <Card icon="user" title="Who it goes to">
            <div className="slx-form">
              <label className="slx-field"><span>Contact name</span>
                <input maxLength={200} value={form.contactName} disabled={!editable} onChange={(e) => set({ contactName: e.target.value })} /></label>
              <label className="slx-field"><span>Contact email</span>
                <input type="email" maxLength={254} value={form.contactEmail} disabled={!editable} onChange={(e) => set({ contactEmail: e.target.value })} /></label>
              <p className="slx-hint">Leave both blank to use the person who booked the call{data.defaultContact ? ` (${data.defaultContact.name}, ${data.defaultContact.email})` : ""}.</p>
            </div>
          </Card>

          <Card icon="shield" title="Contract clauses" action={data.legalGate ? <Chip tone="warning" dot>Lawyer review pending</Chip> : saved ? <Chip tone="positive" dot>Reviewed</Chip> : undefined}>
            {saved ? (
              <ul className="slx-clauses">{saved.clauses.map((c) => <li key={c.id}><span className="slx-box" aria-hidden="true"><Icon name="check" size={12} /></span>{c.title}</li>)}</ul>
            ) : <p>The clauses that fit this option are added when you save the draft.</p>}
            {data.legalGate && <p className="slx-hint">{data.legalGate}</p>}
          </Card>

          <Card icon="send" title="How it gets sent">
            <p>A private link{host ? ` on ${host}` : ""}. {firstName} reads it, types their name to sign, and pays the deposit on the same page. You approve the send on Home first: that approval countersigns it as you. You get the signed PDF with an audit page.</p>
            {current && (
              <ol className="slx-life">
                {proposalSteps(current, data.views).map((s) => (
                  <li key={s.label} className={s.done ? "done" : ""}>
                    <span className="slx-step-mark" aria-hidden="true">{s.done && <Icon name="check" size={12} />}</span>
                    <span>{s.label}</span>{s.at && <time>{when(s.at)}</time>}
                  </li>
                ))}
              </ol>
            )}
            {deposit && (
              <p className="slx-deposit" role="status"><Icon name="card" size={14} />{deposit.text}{deposit.retry && <button type="button" className="btn sm" disabled={pa.busy} onClick={pa.retryDeposit}>Retry</button>}</p>
            )}
            {link && (
              <div className="slx-link-row">
                <input readOnly aria-label="Client link" value={link} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn sm" onClick={() => pa.copyLink(link)}><Icon name="copy" size={14} />{pa.copied ? "Copied" : "Copy link"}</button>
              </div>
            )}
            <div className="slx-actions">
              <button type="button" className="btn sm" disabled={pa.busy || closed || !current || current.status !== "draft" || dirty} onClick={pa.test}><Icon name="mail" size={14} />Send a test to me</button>
            </div>
            {!current && <p className="slx-hint">No draft yet. Save draft builds the proposal from the option you picked.</p>}
            {canVoid && (
              <details className="slx-void">
                <summary>Void this version and start a new one</summary>
                <div className="slx-link-row">
                  <input aria-label="Why you are voiding it" placeholder="Why void it?" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button type="button" className="btn sm" disabled={pa.busy} onClick={() => pa.voidIt(reason, () => setReason(""))}>Void it</button>
                </div>
              </details>
            )}
          </Card>

          {data.history.length > 0 && (
            <Card icon="clock" title="Versions" note={`${data.history.length}`} flush>
              {data.history.map((d) => (
                <div key={d.id} className="slx-version">
                  <span className="slx-version-n">v{d.version}</span>
                  <span className="slx-pick-text">
                    <b>Option {d.optionId.toUpperCase()}{d.test ? " (test)" : ""}</b>
                    <small>{proposalSteps(d).filter((s) => s.done && s.label !== "Drafted").map((s) => `${s.label}${s.at ? ` ${when(s.at)}` : ""}`).join(" · ") || `Drafted ${when(d.createdAt)}`}</small>
                  </span>
                  <Chip tone={DOC_TONE[d.status]} dot>{DOC_STATUS[d.status]}</Chip>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
