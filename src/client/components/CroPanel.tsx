import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { pollDelay } from "../poll";
import {
  EVIDENCE_FAMILY_LABEL, STEP_LABEL, neighborOf, rebuildNeedsPatch, splitRoadmap, stepIndex,
  type AssumptionOverrides, type CroAudit, type CroHistoryRow, type CroItem, type CroResponse, type Horizon, type ScenarioInputs,
} from "../cro";
import CroItemCard, { type CroItemPatch } from "./CroItemCard";
import { CroScenario, CroSnapshot } from "./CroSnapshot";

const HORIZONS: readonly (readonly [Horizon, string])[] = [[30, "Also this month"], [60, "Days 31–60"], [90, "Days 61–90"]];

const messageOf = (e: unknown) =>
  e instanceof ApiError && e.status === 402 ? "That would go over your monthly spend limit (see Settings)." : (e as Error).message || "Something went wrong";

export default function CroPanel({ leadId, onError }: { leadId: string; onError: (m: string) => void }) {
  const [data, setData] = useState<CroResponse | null>(null);
  const [history, setHistory] = useState<CroHistoryRow[]>([]);
  const [busy, setBusy] = useState("");
  const [moving, setMoving] = useState(false);
  const [evidence, setEvidence] = useState<string[] | "all" | null>(null); // evidence ids to show, or "all"
  const [rebuildOwed, setRebuildOwed] = useState<string | null>(null); // audit id whose edits are saved but whose rebuild was refused
  const [tick, setTick] = useState(0);
  const [lagging, setLagging] = useState(false);
  const failures = useRef(0);
  const seq = useRef(0); // the newest load wins; older responses (a slow poll, a previous lead) are dropped
  const opener = useRef<HTMLElement | null>(null);
  const drawer = useRef<HTMLElement | null>(null);

  async function load(auditId?: string) {
    const mine = ++seq.current;
    const r = await api.get<CroResponse>(`/leads/${leadId}/cro-audit${auditId ? `?audit=${encodeURIComponent(auditId)}` : ""}`);
    if (mine !== seq.current) return;
    setData(r);
    api.get<CroHistoryRow[]>(`/leads/${leadId}/cro-audits`).then((h) => { if (mine === seq.current) setHistory(h); }).catch(() => { if (mine === seq.current) setHistory([]); });
  }

  useEffect(() => {
    setData(null); setHistory([]); setEvidence(null); setRebuildOwed(null); setLagging(false); failures.current = 0;
    load().catch((e) => onError(messageOf(e)));
    return () => { seq.current++; };
  }, [leadId]);

  // While an audit runs, poll for progress; a failed poll backs off (4s, 8s, 15s) and never interrupts the page.
  useEffect(() => {
    const a = data?.audit;
    if (a?.status !== "running") return;
    const t = setTimeout(() => load(a.id)
      .then(() => { failures.current = 0; setLagging(false); })
      .catch(() => { failures.current++; setLagging(true); setTick((n) => n + 1); }), pollDelay(failures.current));
    return () => clearTimeout(t);
  }, [data, tick]);

  useEffect(() => { if (evidence) drawer.current?.focus(); }, [evidence]);

  /** Runs a server action, then reloads. A failure is shown with the server's message and the page re-syncs
   *  (a 409 means the audit is in fact running; a 502 means it was marked failed). */
  async function act(name: string, fn: () => Promise<unknown>, reloadId?: string): Promise<boolean> {
    setBusy(name);
    try { await fn(); await load(reloadId); return true; }
    catch (e) { onError(messageOf(e)); load(reloadId).catch(() => {}); return false; }
    finally { setBusy(""); }
  }
  const run = () => act("run", () => api.post(`/leads/${leadId}/cro-audit`));

  const items = data?.items;
  const split = useMemo(() => splitRoadmap(items ?? []), [items]);

  const openEvidence = (ids: string[] | "all", from: HTMLElement | null) => { opener.current = from; setEvidence(ids); };
  const closeEvidence = () => {
    setEvidence(null);
    const o = opener.current; opener.current = null;
    if (o?.isConnected) o.focus();
  };

  if (!data) return <div className="card" role="status">Loading…</div>;
  const a = data.audit;

  const picker = (cur: CroAudit) => {
    const rows = history.some((h) => h.id === cur.id) ? history
      : [{ id: cur.id, status: cur.status, created_at: cur.created_at, completed_at: cur.completed_at, item_count: data.items.length }, ...history];
    return (
      <label className="row small cro-pick">Audit
        <select className="auto" value={cur.id} onChange={(e) => { setRebuildOwed(null); load(e.target.value).catch((x) => onError(messageOf(x))); }}>
          {rows.map((h) => <option key={h.id} value={h.id}>{new Date(h.created_at).toLocaleString()} · {h.status}{h.status === "done" ? ` · ${h.item_count} items` : ""}</option>)}
        </select>
      </label>
    );
  };

  if (!a) return (
    <div className="card cro-empty">
      <h3>CRO audit</h3>
      <p>A deeper scan of up to 7 key pages on desktop and phone. It works out how this business makes money, then builds a specific roadmap: what to fix this month, the next 90 days, what to measure, and what it could be worth.</p>
      <p className="muted small">Takes about 2–4 minutes and roughly $0.15–0.40.</p>
      <button className="primary" onClick={run} disabled={!!busy}>{busy ? "Starting…" : "Run CRO audit"}</button>
    </div>
  );

  if (a.status === "running") {
    const cur = Math.min(Math.max(stepIndex(a.step), 0), STEP_LABEL.length - 1);
    return (
      <div className="card">
        <h3>CRO audit running…</h3>
        <p className="small" role="status" aria-live="polite">Step {cur + 1} of {STEP_LABEL.length}: {STEP_LABEL[cur][1]}</p>
        <ol className="cro-steps">{STEP_LABEL.map(([s, label], i) => (
          <li key={s} className={i < cur ? "done" : i === cur ? "on" : ""} aria-current={i === cur ? "step" : undefined}>
            {label}{i < cur && <span className="sr-only"> (done)</span>}
          </li>))}</ol>
        <p className="muted small">You can leave this page; it keeps going.</p>
        {lagging && <p className="muted small" role="status">Having trouble checking progress. Trying again shortly.</p>}
      </div>
    );
  }

  if (a.status === "failed") return (
    <div className="card">
      <div className="cro-bar"><h3>CRO audit didn't finish</h3>{history.length > 1 && picker(a)}</div>
      <p className="error">{a.error}</p>
      <div className="row">
        <button className="primary" onClick={() => act("retry", () => api.post(`/cro-audits/${a.id}/retry`), a.id)} disabled={!!busy}>{busy === "retry" ? "Retrying…" : "Retry from where it stopped"}</button>
        <button onClick={run} disabled={!!busy}>{busy === "run" ? "Starting…" : "Start over"}</button>
      </div>
    </div>
  );

  const sorted = [...data.items].sort((x, y) => x.rank - y.rank);
  const visible = sorted.filter((i) => i.included);
  const patch = async (item: CroItem, p: CroItemPatch): Promise<boolean> => {
    try {
      const u = await api.patch<CroItem>(`/cro-items/${item.id}`, p);
      setData((d) => d && { ...d, items: d.items.map((i) => (i.id === u.id ? u : i)) });
      return true;
    } catch (e) { onError(messageOf(e)); return false; }
  };
  const move = async (item: CroItem, dir: -1 | 1) => {
    const other = neighborOf(split, item, dir);
    if (!other) return;
    // Swap the two ranks. If the second write fails the first is already saved, so re-sync from the server.
    const [mine, theirs] = [item.rank, other.rank];
    setMoving(true);
    try { if (await patch(item, { rank: theirs }) && !(await patch(other, { rank: mine }))) await load(a.id).catch(() => {}); }
    finally { setMoving(false); }
  };
  const card = (it: CroItem, n: number | undefined, compact = false) => (
    <CroItemCard key={it.id} audit={a} item={it} n={n} compact={compact} disabled={moving}
      canUp={!!neighborOf(split, it, -1)} canDown={!!neighborOf(split, it, 1)}
      onPatch={(p) => patch(it, p)} onMove={(d) => void move(it, d)} onEvidence={openEvidence} />
  );
  const roadmap = HORIZONS.map(([h, label]) => [h, label, split.columns[h]] as const);
  // Keyed on the numbers (not the saved flag) so an assumptions edit that moves them refreshes the form, but the user's own Save doesn't remount it.
  const sc = a.scenario_inputs;
  const scenarioKey = sc ? [sc.visitors, sc.currentRate, sc.targetRate, sc.closeRate, sc.dealValue].join("-") : "";
  const evidenceShown = evidence ? a.evidence.filter((e) => evidence === "all" || evidence.includes(e.id)) : [];

  return (
    <div className="cro">
      <div className="cro-bar">
        {picker(a)}
        <span className="row">
          <button className="link-btn" onClick={(e) => openEvidence("all", e.currentTarget)}>All evidence ({a.evidence.length})</button>
          <button onClick={run} disabled={!!busy} title="Starts a fresh scan; roughly $0.15–0.40">{busy === "run" ? "Starting…" : "Run again"}</button>
        </span>
      </div>
      {a.error && (
        <div className="row">
          <p className="error small">The last update didn't finish, so this is the previous version of the roadmap. {a.error}</p>
          <button onClick={() => act("rebuild", () => api.post(`/cro-audits/${a.id}/rebuild`), a.id)} disabled={!!busy}>{busy === "rebuild" ? "Trying again…" : "Try again"}</button>
        </div>
      )}
      {a.warning && <p className="warn">⚠ {a.warning}</p>}
      {a.partial && <p className="muted small">⚠ Some pages couldn't be loaded; the roadmap covers the rest.</p>}

      <CroSnapshot key={`${a.id}-${a.completed_at}`} audit={a} busy={busy === "rebuild"} rebuildOwed={rebuildOwed === a.id} onRebuild={(overrides: AssumptionOverrides) => act("rebuild", async () => {
        if (rebuildNeedsPatch(overrides)) await api.patch(`/cro-audits/${a.id}/assumptions`, { overrides });
        setRebuildOwed(a.id); // saved; a rebuild is owed until the server accepts it (a 402/409 leaves the button up for a retry)
        await api.post(`/cro-audits/${a.id}/rebuild`);
        setRebuildOwed(null);
      }, a.id)} />

      {a.strengths.length > 0 && <section className="card"><h3>What already works</h3><ul>{a.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul></section>}

      <h3>Do this month</h3>
      {split.month.length === 0 && <p className="muted small">Nothing is included for this month.</p>}
      {split.month.map((it, i) => card(it, i + 1))}

      {roadmap.some(([, , col]) => col.length > 0) && <section>
        <h3>90-day roadmap</h3>
        <div className="cro-cols">{roadmap.map(([h, label, col]) => (
          <div key={h}><h4>{label}</h4>{col.map((it) => card(it, visible.indexOf(it) + 1, true))}</div>
        ))}</div>
      </section>}

      {split.hidden.length > 0 && <section>
        <h3>Hidden from the deck and emails</h3>
        {split.hidden.map((it) => card(it, undefined, true))}
      </section>}

      {a.positioning && <section className="card"><h3>Positioning</h3>
        <p><span className="muted small">The site says now</span><br />“{a.positioning.says_now}”</p>
        <p><span className="muted small">It should say</span><br /><strong>“{a.positioning.should_say}”</strong></p></section>}

      {a.tracking_plan.length > 0 && <section className="card"><h3>What to measure</h3>
        <table><tbody>{a.tracking_plan.map((t, i) => <tr key={i}><td><strong>{t.event}</strong></td><td>{t.why}</td></tr>)}</tbody></table></section>}

      <CroScenario key={`s-${a.id}-${a.completed_at}-${scenarioKey}`} audit={a} busy={busy === "scenario"}
        onSave={(s: ScenarioInputs) => act("scenario", () => api.patch(`/cro-audits/${a.id}/assumptions`, { scenario: s }), a.id)} />

      {evidence && (
        <aside className="card cro-evidence" aria-label="Evidence" tabIndex={-1} ref={drawer}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeEvidence(); } }}>
          <div className="row between"><h3>Evidence</h3><button className="link-btn" onClick={closeEvidence}>Close</button></div>
          {evidenceShown.length === 0 ? <p className="muted small">No evidence recorded.</p> : (
            <ul>{evidenceShown.map((e) => (
              <li key={e.id}><code>{e.id}</code> <span className="muted small">{e.pageKind} · {EVIDENCE_FAMILY_LABEL[e.family] ?? e.family}{e.device ? ` · ${e.device}` : ""}</span><br />{e.fact}</li>
            ))}</ul>
          )}
        </aside>
      )}
    </div>
  );
}
