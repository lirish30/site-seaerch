import { useState } from "react";
import { seoApi, type SeoOverview } from "../../../api";
import { dayLabel } from "../../../careReportPageView";
import { safeHref } from "../../../clientView";
import { citationLabel, CITATION_STATUSES, gridCells, napLines, snapshotFacts, termMovement, termName } from "../../../seoView";
import { Part, Say, sentence } from "./seoBits";

type Patch = (p: Partial<SeoOverview>) => void;

/** One term's nine points as three rows of three from the north-west. Every cell says its band in words, so colour is never the only signal. */
function Grid({ row }: { row: SeoOverview["latestGrid"][number] }) {
  const cells = gridCells(row.points);
  const label = termName(row);
  return (
    <li className="sx-term">
      <div className="sx-term-head">
        <b className="sx-term-name">{label}</b>
        <span className="small muted">{row.visible === null ? "Not enough points were checked to count the top 3." : `In the top 3 at ${row.visible} of ${row.measured} points`}</span>
      </div>
      <div className="sx-grid" role="table" aria-label={`${label}: where the business showed, from nine points around it. The top left is the north-west.`}>
        {[0, 1, 2].map((r) => (
          <div className="sx-grid-row" role="row" key={r}>
            {cells.slice(r * 3, r * 3 + 3).map((c, i) => <span key={i} role="cell" className={`sx-cell ${c.tone}`}>{c.label}</span>)}
          </div>
        ))}
      </div>
      <p className="small muted sx-term-note">
        {termMovement(row) === "first check" ? "First check for this term." : `Against the check on ${dayLabel(row.previous?.takenOn ?? null) ?? "an earlier day"}: ${termMovement(row)}.`}
      </p>
    </li>
  );
}

/** The latest rank check of every term that is on, with what changed since the check before. Ranks are only ever "in our check". */
export function Ranks({ clientId, data, canCheck, onChanged }: { clientId: string; data: SeoOverview; canCheck: boolean; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [error, setError] = useState("");
  async function check() {
    if (busy) return;
    setBusy(true); setOk(""); setError("");
    try {
      const r = await seoApi.rankCheck(clientId);
      setOk(`${r.checked} ${r.checked === 1 ? "term" : "terms"} checked${r.unmeasured > 0 ? `, ${r.unmeasured} without enough points to count` : ""}.`);
      await onChanged();
    } catch (e) { setError(sentence(e, "Couldn’t run the rank check. Try again.")); }
    finally { setBusy(false); }
  }
  const takenOn = data.latestGrid.map((g) => g.takenOn).sort().at(-1) ?? null;
  return (
    <Part title="Where the business shows" help={takenOn ? `In our check on ${dayLabel(takenOn) ?? takenOn}. Google was searched from nine points around the business; each cell says which part of the results the business was in from that point.` : "No rank check yet."}
      actions={canCheck ? <button type="button" className="btn sm" aria-disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check ranks now"}</button> : undefined}>
      {data.latestGrid.length === 0 && <p className="small muted">{data.keywords.some((k) => k.active) ? "Nothing has been checked yet. Take the baseline, or check the ranks now." : "Add a search term first."}</p>}
      <ul className="sx-terms">{data.latestGrid.map((g) => <Grid key={`${g.term}|${g.town ?? ""}`} row={g} />)}</ul>
      <Say ok={ok} error={error} />
    </Part>
  );
}

/** The Google listing's numbers from the latest snapshot; a number that is not known is left out. */
export function Snapshot({ snapshot }: { snapshot: SeoOverview["snapshot"] }) {
  const facts = snapshot ? snapshotFacts(snapshot) : [];
  return (
    <Part title="Google profile" help={snapshot ? `As of ${dayLabel(snapshot.takenOn) ?? snapshot.takenOn}.` : undefined}>
      {!snapshot && <p className="small muted">No snapshot yet. It is taken with the baseline.</p>}
      {snapshot && facts.length === 0 && <p className="small muted">Google gave no numbers for this listing.</p>}
      {facts.length > 0 && <dl className="sx-facts">{facts.flatMap((f) => [<dt key={`${f.label}-t`}>{f.label}</dt>, <dd key={`${f.label}-d`}>{f.value}</dd>])}</dl>}
    </Part>
  );
}

/** Whether the client's own site says what the Google listing says: name, address and phone. */
export function NapBlock({ clientId, nap, canCheck, onChecked }: { clientId: string; nap: SeoOverview["nap"]; canCheck: boolean; onChecked: Patch }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function check() {
    if (busy) return;
    setBusy(true); setError("");
    try { onChecked({ nap: await seoApi.napCheck(clientId) }); }
    catch (e) { setError(sentence(e, "Couldn’t run the check. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <Part title="Name, address and phone" help="Does the client’s own site say what the Google listing says?"
      actions={canCheck ? <button type="button" className="btn sm" aria-disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check the site now"}</button> : undefined}>
      {!nap && <p className="small muted">Not checked yet.</p>}
      {nap && (
        <>
          <ul className="sx-nap">
            {napLines(nap).map((l) => <li key={l.label}><span className={`badge2 ${l.tone}`}><i className="dot" aria-hidden="true" />{l.line}</span></li>)}
          </ul>
          <p className="small muted">Read {nap.checkedPages} {nap.checkedPages === 1 ? "page" : "pages"} of the site.</p>
        </>
      )}
      <Say error={error} />
    </Part>
  );
}

function CitationRow({ clientId, c, onSaved }: { clientId: string; c: SeoOverview["citations"][number]; onSaved: (all: SeoOverview["citations"]) => void }) {
  const [url, setUrl] = useState(c.url ?? "");
  const [note, setNote] = useState(c.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function save(next: { status: typeof c.status }) {
    if (busy) return;
    setBusy(true); setError(""); setSaved(false);
    try { onSaved(await seoApi.setCitation(clientId, c.directory, { status: next.status, ...(url.trim() !== (c.url ?? "") && url.trim() ? { url: url.trim() } : {}), ...(note !== c.note ? { note } : {}) })); setSaved(true); }
    catch (e) { setError(sentence(e, "Couldn’t save that. Try again.")); }
    finally { setBusy(false); }
  }
  const href = safeHref(c.url);
  return (
    <li className="sx-cit">
      <div className="sx-cit-head">
        <b>{c.directory}</b>
        <span className="small muted">{citationLabel(c.status)}{c.checkedOn ? ` · ${dayLabel(c.checkedOn) ?? c.checkedOn}` : ""}</span>
      </div>
      <div className="seg-pills sx-cit-status" role="group" aria-label={`${c.directory}: status`}>
        {CITATION_STATUSES.map((s) => <button key={s} type="button" aria-pressed={c.status === s} onClick={() => { if (c.status !== s) void save({ status: s }); }}>{citationLabel(s)}</button>)}
      </div>
      <details className="sx-more">
        <summary>Link and note{c.url || c.note ? "" : " (none yet)"}</summary>
        <div className="sx-cit-fields">
          <label className="deal-field" htmlFor={`cu-${c.id}`}><span>Link to the listing</span>
            <input id={`cu-${c.id}`} inputMode="url" value={url} maxLength={500} placeholder="https://" autoComplete="off" onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="deal-field" htmlFor={`cn-${c.id}`}><span>Note</span>
            <input id={`cn-${c.id}`} value={note} maxLength={500} autoComplete="off" onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="button" className="btn" aria-disabled={busy} onClick={() => void save({ status: c.status })}>Save link and note</button>
        </div>
        {href && <p className="small"><a href={href} target="_blank" rel="noopener noreferrer">Open the listing</a></p>}
      </details>
      <Say error={error} ok={saved ? "Saved." : undefined} />
    </li>
  );
}

/** The directories the client should be listed in, each with its status buttons and an optional link and note. The status is Logan's own word for it: nothing here submits a listing anywhere. */
export function Citations({ clientId, citations, onChanged }: { clientId: string; citations: SeoOverview["citations"]; onChanged: Patch }) {
  const listed = citations.filter((c) => c.status === "listed").length;
  return (
    <Part title="Directories" help={citations.length ? `${listed} of ${citations.length} marked listed. These are marked by hand; nothing is submitted from here.` : undefined}>
      {citations.length === 0 && <p className="small muted">The list appears when the profile is saved.</p>}
      <ul className="sx-cits">{citations.map((c) => <CitationRow key={c.id} clientId={clientId} c={c} onSaved={(all) => onChanged({ citations: all })} />)}</ul>
    </Part>
  );
}
