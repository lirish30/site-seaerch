import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api";
import { draftFromProfile, draftToBody, emptyDraft, friendlyMessage, hasCriteria, PLATFORMS, type ProfileDraft } from "../fitView";
import { notifySettingsChanged } from "../settingsData";
import { criteriaRows, plural } from "../settingsView";
import { groupByCategory } from "../services";
import type { FitProfile, Platform, Service } from "../types";
import Icon from "./Icon";
import { Toggle } from "./settingsBits";

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? friendlyMessage(e.message) : fallback);

/** The profiles, the service catalog (for names and the service picker) and how many leads fit each profile at `matchAt` or better. */
export function useFitProfiles(enabled = true) {
  const [profiles, setProfiles] = useState<FitProfile[] | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [matches, setMatches] = useState<{ matchAt: number; counts: Record<string, number> } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!enabled) return;
    Promise.all([api.get<FitProfile[]>("/fit-profiles"), api.get<Service[]>("/services")])
      .then(([p, s]) => { if (alive.current) { setProfiles(p); setServices(s); } })
      .catch((e) => { if (alive.current) setLoadErr(errText(e, "Couldn't load fit profiles.")); });
  }, [enabled]);
  // The match counts are a nicety: if they can't load the cards just leave them out.
  const refreshMatches = useCallback(() => {
    api.get<{ matchAt: number; counts: Record<string, number> }>("/fit-profiles/matches").then((m) => { if (alive.current) setMatches(m); }).catch(() => {});
  }, []);
  useEffect(() => { if (enabled) refreshMatches(); }, [enabled, refreshMatches]);
  return { profiles, setProfiles, services, loadErr, matches, refreshMatches, alive };
}
export type FitState = ReturnType<typeof useFitProfiles>;

/** The criteria form, shared by an existing profile (own draft) and the add form. */
function ProfileFields({ id, draft, services, onChange, children }: { id: string; draft: ProfileDraft; services: Service[]; onChange: (d: ProfileDraft) => void; children?: ReactNode }) {
  const set = <K extends keyof ProfileDraft>(k: K, v: ProfileDraft[K]) => onChange({ ...draft, [k]: v });
  const known = services.some((s) => s.key === draft.service_key);
  const togglePlatform = (p: Platform) => set("platforms", draft.platforms.includes(p) ? draft.platforms.filter((x) => x !== p) : [...draft.platforms, p]);
  return (
    <div className="fp-form">
      <div className="bx-two">
        <div className="bx-f"><label className="fl" htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} className="in" value={draft.name} onChange={(e) => set("name", e.target.value)} /></div>
        <div className="bx-f"><label className="fl" htmlFor={`${id}-svc`}>Service it sells</label>
          <select id={`${id}-svc`} className="in" value={draft.service_key} onChange={(e) => set("service_key", e.target.value)}>
            <option value="">Choose a service…</option>
            {!known && draft.service_key && <option value={draft.service_key}>{draft.service_key} (not in catalog)</option>}
            {groupByCategory(services).map((g) => (
              <optgroup key={g.category} label={g.category}>
                {g.services.map((s) => <option key={s.key} value={s.key}>{s.name}{s.active ? "" : " (off)"}</option>)}
              </optgroup>
            ))}
          </select></div>
      </div>
      <div className="bx-two">
        <div className="bx-f"><label className="fl" htmlFor={`${id}-ind`}>Industries (comma separated)</label>
          <input id={`${id}-ind`} className="in" value={draft.industries} placeholder="dentist, plumber" onChange={(e) => set("industries", e.target.value)} /></div>
        <div className="bx-f"><label className="fl" htmlFor={`${id}-geo`}>Locations (comma separated)</label>
          <input id={`${id}-geo`} className="in" value={draft.geos} placeholder="Austin, TX" onChange={(e) => set("geos", e.target.value)} /></div>
      </div>
      <div className="bx-f">
        <span className="fl" id={`${id}-plat`}>Platforms</span>
        <div className="fp-plats" role="group" aria-labelledby={`${id}-plat`}>
          {PLATFORMS.map((p) => (
            <label key={p} className="fp-plat"><input type="checkbox" className="cb" checked={draft.platforms.includes(p)} onChange={() => togglePlatform(p)} />{p}</label>
          ))}
        </div>
      </div>
      <div className="fp-minrow">
        <div className="bx-f"><label className="fl" htmlFor={`${id}-rev`}>Minimum reviews</label>
          <input id={`${id}-rev`} className="in" type="number" min={0} step={1} value={draft.min_reviews} onChange={(e) => set("min_reviews", e.target.value)} /></div>
        <div className="bx-f"><label className="fl" htmlFor={`${id}-rat`}>Minimum rating (0 to 5)</label>
          <input id={`${id}-rat`} className="in" type="number" min={0} max={5} step={0.1} value={draft.min_rating} onChange={(e) => set("min_rating", e.target.value)} /></div>
        <span className="sp" />
        {children}
      </div>
    </div>
  );
}

function ProfileCard({ p, services, matches, onSave, onToggle, onDelete }: {
  p: FitProfile; services: Service[]; matches: FitState["matches"];
  onSave: (p: FitProfile, body: Record<string, unknown>) => Promise<FitProfile>;
  onToggle: (p: FitProfile) => Promise<void>; onDelete: (p: FitProfile) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftFromProfile(p));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const change = (d: ProfileDraft) => { setDraft(d); setErr(""); };
  const checked = draftToBody(draft);
  async function run(fn: () => Promise<void>, what: string) {
    setBusy(true); setErr("");
    try { await fn(); } catch (e) { if (alive.current) setErr(`Couldn't ${what}: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setBusy(false); }
  }
  async function save() {
    if (!checked.ok) { setErr(checked.error); return; }
    await run(async () => { const u = await onSave(p, checked.body); if (alive.current) { setDraft(draftFromProfile(u)); setEditing(false); } }, "save");
  }
  const toggleEdit = () => { if (editing) { setDraft(draftFromProfile(p)); setErr(""); } setEditing(!editing); };
  const service = services.find((s) => s.key === p.service_key);
  const rows = criteriaRows(p);
  const n = matches?.counts[p.id];
  return (
    <section className={`fp-card${p.active ? "" : " off"}`}>
      <div className="fp-head">
        <span className="fp-tile" aria-hidden="true"><Icon name="target" size={16} /></span>
        <div className="fp-title">
          <h3>{p.name}</h3>
          <p>Sells: {service?.name ?? p.service_key}</p>
        </div>
        {p.active && rows.length > 0 && matches && n !== undefined && <span className="fp-match">{n === 0 ? `No leads match ${matches.matchAt}+ yet` : `${plural(n, "lead")} match${n === 1 ? "es" : ""} ${matches.matchAt}+`}</span>}
        <Toggle checked={p.active} disabled={busy} onChange={() => void run(() => onToggle(p), `update ${p.name}`)} label={`Active: ${p.name}`} />
        <button type="button" className={`fp-pen${editing ? " on" : ""}`} aria-label={`${editing ? "Close" : "Edit"} ${p.name}`} aria-expanded={editing} onClick={toggleEdit}><Icon name="pen" size={14} /></button>
      </div>
      <div className="fp-body">
        {editing ? (
          <div className="fp-edit">
            <ProfileFields id={`fitp-${p.id}`} draft={draft} services={services} onChange={change}>
              <button type="button" className="btn-ghost-sm" disabled={busy} onClick={() => void run(() => onDelete(p), `delete ${p.name}`)}>Delete</button>
              <button type="button" className="btn primary sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save profile"}</button>
            </ProfileFields>
            {checked.ok && !hasCriteria(checked.body) && <p className="bx-muted">With no criteria this profile is ignored when scoring.</p>}
          </div>
        ) : rows.length > 0 ? (
          <dl className="fp-crit">
            {rows.map((r) => (
              <div key={r.label} className="fp-crow"><dt>{r.label}</dt><dd>{r.items.map((i) => <span key={i} className="badge2 outline">{i}</span>)}</dd></div>
            ))}
          </dl>
        ) : (
          <p className="fp-none"><Icon name="info" size={14} />No criteria yet, so this profile is ignored when scoring.</p>
        )}
        {err && <p className="bx-err" role="alert">{err}</p>}
      </div>
    </section>
  );
}

/** A blank profile card (opened from "Add fit profile"). */
function AddProfile({ services, onAdded, onCancel, alive }: { services: Service[]; onAdded: (p: FitProfile) => void; onCancel: () => void; alive: { current: boolean } }) {
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft());
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  async function add() {
    const checked = draftToBody(draft);
    if (!checked.ok) { setErr(checked.error); return; }
    setBusy(true); setErr("");
    try { const created = await api.post<FitProfile>("/fit-profiles", checked.body); if (alive.current) onAdded(created); }
    catch (e) { if (alive.current) setErr(`Couldn't add: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setBusy(false); }
  }
  return (
    <section className="fp-card fp-new">
      <div className="fp-head">
        <span className="fp-tile" aria-hidden="true"><Icon name="target" size={16} /></span>
        <div className="fp-title"><h3>New fit profile</h3><p>Describe a kind of business you want for one service.</p></div>
      </div>
      <div className="fp-body">
        <div className="fp-edit">
          <ProfileFields id="fitp-new" draft={draft} services={services} onChange={(d) => { setDraft(d); setErr(""); }}>
            <button type="button" className="btn-ghost-sm" disabled={busy} onClick={onCancel}>Cancel</button>
            <button type="button" className="btn primary sm" disabled={busy} onClick={add}>{busy ? "Adding…" : "Add profile"}</button>
          </ProfileFields>
        </div>
        {err && <p className="bx-err" role="alert">{err}</p>}
      </div>
    </section>
  );
}

/**
 * Every fit profile as a card: a summary of its criteria, an Active switch and a pencil that opens the editor.
 * The Fit profiles page passes its own `fp` (the header needs the counts); alone, the editor loads the list itself.
 */
export default function FitProfilesEditor({ fp: lifted, adding = false, onCloseAdd = () => {} }: { fp?: FitState; adding?: boolean; onCloseAdd?: () => void }) {
  const own = useFitProfiles(!lifted);
  const { profiles, setProfiles, services, loadErr, matches, refreshMatches, alive } = lifted ?? own;

  async function patch(p: FitProfile, body: Record<string, unknown>) {
    const u = await api.patch<FitProfile>(`/fit-profiles/${p.id}`, body);
    if (alive.current) { setProfiles((cur) => cur && cur.map((x) => (x.id === u.id ? u : x))); refreshMatches(); notifySettingsChanged(); }
    return u;
  }
  // The switch follows the saved profile, so a failed toggle snaps back; the card shows why.
  const toggle = async (p: FitProfile) => { await patch(p, { active: !p.active }); };
  async function remove(p: FitProfile) {
    if (!window.confirm(`Delete the fit profile "${p.name}"?`)) return;
    await api.del(`/fit-profiles/${p.id}`);
    if (alive.current) { setProfiles((cur) => cur && cur.filter((x) => x.id !== p.id)); notifySettingsChanged(); }
  }

  if (!profiles) return loadErr ? <p className="bx-err" role="alert">{loadErr}</p> : <p className="bx-muted">Loading…</p>;
  return (
    <div className="fp">
      {loadErr && <p className="bx-err" role="alert">{loadErr}</p>}
      {adding && <AddProfile services={services} alive={alive} onCancel={onCloseAdd}
        onAdded={(p) => { setProfiles((cur) => [...(cur ?? []), p]); refreshMatches(); notifySettingsChanged(); onCloseAdd(); }} />}
      {!profiles.length && !adding && <p className="bx-empty">No fit profiles yet, so leads show no fit score. Use “Add fit profile” to describe who you want to work with.</p>}
      {profiles.map((p) => <ProfileCard key={p.id} p={p} services={services} matches={matches} onSave={patch} onToggle={toggle} onDelete={remove} />)}
    </div>
  );
}
