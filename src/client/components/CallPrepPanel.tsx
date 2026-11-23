import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { evidenceFor, prepForDisplay } from "../callPrepView";
import type { Package } from "../packagesView";
import type { CallPrep } from "../../worker/queue/callPrep";
import Icon from "./Icon";

interface OpenDeal { id: string; businessId: string; stage: string; callPrep: CallPrep | null }
const POLL_MS = 15_000;

/**
 * The lead's call prep: the fixed 20-minute structure and ten questions (always there), with Claude's tailored notes, the audit findings worth raising, and
 * the likely pushbacks once Claude has written them. Nothing when the lead has no open deal. "Draft prep again" queues it; while it is queued the panel
 * checks for the result. Everything in it is shown as text (React escapes it). "Print" prints just this panel, in one column.
 */
export default function CallPrepPanel({ leadId, findings }: { leadId: string; findings: { code: string; evidence: string }[] }) {
  const [deal, setDeal] = useState<OpenDeal | null>(null);
  const [catalog, setCatalog] = useState<Package[]>([]);
  const [queued, setQueued] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shownAt = useRef<string | null>(null);

  const load = (): Promise<OpenDeal | null> =>
    api.get<OpenDeal[]>("/deals?open=1").then((all) => all.find((d) => d.businessId === leadId) ?? null);

  useEffect(() => {
    let live = true;
    setDeal(null); setQueued(false); setError("");
    Promise.all([load(), api.get<Package[]>("/packages")])
      .then(([d, c]) => { if (live) { shownAt.current = d?.callPrep?.generatedAt ?? null; setDeal(d); setCatalog(c); } })
      .catch(() => { if (live) setDeal(null); });
    return () => { live = false; };
  }, [leadId]);

  // While a prep is queued, look again every so often; a newer `generatedAt` means Claude wrote it.
  useEffect(() => {
    if (!queued) return;
    let live = true;
    const t = setInterval(() => {
      load().then((d) => {
        if (!live || !d) return;
        if ((d.callPrep?.generatedAt ?? null) !== shownAt.current) { shownAt.current = d.callPrep?.generatedAt ?? null; setDeal(d); setQueued(false); }
      }).catch(() => {});
    }, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [queued, leadId]);

  if (!deal) return null;

  async function draft() {
    setBusy(true); setError("");
    try { await api.post(`/deals/${deal!.id}/prep`); setQueued(true); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not queue the prep"); }
    finally { setBusy(false); }
  }

  function print() {
    // Every part prints, so the folded groups are opened first and put back afterwards.
    const groups = [...document.querySelectorAll<HTMLDetailsElement>(".callprep details.clx-lead-cp-more")];
    const was = groups.map((g) => g.open);
    groups.forEach((g) => { g.open = true; });
    document.body.classList.add("print-callprep");
    const done = () => { document.body.classList.remove("print-callprep"); groups.forEach((g, i) => { g.open = was[i]; }); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
  }

  const prep = deal.callPrep;
  const v = prepForDisplay(prep, catalog);
  const drafted = prep ? new Date(prep.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  const tailoredCount = v.questions.filter((q) => q.tailored).length;
  return (
    <details className="prop-sec callprep clx-lead-cp" open>
      <summary><Icon name="sparkles" size={15} /><span className="grow">Call prep</span>
        <span className={`clx-lead-chip ${queued ? "info" : prep ? "signal" : "neutral"}`}>{queued ? "Queued" : prep ? "Tailored" : "Not tailored yet"}</span>
        <Icon name="chevron-down" size={14} className="chev" /></summary>
      <div className="prop-body">
        <p className="clx-lead-cp-status" role="status">
          {queued ? "Queued. Claude writes it the next time it works the queue."
            : drafted ? `Claude tailored this ${drafted}.`
            : "Claude has not tailored this yet. The plan and the ten questions below work as they are."}
        </p>
        <div className="cp-actions">
          <button type="button" className="btn sm" onClick={draft} disabled={busy || queued}><Icon name="sparkles" size={14} />{prep ? "Draft prep again" : "Draft prep"}</button>
          <button type="button" className="btn-ghost-sm" onClick={print}><Icon name="file-text" size={14} />Print</button>
        </div>
        {error && <p className="warn small" role="alert">{error}</p>}

        {prep && <section className="clx-lead-cp-open"><h4>Open with</h4><p>{prep.opener}</p></section>}

        {v.flags.length > 0 && (
          <section>
            <h4>Worth raising</h4>
            <ul className="clx-lead-cp-flags">
              {v.flags.map((f, i) => {
                const evidence = evidenceFor(findings, f.findingCode);
                return (
                  <li key={`${f.findingCode}-${i}`}>
                    <p>{f.talkingPoint}</p>
                    <p className="clx-lead-cp-ask"><b>Ask</b> {f.askThis}</p>
                    {evidence && <p className="clx-lead-cp-ev"><Icon name="alert" size={12} />{evidence}</p>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <div className="clx-lead-cp-groups">
          <details className="clx-lead-cp-more">
            <summary><Icon name="clock" size={14} /><span className="grow">The 20 minutes</span><small>{v.structure.length} parts</small><Icon name="chevron-down" size={14} className="chev" /></summary>
            <ol className="cp-list">
              {v.structure.map((b) => <li key={b.fromMin}><strong>{b.fromMin} to {b.toMin} min, {b.title}.</strong> {b.detail}</li>)}
            </ol>
          </details>
          <details className="clx-lead-cp-more">
            <summary><Icon name="list" size={14} /><span className="grow">The ten questions</span><small>{tailoredCount > 0 ? `${tailoredCount} with notes` : "10"}</small><Icon name="chevron-down" size={14} className="chev" /></summary>
            <ol className="cp-list">
              {v.questions.map((q) => (
                <li key={q.n} value={q.n}>
                  <p>{q.text}</p>
                  {q.tailored && <p className="cp-note">{q.tailored}</p>}
                </li>
              ))}
            </ol>
          </details>
          <details className="clx-lead-cp-more">
            <summary><Icon name="shield" size={14} /><span className="grow">If they push back</span><small>{v.pushbacks.length}</small><Icon name="chevron-down" size={14} className="chev" /></summary>
            <ul className="cp-list">
              {v.pushbacks.map((p, i) => <li key={i}><p><strong>{p.objection}</strong></p><p>{p.answer}</p></li>)}
            </ul>
          </details>
          {prep && prep.watchFor.length > 0 && (
            <details className="clx-lead-cp-more">
              <summary><Icon name="eye" size={14} /><span className="grow">Watch for</span><small>{prep.watchFor.length}</small><Icon name="chevron-down" size={14} className="chev" /></summary>
              <ul className="cp-list">{prep.watchFor.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
        </div>
      </div>
    </details>
  );
}
