import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { optionSummary } from "../dealView";
import type { Package } from "../packagesView";
import { contactOf, depositLine, editsOf, proposalSteps, sendBlockers, type ProposalForm } from "../proposalView";
import type { Deal } from "../../worker/db/deals";
import type { Document } from "../../worker/db/documents";
import type { InvoiceRow } from "../../worker/db/invoices";

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
const STATUS: Record<Document["status"], string> = { draft: "Draft", sent: "Sent", viewed: "Viewed", signed: "Signed", void: "Void", expired: "Expired" };

/**
 * The deal's proposal and statement of work: pick the option, add the scope notes and the extras, check the preview, send a test to yourself, and send it for
 * your approval (the approval is your countersignature; nothing reaches the client before it). The form lives on the Deal page so typing survives a switch of tab.
 */
export default function ProposalTab({ deal, catalog, data, form, setForm, dirty, onReload }: {
  deal: Deal; catalog: Package[]; data: ProposalData | null; form: ProposalForm; setForm: (f: ProposalForm) => void; dirty: boolean; onReload: (fresh: Document | null | undefined) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [copied, setCopied] = useState(false);

  if (!deal.options || !deal.recap) return <p className="muted">Draft the recap first: the proposal is built from the options on the Recap tab.</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const { current } = data;
  const closed = deal.stage === "won" || deal.stage === "lost";
  const option = deal.options.find((o) => o.id === form.optionId);
  const optionHasCare = !!option?.items.some((i) => i.key === "care" || i.key === "care_plus" || i.key === "care_fallback");
  const editable = !current || current.status === "draft";
  const set = (patch: Partial<ProposalForm>) => { setForm({ ...form, ...patch }); setNotice(""); setError(""); setProblems([]); };

  async function run(fn: () => Promise<void>) {
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
    setNotice(`A test copy was sent to your own address. It is a real link: open it, read it, then void it before you make the version to send.`);
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
  const voidIt = () => run(async () => {
    if (!reason.trim()) throw new Error("Say why you are voiding it (it is kept in the history).");
    const doc = await api.post<Document>(`/documents/${current!.id}/void`, { reason: reason.trim() });
    setReason("");
    await onReload(doc);
    setNotice("Voided. Save a draft to start a new version.");
  });
  async function copyLink(url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError("Could not copy: select the link and copy it by hand."); }
  }

  const blockers = current ? sendBlockers({ legalGate: data.legalGate, clientBase: data.clientBase, doc: current }) : [];
  const canSend = !!current && current.status === "draft" && !dirty && !busy && !closed && blockers.length === 0;
  const deposit = current ? depositLine(current, data.invoice) : null;
  const link = current?.token && data.clientBase ? `${data.clientBase}/p/${current.token}` : null;

  return (
    <section className="deal-form" aria-label="Proposal">
      <p className="muted small">Every price comes from the frozen deal prices. The terms are a draft until a lawyer has reviewed them; real sends wait for that review.</p>

      <fieldset className="deal-field" disabled={!editable || closed}>
        <legend>Which option</legend>
        <div className="deal-options">
          {deal.options.map((o) => {
            const s = optionSummary(o, catalog);
            return (
              <label key={o.id} className={`deal-option${form.optionId === o.id ? " rec" : ""}`}>
                <span><input type="radio" name="proposal-option" checked={form.optionId === o.id} onChange={() => set({ optionId: o.id })} /> {o.label}{o.recommended ? " (recommended)" : ""}</span>
                <small className="muted">{s.items.join(", ")}</small>
                <small><strong>{[s.upfront && `${s.upfront} up front`, s.monthly].filter(Boolean).join(" + ")}</strong></small>
              </label>
            );
          })}
        </div>
      </fieldset>

      <label className="deal-field"><span>Scope notes (shown in the proposal; leave blank for none)</span>
        <textarea rows={4} maxLength={4000} value={form.scopeNotes} disabled={!editable || closed} onChange={(e) => set({ scopeNotes: e.target.value })} /></label>
      <div className="field-row">
        <label className="deal-field"><span>Extra assumptions (one per line, up to 20)</span>
          <textarea rows={3} value={form.extraAssumptions} disabled={!editable || closed} onChange={(e) => set({ extraAssumptions: e.target.value })} /></label>
        <label className="deal-field"><span>Extra out of scope (one per line, up to 20)</span>
          <textarea rows={3} value={form.extraOutOfScope} disabled={!editable || closed} onChange={(e) => set({ extraOutOfScope: e.target.value })} /></label>
      </div>
      <label className="deal-pkg">
        <input type="checkbox" className="cb" checked={form.careDeclined} disabled={!editable || closed || optionHasCare} onChange={(e) => set({ careDeclined: e.target.checked })} />
        The client declined Care
      </label>
      <p className="muted small">A new site comes with Care by default. Tick this only when the option builds a site, has no Care plan, and the client said no to Care: the proposal then records that they declined it. It cannot be ticked when the option includes Care.</p>

      <div className="field-row">
        <label className="deal-field"><span>Contact name</span>
          <input maxLength={200} value={form.contactName} disabled={!editable || closed} onChange={(e) => set({ contactName: e.target.value })} /></label>
        <label className="deal-field"><span>Contact email</span>
          <input type="email" maxLength={254} value={form.contactEmail} disabled={!editable || closed} onChange={(e) => set({ contactEmail: e.target.value })} /></label>
      </div>
      <p className="muted small">Both blank uses the person who booked the discovery call{data.defaultContact ? ` (${data.defaultContact.name}, ${data.defaultContact.email})` : ""}.</p>

      {error && <p className="warn small" role="alert">{error}</p>}
      {problems.length > 0 && <ul className="warn small" role="alert">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      {notice && <p className="small" role="status">{notice}{notice.startsWith("Sent for your approval") && <> <Link to="/">Open Home</Link></>}</p>}

      <div className="cp-actions">
        <button type="button" className="btn" disabled={busy || closed || !editable} onClick={save}>Save draft</button>
        <button type="button" className="btn" disabled={busy || closed || !current || current.status !== "draft" || dirty} onClick={test}>Send a test to me</button>
        <button type="button" className="btn" disabled={!canSend} onClick={send}>Send for approval</button>
        {dirty && <span className="muted small">Unsaved changes: save the draft before testing or sending.</span>}
      </div>
      {current && blockers.length > 0 && (
        <div className="warn small" role="status">
          <p>Not ready to send:</p>
          <ul>{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      )}

      {current ? (
        <>
          <h3>Preview</h3>
          <iframe title="Proposal preview" className="proposal-frame" sandbox="" src={`/api/documents/${current.id}/preview.html?v=${encodeURIComponent(current.updatedAt)}`} />
          <h3>Status: {STATUS[current.status]}{current.test ? " (test copy)" : ""}, version {current.version}</h3>
          <ol className="proposal-steps">
            {proposalSteps(current, data.views).map((s) => <li key={s.label} className={s.done ? "done" : ""}>{s.done ? "Done" : "Waiting"}: {s.label}{s.at ? ` (${when(s.at)})` : ""}</li>)}
          </ol>
          {deposit && (
            <div className="cp-actions" role="status">
              <span>{deposit.text}</span>
              {deposit.retry && <button type="button" className="btn-ghost-sm" disabled={busy} onClick={retryDeposit}>Retry</button>}
            </div>
          )}
          {link && (
            <div className="cp-actions">
              <input readOnly aria-label="Client link" className="proposal-link" value={link} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn-ghost-sm" onClick={() => copyLink(link)}>{copied ? "Copied" : "Copy link"}</button>
            </div>
          )}
          {(current.status === "draft" || current.status === "sent" || current.status === "viewed") && (
            <div className="cp-actions">
              <input aria-label="Why you are voiding it" placeholder="Why void it?" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button type="button" className="btn-ghost-sm" disabled={busy} onClick={voidIt}>Void and start a new version</button>
            </div>
          )}
        </>
      ) : <p className="muted small">No draft yet. “Save draft” builds the proposal from the option you picked.</p>}

      {data.history.length > 0 && (
        <>
          <h3>History</h3>
          <ul className="proposal-history">
            {data.history.map((d) => (
              <li key={d.id}>
                Version {d.version}, option {d.optionId.toUpperCase()}: {STATUS[d.status]}{d.test ? " (test)" : ""}. {proposalSteps(d).filter((s) => s.done && s.label !== "Drafted").map((s) => `${s.label}${s.at ? ` ${when(s.at)}` : ""}`).join(", ")}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
