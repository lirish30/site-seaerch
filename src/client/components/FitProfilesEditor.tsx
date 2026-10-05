import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { draftFromProfile, draftToBody, emptyDraft, friendlyMessage, hasCriteria, PLATFORMS, type ProfileDraft } from "../fitView";
import { groupByCategory } from "../services";
import type { FitProfile, Platform, Service } from "../types";

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? friendlyMessage(e.message) : fallback);

function useAlive() {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return alive;
}

/** The criteria form, shared by an existing profile (own draft) and the add form. */
function ProfileFields({ id, draft, services, onChange }: { id: string; draft: ProfileDraft; services: Service[]; onChange: (d: ProfileDraft) => void }) {
  const set = <K extends keyof ProfileDraft>(k: K, v: ProfileDraft[K]) => onChange({ ...draft, [k]: v });
  const known = services.some((s) => s.key === draft.service_key);
  const togglePlatform = (p: Platform) => set("platforms", draft.platforms.includes(p) ? draft.platforms.filter((x) => x !== p) : [...draft.platforms, p]);
  return (
    <>
      <div className="field-row">
        <div><label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} value={draft.name} onChange={(e) => set("name", e.target.value)} /></div>
        <div><label htmlFor={`${id}-svc`}>Service it sells</label>
          <select id={`${id}-svc`} value={draft.service_key} onChange={(e) => set("service_key", e.target.value)}>
            <option value="">Choose a service…</option>
            {!known && draft.service_key && <option value={draft.service_key}>{draft.service_key} (not in catalog)</option>}
            {groupByCategory(services).map((g) => (
              <optgroup key={g.category} label={g.category}>
                {g.services.map((s) => <option key={s.key} value={s.key}>{s.name}{s.active ? "" : " (off)"}</option>)}
              </optgroup>
            ))}
          </select></div>
      </div>
      <div className="field-row">
        <div><label htmlFor={`${id}-ind`}>Industries (comma separated)</label>
          <input id={`${id}-ind`} value={draft.industries} placeholder="dentist, plumber" onChange={(e) => set("industries", e.target.value)} /></div>
        <div><label htmlFor={`${id}-geo`}>Locations (comma separated)</label>
          <input id={`${id}-geo`} value={draft.geos} placeholder="Austin, TX" onChange={(e) => set("geos", e.target.value)} /></div>
      </div>
      <label>Platforms</label>
      <div className="fitp-platforms" role="group" aria-label="Platforms">
        {PLATFORMS.map((p) => (
          <label key={p} className="check"><input type="checkbox" checked={draft.platforms.includes(p)} onChange={() => togglePlatform(p)} /> {p}</label>
        ))}
      </div>
      <div className="field-row">
        <div><label htmlFor={`${id}-rev`}>Minimum reviews</label>
          <input id={`${id}-rev`} type="number" min={0} step={1} value={draft.min_reviews} onChange={(e) => set("min_reviews", e.target.value)} /></div>
        <div><label htmlFor={`${id}-rat`}>Minimum rating (0 to 5)</label>
          <input id={`${id}-rat`} type="number" min={0} max={5} step={0.1} value={draft.min_rating} onChange={(e) => set("min_rating", e.target.value)} /></div>
      </div>
    </>
  );
}

function ProfileRow({ p, services, onSave, onToggle, onDelete }: {
  p: FitProfile; services: Service[];
  onSave: (p: FitProfile, body: Record<string, unknown>) => Promise<FitProfile>;
  onToggle: (p: FitProfile) => Promise<void>; onDelete: (p: FitProfile) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFromProfile(p));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [saved, setSaved] = useState(false);
  const alive = useAlive();
  const change = (d: ProfileDraft) => { setDraft(d); setSaved(false); setErr(""); };
  const checked = draftToBody(draft);
  async function run(fn: () => Promise<void>, what: string) {
    setBusy(true); setErr(""); setSaved(false);
    try { await fn(); } catch (e) { if (alive.current) setErr(`Couldn't ${what}: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setBusy(false); }
  }
  async function save() {
    if (!checked.ok) { setErr(checked.error); return; }
    await run(async () => {
      const u = await onSave(p, checked.body);
      if (alive.current) { setDraft(draftFromProfile(u)); setSaved(true); }
    }, "save");
  }
  const id = `fitp-${p.id}`;
  return (
    <div className={`fitp${p.active ? "" : " off"}`}>
      <div className="fitp-head">
        <h3 className="fitp-name">{p.name}</h3>
        <label className="check"><input type="checkbox" checked={p.active} disabled={busy} onChange={() => run(() => onToggle(p), `update ${p.name}`)} aria-label={`Active: ${p.name}`} /> Active</label>
        <button className="danger" disabled={busy} onClick={() => run(() => onDelete(p), `delete ${p.name}`)}>Delete</button>
      </div>
      <ProfileFields id={id} draft={draft} services={services} onChange={change} />
      {checked.ok && !hasCriteria(checked.body) && <p className="muted small">With no criteria this profile is ignored when scoring.</p>}
      <p className="row"><button className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        {saved && <span className="muted">Saved</span>}{err && <span className="error" role="alert">{err}</span>}</p>
    </div>
  );
}

export default function FitProfilesEditor() {
  const [profiles, setProfiles] = useState<FitProfile[] | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft());
  const [adding, setAdding] = useState(false); const [addErr, setAddErr] = useState("");
  const alive = useAlive();
  useEffect(() => {
    Promise.all([api.get<FitProfile[]>("/fit-profiles"), api.get<Service[]>("/services")])
      .then(([p, s]) => { if (alive.current) { setProfiles(p); setServices(s); } })
      .catch((e) => { if (alive.current) setLoadErr(errText(e, "Couldn't load fit profiles.")); });
  }, [alive]);

  const replace = (u: FitProfile) => setProfiles((cur) => cur && cur.map((x) => (x.id === u.id ? u : x)));
  async function patch(p: FitProfile, body: Record<string, unknown>) {
    const u = await api.patch<FitProfile>(`/fit-profiles/${p.id}`, body);
    if (alive.current) replace(u);
    return u;
  }
  // The checkbox follows the saved profile, so a failed toggle snaps back; the row shows why.
  const toggle = async (p: FitProfile) => { await patch(p, { active: !p.active }); };
  async function remove(p: FitProfile) {
    if (!window.confirm(`Delete the fit profile "${p.name}"?`)) return;
    await api.del(`/fit-profiles/${p.id}`);
    if (alive.current) setProfiles((cur) => cur && cur.filter((x) => x.id !== p.id));
  }
  async function add() {
    const checked = draftToBody(draft);
    if (!checked.ok) { setAddErr(checked.error); return; }
    setAdding(true); setAddErr("");
    try {
      const created = await api.post<FitProfile>("/fit-profiles", checked.body);
      if (alive.current) { setProfiles((cur) => [...(cur ?? []), created]); setDraft(emptyDraft(draft.service_key)); }
    } catch (e) { if (alive.current) setAddErr(`Couldn't add: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setAdding(false); }
  }

  return (
    <div className="card fit-profiles">
      <h2>Fit profiles</h2>
      <p className="muted small">Each profile describes a kind of business you want for one service. A lead's fit is its best match across the active profiles; criteria left empty are not scored, so a profile with only review minimums will fit most established businesses.</p>
      {loadErr && <p className="error" role="alert">{loadErr}</p>}
      {!profiles ? (loadErr ? null : <p className="muted">Loading…</p>) : <>
        {!profiles.length && <p className="muted">No fit profiles yet, so leads show no fit score.</p>}
        {profiles.map((p) => <ProfileRow key={p.id} p={p} services={services} onSave={patch} onToggle={toggle} onDelete={remove} />)}
        <h3>Add fit profile</h3>
        <ProfileFields id="fitp-new" draft={draft} services={services} onChange={(d) => { setDraft(d); setAddErr(""); }} />
        <p className="row"><button className="primary" onClick={add} disabled={adding}>{adding ? "Adding…" : "Add profile"}</button>
          {addErr && <span className="error" role="alert">{addErr}</span>}</p>
      </>}
    </div>
  );
}
