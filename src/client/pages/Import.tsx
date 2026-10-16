import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import Icon from "../components/Icon";
import { announceLeadsChanged } from "../components/Shell";
import {
  COLUMNS, COLUMN_LABEL, KIND_LABEL, KIND_TONE, MAX_FILE_BYTES, choiceCounts, choiceOptions, commitSummary, defaultChoice, detectColumns, foundParts, importErrorText,
  inputBody, inputName, isLocked, isSingleAddress, sourceLine, stepOf, toCommitRows, type Choice, type Step,
} from "../importView";
import type { ImportCommitResult, ImportPreviewRow } from "../types";

const host = (u: string | null) => (u ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
const STEPS: { key: Step; label: string }[] = [{ key: "add", label: "Add leads" }, { key: "review", label: "Review" }, { key: "done", label: "Done" }];

/** Bring in businesses you already know about: add (paste or upload), review every row against your leads, then import. */
export default function Import() {
  const [raw, setRaw] = useState(""); const [name, setName] = useState(""); const [source, setSource] = useState("Referral");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportPreviewRow[] | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [previewing, setPreviewing] = useState(false); const [committing, setCommitting] = useState(false);
  const [err, setErr] = useState(""); const [fileErr, setFileErr] = useState("");
  const [drag, setDrag] = useState(false);
  const [doneLine, setDoneLine] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  function readFile(f: File | undefined) {
    setFileErr("");
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) { setFileErr(`${f.name} is over 1 MB. Split it into smaller files.`); return; }
    const reader = new FileReader();
    reader.onload = () => { if (alive.current) { setRaw(String(reader.result ?? "")); setFileName(f.name); setRows(null); setResult(null); setErr(""); } };
    reader.onerror = () => { if (alive.current) setFileErr(`Couldn't read ${f.name}.`); };
    reader.readAsText(f);
  }
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // choosing the same file again should still fire
    readFile(f);
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
      setResult(r); setDoneLine(`${inputName(fileName, raw)} · ${sourceLine(rows.length, source)}`); announceLeadsChanged();
    } catch (x) { if (alive.current) setErr(importErrorText(x, "Couldn't import. Nothing may have been saved: check All leads before trying again.")); }
    finally { if (alive.current) setCommitting(false); }
  }

  const reset = () => { setResult(null); setRows(null); setRaw(""); setName(""); setFileName(""); setErr(""); setFileErr(""); };
  const step = stepOf(rows, result);
  const counts = rows ? choiceCounts(rows, choices) : null;
  const doing = counts ? counts.create + counts.link : 0;
  const canPreview = !previewing && raw.trim().length > 0 && source.trim().length > 0;

  return (
    <div className="im">
      <header className="page-header">
        <div><h1>Import leads</h1><p>Paste web addresses or upload a CSV with name, website, address, phone and category columns.</p></div>
      </header>
      <div className="im-body">
        <Steps step={step} />
        {step === "add" && (
          <AddStep raw={raw} name={name} source={source} fileName={fileName} fileErr={fileErr} drag={drag}
            onRaw={(v) => { setRaw(v); setFileName(""); setRows(null); setErr(""); }} onName={setName} onSource={(v) => { setSource(v); setErr(""); }}
            onFile={onFile} onDrag={setDrag} onDrop={readFile} onClearFile={() => { setRaw(""); setFileName(""); setFileErr(""); }} />
        )}
        {step === "review" && rows && counts && (
          <Review rows={rows} choices={choices} counts={counts} summary={{ title: inputName(fileName, raw), line: sourceLine(rows.length, source) }} err={err}
            onChoice={(i, v) => setChoices((c) => ({ ...c, [i]: v }))} onEdit={() => { setRows(null); setErr(""); }} />
        )}
        {step === "done" && result && <Done result={result} line={doneLine} />}
      </div>

      <div className="im-bar">
        {step === "add" && <>
          {err ? <p className="im-bar-err" role="alert"><Icon name="alert" size={14} />{err}</p>
            : <p className="im-hint">You review every row before anything is saved.</p>}
          <button type="button" className="btn primary" onClick={preview} disabled={!canPreview}>
            <Icon name="eye" size={16} />{previewing ? "Checking…" : "Preview"}
          </button>
        </>}
        {step === "review" && counts && <>
          <p className="im-tally" role="status">
            <span><i className="dot create" /><b className="num-mono">{counts.create}</b>to create</span>
            <span><i className="dot link" /><b className="num-mono">{counts.link}</b>to link</span>
            <span><i className="dot skip" /><b className="num-mono">{counts.skip}</b>skipped</span>
            {counts.undecided > 0 && <span><i className="dot ask" /><b className="num-mono">{counts.undecided}</b>needs a decision</span>}
          </p>
          <button type="button" className="btn-plain" onClick={() => { setRows(null); setErr(""); }} disabled={committing}><Icon name="chevron-left" size={16} />Back to edit</button>
          <button type="button" className="btn primary" onClick={commit} disabled={committing || doing === 0}>
            <Icon name="upload" size={16} />{committing ? "Importing…" : doing === 0 ? "Nothing to import" : `Import ${doing} ${doing === 1 ? "row" : "rows"}`}
          </button>
        </>}
        {step === "done" && result && <>
          <p className="im-hint">{result.auditsQueued > 0 ? "Quick scans are running. Scored leads show up under Promising as they finish." : "Nothing new was added to scan."}</p>
          <button type="button" className="btn-plain" onClick={reset}><Icon name="plus" size={16} />Import more</button>
          {result.searchId && <Link className="btn" to={`/searches/${result.searchId}`}>This import</Link>}
          {result.auditsQueued > 0 && <Link className="btn" to="/promising">Promising</Link>}
          <Link className="btn primary" to="/leads">All leads</Link>
        </>}
      </div>
    </div>
  );
}

/** Add leads → Review → Done. */
function Steps({ step }: { step: Step }) {
  const at = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="im-steps" aria-label="Import steps">
      {STEPS.map((s, i) => {
        const done = i < at || (step === "done" && i === at), current = i === at && step !== "done";
        return (
          <li key={s.key} className={done ? "done" : current ? "current" : ""} aria-current={current ? "step" : undefined}>
            <span className="im-dot">{done ? <Icon name="check" size={12} /> : i + 1}</span>{s.label}
            <span className="sr-only">{done ? " (done)" : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}

function AddStep({ raw, name, source, fileName, fileErr, drag, onRaw, onName, onSource, onFile, onDrag, onDrop, onClearFile }: {
  raw: string; name: string; source: string; fileName: string; fileErr: string; drag: boolean;
  onRaw: (v: string) => void; onName: (v: string) => void; onSource: (v: string) => void; onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDrag: (on: boolean) => void; onDrop: (f: File | undefined) => void; onClearFile: () => void;
}) {
  const single = isSingleAddress(raw);
  const cols = detectColumns(raw);
  return (
    <section className="im-card" aria-label="Add leads">
      <div className="im-field">
        <label htmlFor="import-text">Website addresses or CSV</label>
        <textarea id="import-text" rows={8} value={raw} spellCheck={false} placeholder={"acme.com\n\nor a CSV with a header row:\n\nname,website\nAcme Roofing,https://acme.com"} onChange={(e) => onRaw(e.target.value)} />
        <div className="im-detect" aria-live="polite">
          {cols ? <>
            <span className="im-detect-label">Columns we found</span>
            {COLUMNS.map((c) => <span key={c} className={`im-col${cols.found.includes(c) ? " on" : ""}`}>{cols.found.includes(c) && <Icon name="check" size={12} />}{COLUMN_LABEL[c]}</span>)}
            {!cols.hasName && <span className="im-detect-warn"><Icon name="alert" size={13} />The first line needs a name column, for example name,website</span>}
          </> : single && raw.trim() ? <span className="im-detect-label">One web address. It is named after its domain unless you give a name below.</span>
            : <span className="im-detect-label">Paste one address, or a CSV whose first line names the columns: name is required, the rest are optional.</span>}
        </div>
      </div>

      <label className={`im-drop${drag ? " over" : ""}`} onDragOver={(e) => { e.preventDefault(); onDrag(true); }} onDragLeave={() => onDrag(false)}
        onDrop={(e) => { e.preventDefault(); onDrag(false); onDrop(e.dataTransfer.files?.[0]); }}>
        <input id="import-file" type="file" className="sr-only" accept=".csv,text/csv,text/plain" onChange={onFile} />
        <span className="im-drop-ic"><Icon name="upload" size={16} /></span>
        <span className="im-drop-t"><b>{fileName ? fileName : "Choose a CSV file"}</b><small>{fileName ? "Loaded into the box above. Choose another to replace it." : "or drop it here. 1 MB at most, 500 rows."}</small></span>
        {fileName && <button type="button" className="btn-ghost-sm" onClick={(e) => { e.preventDefault(); onClearFile(); }}><Icon name="x" size={14} />Remove</button>}
      </label>
      {fileErr && <p className="im-note" role="alert"><Icon name="alert" size={14} />{fileErr}</p>}

      <div className={`im-two${single && raw.trim() ? " three" : ""}`}>
        <div className="im-field">
          <label htmlFor="import-source">Source</label>
          <input id="import-source" value={source} maxLength={80} placeholder="Referral" onChange={(e) => onSource(e.target.value)} />
          <small>Where these leads came from. It is saved on each lead.</small>
        </div>
        {single && raw.trim() && (
          <div className="im-field">
            <label htmlFor="import-name">Business name <span>(optional)</span></label>
            <input id="import-name" value={name} maxLength={200} placeholder={host(raw.trim()) || "acme.com"} onChange={(e) => onName(e.target.value)} />
            <small>Left empty, the lead is named after its web address.</small>
          </div>
        )}
      </div>
    </section>
  );
}

function Review({ rows, choices, counts, summary, err, onChoice, onEdit }: {
  rows: ImportPreviewRow[]; choices: Record<number, Choice>; counts: ReturnType<typeof choiceCounts>; summary: { title: string; line: string }; err: string;
  onChoice: (index: number, v: Choice) => void; onEdit: () => void;
}) {
  return (
    <>
      <div className="im-file">
        <span className="im-file-ic"><Icon name="file-text" size={16} /></span>
        <div><b title={summary.title}>{summary.title}</b><small>{summary.line}</small></div>
        <button type="button" className="btn-ghost-sm" onClick={onEdit}><Icon name="pen" size={16} />Edit</button>
      </div>
      {err && <p className="im-note" role="alert"><Icon name="alert" size={14} />{err}</p>}
      <div className="im-head">
        <h2>Review {rows.length} {rows.length === 1 ? "row" : "rows"}</h2>
        {counts.undecided > 0 && <span className="badge2 warning"><i className="dot" />{counts.undecided} {counts.undecided === 1 ? "needs" : "need"} a decision</span>}
        <small>We check every row against your leads and suppressions</small>
      </div>
      <div className="im-scroll">
        <div className="im-table" role="table" aria-label="Rows to import">
          <div className="im-tr im-th" role="row">
            <span role="columnheader">#</span><span role="columnheader">Business</span><span role="columnheader">Status</span><span role="columnheader">What we found</span><span role="columnheader">Action</span>
          </div>
          {rows.map((r) => {
            const n = r.index + 1, locked = isLocked(r.kind), choice = choices[r.index] ?? defaultChoice(r), undecided = !locked && choice === "";
            return (
              <div key={r.index} className={`im-tr${undecided ? " ask" : ""}`} role="row">
                <span role="cell" className="im-n">{n}</span>
                <span role="cell" className="im-biz"><b title={r.row.name}>{r.row.name || "No name"}</b><small title={r.row.url ?? ""}>{host(r.row.url) || "no website"}</small></span>
                <span role="cell"><span className={`badge2 ${KIND_TONE[r.kind]}`}><i className="dot" />{KIND_LABEL[r.kind]}</span></span>
                <span role="cell" className={`im-found${r.kind === "exact" ? " link" : ""}`}>
                  {foundParts(r).map((p, i) => p.id
                    ? <Link key={i} to={`/leads/${p.id}`} target="_blank" rel="noreferrer">{p.text}</Link>
                    : <span key={i}>{p.text}</span>)}
                </span>
                <span role="cell">
                  {locked ? <span className="im-sel locked">Skipped</span> : (
                    <label className={`im-sel${undecided ? " ask" : ""}`}>
                      <select aria-label={`Action for row ${n}: ${r.row.name || "no name"}`} value={choice} onChange={(e) => onChoice(r.index, e.target.value)}>
                        {choiceOptions(r).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <Icon name="chevron-down" size={13} />
                    </label>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/** What the import did: counts, then anything that was refused, failed or needs a heads-up. */
function Done({ result, line }: { result: ImportCommitResult; line: string }) {
  const problems = result.failures.length > 0 || result.refused.length > 0 || (result.warnings?.length ?? 0) > 0;
  return (
    <section className="im-card" role="status" aria-label="Import finished">
      <div className="im-fin">
        <span className="im-fin-ic"><Icon name="check" size={16} /></span>
        <div><h2>Import finished</h2><small>{line}</small></div>
      </div>
      <ul className="im-lines">{commitSummary(result).map((l) => <li key={l}><Icon name="check" size={14} />{l}</li>)}</ul>
      {problems && (
        <div className="im-issues">
          {result.refused.length > 0 && <div><h3>Not imported (suppressed)</h3>
            <ul>{result.refused.map((x) => <li key={x.index}>Row {x.index + 1}, {x.name}: {x.reason}</li>)}</ul></div>}
          {result.failures.length > 0 && <div className="bad" role="alert"><h3>Problems</h3>
            <ul>{result.failures.map((x, i) => <li key={i}>Row {x.index + 1}, {x.name}: {x.error}</li>)}</ul>
            {result.failures.some((f) => f.kind === "audit") && <p>A lead without a quick scan is still in All leads. Open it and use Re-audit to scan it.</p>}</div>}
          {(result.warnings?.length ?? 0) > 0 && <div className="warn"><h3>Heads up</h3><ul>{result.warnings!.map((w) => <li key={w}>{w}</li>)}</ul></div>}
        </div>
      )}
    </section>
  );
}
