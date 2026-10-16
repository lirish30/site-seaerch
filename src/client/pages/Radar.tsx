import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import Icon, { type IconName } from "../components/Icon";
import { announceLeadsChanged } from "../components/Shell";
import { TYPE_GROUPS } from "../businessTypes";
import { actionErrorText, radarLabel, runConfirmText } from "../radar";
import {
  NEW_FORM, blockedText, checkTimeText, createBody, foundText, formFromRadar, formProblem, intervalChoices, intervalLabel, lastRunText, marketName, monthlyLimitText,
  nextRunText, patchBody, resultChoices, saveErrorText, usedText, type RadarForm, type RadarInfo,
} from "../radarView";
import type { Radar as RadarT } from "../types";

type Estimate = { estUsd: number; spent: number; limit: number; ok: boolean };
type Note = { kind: "ok" | "err"; text: string };
type Dialog = { kind: "new" } | { kind: "edit"; r: RadarT } | { kind: "run"; r: RadarT; est: Estimate } | { kind: "delete"; r: RadarT };
const ALL_TYPES = TYPE_GROUPS.flatMap((g) => g.types);
const HOW: { icon: IconName; title: string; body: string }[] = [
  { icon: "radar", title: "Set it once", body: "Tick “Keep watching” on New search. Pick 7 to 90 days." },
  { icon: "sparkles", title: "Only new businesses", body: "Leads you already have keep their audit and draft. Failed ones are retried." },
  { icon: "shield", title: "Spend-safe", body: "A run that would pass your limit is blocked and retried the next day." },
];

/** Saved searches that re-run on their own: the list, its switch, interval and Run now, plus create, edit and delete. */
export default function Radar() {
  const [radars, setRadars] = useState<RadarT[] | null>(null);
  const [info, setInfo] = useState<RadarInfo | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // A failed reload keeps whatever list is already on screen and just reports the problem.
  const load = useCallback(async () => {
    try { const r = await api.get<RadarT[]>("/radar"); if (alive.current) { setRadars(r); setLoadErr(""); } }
    catch (e) { if (alive.current) setLoadErr(e instanceof ApiError ? e.message : "Couldn't load your radars."); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get<RadarInfo>("/radar/info").then((i) => { if (alive.current) setInfo(i); }).catch(() => {}); }, []);

  const changed = useCallback(async () => { await load(); announceLeadsChanged(); }, [load]);
  const mark = (id: string, on: boolean) => { if (alive.current) setBusy((b) => { const n = new Set(b); if (on) n.add(id); else n.delete(id); return n; }); };
  async function act(id: string, fn: () => Promise<unknown>, ok?: string) {
    if (alive.current) setNote(null);
    mark(id, true);
    try { await fn(); if (ok && alive.current) setNote({ kind: "ok", text: ok }); }
    catch (x) { if (alive.current) setNote({ kind: "err", text: actionErrorText(x) }); }
    await changed(); mark(id, false);
  }

  const toggle = (r: RadarT) => act(r.id, () => api.patch(`/radar/${r.id}`, { enabled: !r.enabled }));
  const changeInterval = (r: RadarT, intervalDays: number) => act(r.id, () => api.patch(`/radar/${r.id}`, { intervalDays }));
  async function askRun(r: RadarT) {
    setNote(null);
    try { setDialog({ kind: "run", r, est: await api.get<Estimate>(`/searches/estimate?maxResults=${r.max_results}`) }); }
    catch { setNote({ kind: "err", text: "Couldn't load the cost estimate, so nothing was run." }); }
  }
  const run = (r: RadarT) => { setDialog(null); return act(r.id, () => api.post(`/radar/${r.id}/run`), `Started ${marketName(r)}. Follow it under Running now.`); };
  const remove = (r: RadarT) => { setDialog(null); return act(r.id, () => api.del(`/radar/${r.id}`), `Deleted the radar for ${marketName(r)}. Its past searches and leads stay.`); };

  const used = radars?.length ?? 0;
  return (
    <>
      <header className="page-header">
        <div><h1>Radar</h1><p>Saved searches that re-run on their own and only audit businesses you haven’t seen before.</p></div>
        <button type="button" className="btn primary" onClick={() => setDialog({ kind: "new" })}><Icon name="plus" size={16} />New radar</button>
      </header>
      <div className="rd-body">
        {note && (
          <p className={`rd-note ${note.kind}`} role={note.kind === "err" ? "alert" : "status"}>
            <Icon name={note.kind === "err" ? "alert" : "check"} size={14} /><span>{note.text}</span>
            <button type="button" className="rd-x" aria-label="Dismiss" onClick={() => setNote(null)}><Icon name="x" size={14} /></button>
          </p>
        )}
        {loadErr && (
          <p className="rd-note err" role="alert"><Icon name="alert" size={14} /><span>{loadErr}</span>
            <button type="button" className="btn sm" onClick={load}>Try again</button></p>
        )}

        <div className="rd-meta">
          {info && <>
            <span><Icon name="clock" size={14} />Checks run daily at {checkTimeText(info.checkAtUtc)}</span>
            <span><Icon name="zap" size={14} />Up to {info.maxPerDay} radars start per day</span>
            <span><Icon name="card" size={14} />Each run obeys your {monthlyLimitText(info.monthlyLimitUsd)} monthly limit</span>
          </>}
          {radars && <b>{info ? usedText(used, info.maxRadars) : `${used} ${used === 1 ? "radar" : "radars"}`}</b>}
        </div>

        {!radars ? (
          loadErr ? null : <ul className="rd-list" aria-busy="true" aria-label="Loading radars">{[0, 1, 2].map((i) => <li key={i} className="rd-row rd-skel" aria-hidden="true" />)}</ul>
        ) : radars.length === 0 ? (
          <div className="rd-empty">
            <span className="rd-tile"><Icon name="radar" size={18} /></span>
            <div><b>No radars yet</b><p>A radar re-runs a search on a schedule and only audits businesses you haven’t seen. Make one here, or tick “Keep watching” on <Link to="/">New search</Link>.</p></div>
            <button type="button" className="btn" onClick={() => setDialog({ kind: "new" })}><Icon name="plus" size={16} />New radar</button>
          </div>
        ) : (
          <ul className="rd-list">
            {radars.map((r) => (
              <RadarRow key={r.id} r={r} busy={busy.has(r.id)} onToggle={() => toggle(r)} onInterval={(d) => changeInterval(r, d)}
                onRun={() => askRun(r)} onEdit={() => setDialog({ kind: "edit", r })} onDelete={() => setDialog({ kind: "delete", r })} />
            ))}
          </ul>
        )}

        <section className="rd-how" aria-label="How Radar works">
          {HOW.map((h) => (
            <div key={h.title}><span className="rd-chip"><Icon name={h.icon} size={15} /></span><div><b>{h.title}</b><p>{h.body}</p></div></div>
          ))}
        </section>
      </div>

      {dialog?.kind === "new" && <RadarDialog key="new" mode="new" onClose={() => setDialog(null)} used={used} max={info?.maxRadars}
        onSaved={(text) => { setDialog(null); setNote({ kind: "ok", text }); void changed(); }} />}
      {dialog?.kind === "edit" && <RadarDialog key={dialog.r.id} mode="edit" radar={dialog.r} onClose={() => setDialog(null)}
        onSaved={(text) => { setDialog(null); setNote({ kind: "ok", text }); void changed(); }} />}
      {dialog?.kind === "run" && (
        <Modal title="Run now" onClose={() => setDialog(null)}>
          <p>{runConfirmText(dialog.est.estUsd, dialog.r)}</p>
          <p className="rd-hint">Up to {dialog.r.max_results} results, new businesses only. It uses your monthly budget: ${dialog.est.spent.toFixed(2)} of ${dialog.est.limit.toFixed(2)} spent so far.</p>
          {!dialog.est.ok && <p className="rd-note err" role="alert"><Icon name="alert" size={14} /><span>This would go over your monthly spend limit.</span></p>}
          <div className="rd-actions">
            <button type="button" className="btn" onClick={() => setDialog(null)}>Cancel</button>
            <button type="button" className="btn primary" disabled={!dialog.est.ok} onClick={() => run(dialog.r)}><Icon name="refresh" size={16} />Run now</button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "delete" && (
        <Modal title="Delete this radar?" onClose={() => setDialog(null)}>
          <p>Delete the radar for {marketName(dialog.r)}? Past searches and leads stay.</p>
          <div className="rd-actions">
            <button type="button" className="btn" onClick={() => setDialog(null)}>Cancel</button>
            <button type="button" className="btn danger" onClick={() => remove(dialog.r)}>Delete radar</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function RadarRow({ r, busy, onToggle, onInterval, onRun, onEdit, onDelete }: {
  r: RadarT; busy: boolean; onToggle: () => void; onInterval: (days: number) => void; onRun: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const blocked = blockedText(r), found = foundText(r);
  return (
    <li className={`rd-row${blocked ? " blocked" : ""}${r.enabled ? "" : " off"}`} aria-busy={busy || undefined}>
      <span className="rd-tile"><Icon name="radar" size={18} /></span>
      <div className="rd-name">
        <b title={marketName(r)}>{marketName(r)}</b>
        {blocked
          ? <span className="rd-blocked" title={r.last_error ?? undefined}><Icon name="alert" size={13} /><span>{blocked}</span></span>
          : <small>Full scans · new businesses only</small>}
      </div>
      <label className="rd-select">
        <select aria-label={radarLabel("Repeat interval", r)} value={r.interval_days} disabled={busy} onChange={(e) => onInterval(Number(e.target.value))}>
          {intervalChoices(r.interval_days).map((d) => <option key={d} value={d}>{intervalLabel(d)}</option>)}
        </select>
        <Icon name="chevron-down" size={13} />
      </label>
      <div className="rd-col rd-next"><span>Next run</span><b className={r.enabled ? undefined : "off"}>{nextRunText(r)}</b></div>
      <div className="rd-col rd-last"><span>Last run</span><b>{lastRunText(r)}</b></div>
      <div className="rd-col rd-fnd"><span>Found</span>{found ? <Link to={`/searches/${found.searchId}`} className="rd-found">{found.text}</Link> : <b className="off dash">—</b>}</div>
      <label className="switch rd-switch">
        <input type="checkbox" role="switch" aria-label={radarLabel("Radar enabled", r)} checked={!!r.enabled} disabled={busy} onChange={onToggle} /><i />
      </label>
      <button type="button" className="btn sm rd-run" aria-label={radarLabel("Run now", r)} disabled={busy || !r.enabled} title={r.enabled ? undefined : "Turn the radar on to run it"} onClick={onRun}>
        <Icon name="refresh" size={16} />{busy ? "Working…" : "Run now"}
      </button>
      <RowMenu label={radarLabel("More actions", r)} disabled={busy}>
        {found && <Link role="menuitem" to={`/searches/${found.searchId}`}><Icon name="search" size={16} />Open last search</Link>}
        <button type="button" role="menuitem" onClick={onEdit}><Icon name="sliders" size={16} />Edit settings</button>
        <button type="button" role="menuitem" className="danger" onClick={onDelete}><Icon name="x" size={16} />Delete radar</button>
      </RowMenu>
    </li>
  );
}

/** The "…" button and its menu; closes on Escape, a click elsewhere, or choosing an item. */
function RowMenu({ label, disabled, children }: { label: string; disabled: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); box.current?.querySelector<HTMLButtonElement>(".rd-more")?.focus(); } };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  // Arrow keys move between items, as in any menu.
  const keys = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus(); e.preventDefault();
  };
  return (
    <div className="rd-menu" ref={box}>
      <button type="button" className="rd-more" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(!open)}><Icon name="more" size={16} /></button>
      {open && <div className="rd-pop" id={id} role="menu" onClick={() => setOpen(false)} onKeyDown={keys}>{children}</div>}
    </div>
  );
}

/** The create and edit form. Editing can't change the market (it is the radar's identity); it changes how often and how much. */
function RadarDialog({ mode, radar, used, max, onClose, onSaved }: {
  mode: "new" | "edit"; radar?: RadarT; used?: number; max?: number; onClose: () => void; onSaved: (message: string) => void;
}) {
  const editing = mode === "edit";
  const [f, setF] = useState<RadarForm>(radar ? formFromRadar(radar) : NEW_FORM);
  const [err, setErr] = useState(""); const [saving, setSaving] = useState(false);
  const [est, setEst] = useState<Estimate | null>(null);
  const up = <K extends keyof RadarForm>(k: K, v: RadarForm[K]) => { setF((x) => ({ ...x, [k]: v })); setErr(""); };
  const ids = { type: useId(), loc: useId(), every: useId(), max: useId(), radius: useId(), types: useId() };

  const maxOk = Number.isInteger(f.maxResults) && f.maxResults >= 1 && f.maxResults <= 200;
  useEffect(() => {
    if (!f.runNow || !maxOk) { setEst(null); return; }
    let off = false;
    api.get<Estimate>(`/searches/estimate?maxResults=${f.maxResults}`).then((e) => { if (!off) setEst(e); }).catch(() => { if (!off) setEst(null); });
    return () => { off = true; };
  }, [f.runNow, f.maxResults, maxOk]);

  const full = !editing && used !== undefined && max !== undefined && used >= max;
  const over = f.runNow && est !== null && !est.ok;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = formProblem(f, editing);
    if (problem) { setErr(problem); return; }
    setSaving(true); setErr("");
    try {
      if (radar) {
        const body = patchBody(f, radar);
        if (Object.keys(body).length) await api.patch(`/radar/${radar.id}`, body);
        onSaved(`Saved ${marketName(radar)}.`);
      } else {
        await api.post("/radar", createBody(f));
        onSaved(f.runNow ? `Radar created, and its first search started. Follow it under Running now.` : `Radar created. It will first run in ${f.intervalDays} days.`);
      }
    } catch (x) { setErr(saveErrorText(x)); setSaving(false); }
  }

  return (
    <Modal title={editing ? `Edit ${marketName(radar!)}` : "New radar"} onClose={onClose}>
      <form className="rd-form" onSubmit={submit} noValidate>
        {!editing && <>
          <div className="rd-field"><label htmlFor={ids.type}>Business type</label>
            <input id={ids.type} list={ids.types} value={f.businessType} placeholder="plumber" autoComplete="off" onChange={(e) => up("businessType", e.target.value)} />
            <datalist id={ids.types}>{ALL_TYPES.map((t) => <option key={t} value={t} />)}</datalist></div>
          <div className="rd-field"><label htmlFor={ids.loc}>Location</label>
            <input id={ids.loc} value={f.location} placeholder="Boise, ID" autoComplete="off" onChange={(e) => up("location", e.target.value)} /></div>
        </>}
        <div className="rd-two">
          <div className="rd-field"><label htmlFor={ids.every}>Run every</label>
            <select id={ids.every} value={f.intervalDays} onChange={(e) => up("intervalDays", Number(e.target.value))}>
              {intervalChoices(f.intervalDays).map((d) => <option key={d} value={d}>{d} days</option>)}</select></div>
          <div className="rd-field"><label htmlFor={ids.max}>Results per run</label>
            <select id={ids.max} value={f.maxResults} onChange={(e) => up("maxResults", Number(e.target.value))}>
              {resultChoices(f.maxResults).map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
        </div>
        <div className="rd-field"><label htmlFor={ids.radius}>Search radius (km)</label>
          <input id={ids.radius} type="number" min={1} max={100} value={f.radiusKm} onChange={(e) => up("radiusKm", Number(e.target.value))} /></div>
        {!editing && (
          <label className="rd-check">
            <input type="checkbox" className="cb" checked={f.runNow} onChange={(e) => up("runNow", e.target.checked)} />
            <span>Start the first search now<small>{f.runNow ? (est ? `About $${est.estUsd.toFixed(2)} of your ${monthlyLimitText(est.limit)} monthly limit.` : "Runs a full scan of new businesses.") : "Otherwise the first run is one interval from now."}</small></span>
          </label>
        )}
        {full && <p className="rd-note err" role="alert"><Icon name="alert" size={14} /><span>You already have {max} radars. Delete one first.</span></p>}
        {over && <p className="rd-note err" role="alert"><Icon name="alert" size={14} /><span>This would go over your monthly spend limit.</span></p>}
        {err && <p className="rd-note err" role="alert"><Icon name="alert" size={14} /><span>{err}</span></p>}
        <div className="rd-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={saving || full || over}>{saving ? "Saving…" : editing ? "Save changes" : f.runNow ? "Create and run" : "Create radar"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** A native modal dialog: focus is trapped, Escape and a click on the backdrop close it. */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const tid = useId();
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); }, []);
  return (
    <dialog ref={ref} className="rd-dialog" aria-labelledby={tid} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="rd-dlg"><h2 id={tid}>{title}</h2>{children}</div>
    </dialog>
  );
}
