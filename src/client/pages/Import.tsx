import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import {
  KIND_LABEL, MAX_FILE_BYTES, choiceCounts, choiceOptions, commitSummary, defaultChoice, importErrorText, inputBody, isLocked, isSingleAddress, toCommitRows,
  type Choice,
} from "../importView";
import type { ImportCommitResult, ImportPreviewRow } from "../types";

const host = (u: string | null) => (u ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

export default function Import() {
  const [raw, setRaw] = useState(""); const [name, setName] = useState(""); const [source, setSource] = useState("Referral");
  const [rows, setRows] = useState<ImportPreviewRow[] | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [previewing, setPreviewing] = useState(false); const [committing, setCommitting] = useState(false);
  const [err, setErr] = useState(""); const [fileErr, setFileErr] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // choosing the same file again should still fire
    setFileErr("");
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) { setFileErr(`${f.name} is over 1 MB. Split it into smaller files.`); return; }
    const reader = new FileReader();
    reader.onload = () => { if (alive.current) { setRaw(String(reader.result ?? "")); setRows(null); setResult(null); } };
    reader.onerror = () => { if (alive.current) setFileErr(`Couldn't read ${f.name}.`); };
    reader.readAsText(f);
  }

  async function preview() {
    setPreviewing(true); setErr(""); setResult(null);
    try {
      const r = await api.post<{ rows: ImportPreviewRow[] }>("/import/preview", inputBody(raw, name, source));
      if (!alive.current) return;
      setRows(r.rows);
      setChoices(Object.fromEntries(r.rows.map((x) => [x.index, defaultChoice(x)])));
    } catch (x) { if (alive.current) { setRows(null); setErr(importErrorText(x, "Couldn't preview the import.")); } }
    finally { if (alive.current) setPreviewing(false); }
  }

  async function commit() {
    if (!rows) return;
    setCommitting(true); setErr("");
    try {
      const r = await api.post<ImportCommitResult>("/import/commit", { source: source.trim(), rows: toCommitRows(rows, choices) });
      if (!alive.current) return;
      setResult(r); setRows(null); setRaw(""); setName("");
    } catch (x) { if (alive.current) setErr(importErrorText(x, "Couldn't import. Nothing may have been saved: check All leads before trying again.")); }
    finally { if (alive.current) setCommitting(false); }
  }

  const counts = rows ? choiceCounts(rows, choices) : null;
  const doing = counts ? counts.create + counts.link : 0;
  const single = isSingleAddress(raw);
  const canPreview = !previewing && raw.trim().length > 0 && source.trim().length > 0;

  return (
    <div>
      <h2>Import leads</h2>
      <p className="muted">
        Add businesses you already know about, from a referral or a list. Paste one website address, or paste or upload a CSV with a header row:
        {" "}<code>name</code>, <code>website</code> (or <code>url</code>), and optionally <code>address</code>, <code>phone</code>, <code>category</code>.
        You review every row before anything is saved. Each new lead gets a quick scan (crawl and score only), then shows up under <Link to="/promising">Promising</Link>.
      </p>

      <div className="card import-form">
        <label htmlFor="import-text">Website address or CSV</label>
        <textarea id="import-text" rows={6} value={raw} spellCheck={false} placeholder={"acme.com\n\nor\n\nname,website\nAcme Roofing,https://acme.com"}
          onChange={(e) => { setRaw(e.target.value); setRows(null); setErr(""); }} />
        <div className="field-row">
          <div>
            <label htmlFor="import-file">Or choose a CSV file</label>
            <input id="import-file" type="file" accept=".csv,text/csv,text/plain" onChange={onFile} />
          </div>
          <div>
            <label htmlFor="import-source">Source</label>
            <input id="import-source" value={source} maxLength={80} onChange={(e) => { setSource(e.target.value); setErr(""); }} />
          </div>
        </div>
        {single && raw.trim() && (
          <div>
            <label htmlFor="import-name">Business name <span className="muted">(optional)</span></label>
            <input id="import-name" value={name} maxLength={200} placeholder={host(raw.trim()) || "acme.com"} onChange={(e) => setName(e.target.value)} />
            <p className="muted small">Left empty, the lead is named after its web address.</p>
          </div>
        )}
        {fileErr && <p className="error" role="alert">{fileErr}</p>}
        <p className="row">
          <button className="primary" onClick={preview} disabled={!canPreview}>{previewing ? "Checking…" : "Preview"}</button>
          {rows === null && err && <span className="error" role="alert">{err}</span>}
        </p>
      </div>

      {rows && counts && (
        <div className="card import-preview">
          <h3>Review {rows.length} {rows.length === 1 ? "row" : "rows"}</h3>
          <div className="table-wrap"><table className="import-table">
            <thead><tr><th>#</th><th>Business</th><th>Status</th><th>Details</th><th>Action</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const n = r.index + 1, locked = isLocked(r.kind);
                return (
                  <tr key={r.index}>
                    <td className="muted">{n}</td>
                    <td className="cell-name">
                      <strong title={r.row.name}>{r.row.name || "(no name)"}</strong>
                      {r.nameDerived && <div className="sub">Named after its web address</div>}
                      <div className="sub" title={r.row.url ?? ""}>{host(r.row.url) || "no website"}</div>
                    </td>
                    <td><span className={`badge imp-${r.kind}`}>{KIND_LABEL[r.kind]}</span></td>
                    <td className="small">
                      {r.reason && <div>{r.reason}</div>}
                      {r.candidates.length > 0 && <ul className="plain">{r.candidates.map((c) => (
                        <li key={c.id}><Link to={`/leads/${c.id}`} target="_blank" rel="noreferrer">{c.name}</Link>
                          <span className="muted"> {c.domain ?? "no website"}{c.archived_at ? " · archived" : ""}</span></li>
                      ))}</ul>}
                    </td>
                    <td>
                      {locked ? <span className="muted">Skipped</span> : (
                        <select aria-label={`Action for row ${n}: ${r.row.name}`} className={choices[r.index] === "" ? "undecided" : ""}
                          value={choices[r.index] ?? defaultChoice(r)} onChange={(e) => setChoices((c) => ({ ...c, [r.index]: e.target.value }))}>
                          {choiceOptions(r).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          <p className="import-tally" role="status">
            {counts.create} to create, {counts.link} to link, {counts.skip} skipped.
            {counts.undecided > 0 && <span className="warn-text"> {counts.undecided} {counts.undecided === 1 ? "row needs" : "rows need"} a decision and will be skipped.</span>}
          </p>
          <p className="row">
            <button className="primary" onClick={commit} disabled={committing || doing === 0}>
              {committing ? "Importing…" : doing === 0 ? "Nothing to import" : `Import ${doing} ${doing === 1 ? "row" : "rows"}`}
            </button>
            <button onClick={() => { setRows(null); setErr(""); }} disabled={committing}>Back to edit</button>
            {err && <span className="error" role="alert">{err}</span>}
          </p>
        </div>
      )}

      {result && (
        <div className="card import-result" role="status">
          <h3>Import finished</h3>
          <ul className="plain">{commitSummary(result).map((l) => <li key={l}>{l}</li>)}</ul>
          {result.refused.length > 0 && <>
            <h4>Not imported (suppressed)</h4>
            <ul className="plain">{result.refused.map((x) => <li key={x.index}>Row {x.index + 1}, {x.name}: {x.reason}</li>)}</ul>
          </>}
          {result.failures.length > 0 && <>
            <h4>Problems</h4>
            <ul className="plain error" role="alert">{result.failures.map((x, i) => <li key={i}>Row {x.index + 1}, {x.name}: {x.error}</li>)}</ul>
            {result.failures.some((f) => f.kind === "audit") && <p className="muted small">A lead without a quick scan is still in All leads. Open it and use Re-audit to scan it.</p>}
          </>}
          <p className="row">
            <Link to="/leads">All leads</Link>
            {result.searchId && <Link to={`/searches/${result.searchId}`}>This import</Link>}
            {result.auditsQueued > 0 && <Link to="/promising">Promising</Link>}
          </p>
        </div>
      )}
    </div>
  );
}
