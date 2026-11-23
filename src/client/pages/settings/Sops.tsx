import { useEffect, useState } from "react";
import { api } from "../../api";
import { Chip } from "../../components/ds";
import Icon from "../../components/Icon";
import SettingsPage, { Callout } from "../../components/SettingsPage";
import SopEditor from "../../components/SopEditor";
import { Toggle } from "../../components/settingsBits";
import { unsaved } from "../../settingsData";
import { stepRows, totalEstimate } from "../../sopView";
import type { SopTemplate } from "../../../worker/sop/model";

const leave = () => !unsaved.current || window.confirm("You have unsaved changes. Leave them behind?");
const words = (key: string) => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const CADENCE: Record<string, string> = { weekly: "every week", monthly: "every month", quarterly: "every quarter", annual: "every year" };

/** Settings > SOPs: the templates every project starts from. Pick one to edit its phases and steps. Editing a template never touches a project already running. */
export default function Sops() {
  const [templates, setTemplates] = useState<SopTemplate[] | null | false>(null);
  const [editing, setEditing] = useState<{ key: string } | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");

  useEffect(() => { api.get<{ templates: SopTemplate[] }>("/sops").then((r) => setTemplates(r.templates)).catch(() => setTemplates(false)); }, []);
  const list = Array.isArray(templates) ? templates : [];
  const current = editing && editing !== "new" ? list.find((t) => t.key === editing.key) ?? null : null;

  const open = (next: { key: string } | "new") => { if (leave()) { unsaved.current = false; setEditing(next); setNotice(""); setError(""); } };
  const setActive = async (t: SopTemplate, active: boolean) => {
    setBusyKey(t.key); setError(""); setNotice("");
    try {
      const r = await api.post<{ template: SopTemplate }>(`/sops/${encodeURIComponent(t.key)}/active`, { active });
      setTemplates((all) => (Array.isArray(all) ? all.map((x) => (x.key === t.key ? r.template : x)) : all));
      setNotice(`${t.name} is ${active ? "on: new projects can start from it" : "off: no new project starts from it"}.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn’t change that."); }
    finally { setBusyKey(""); }
  };
  const saved = (t: SopTemplate) => {
    setTemplates((all) => { const rest = Array.isArray(all) ? all : []; return rest.some((x) => x.key === t.key) ? rest.map((x) => (x.key === t.key ? t : x)) : [...rest, t]; });
    setEditing({ key: t.key });
    setNotice(`${t.name} saved as version ${t.version}. Projects already running keep the steps they have.`);
  };
  const on = list.filter((t) => t.active).length;

  return (
    <SettingsPage title="SOPs" width={900} sub="The step-by-step plans a new project starts from. Each step says who does it and what done looks like."
      badge={list.length > 0 ? <Chip tone="outline" dot>{list.length} {list.length === 1 ? "template" : "templates"} · {on} on</Chip> : undefined}
      action={Array.isArray(templates) ? <button type="button" className="btn primary" onClick={() => open("new")}><Icon name="plus" size={14} />New template</button> : undefined}>
      <div className="bx sox ds-page">
        {templates === null && <p className="st-loading">Loading…</p>}
        {templates === false && <Callout tone="critical" icon="alert">Couldn’t load the SOPs. Reload the page to try again.</Callout>}
        {Array.isArray(templates) && (
          <section className="st-card">
            <header><div><h2>Templates</h2><p>Turn a template off and no new project starts from it. Projects already running are not touched.</p></div></header>
            {list.length === 0 ? (
              <div className="sox-row">
                <span className="sox-tile signal"><Icon name="list" size={16} /></span>
                <div className="sox-main"><b>No templates yet</b><small>A template is the list of steps a new project starts with. Make one for each kind of work you sell.</small></div>
                <button type="button" className="btn primary" onClick={() => open("new")}>New template</button>
              </div>
            ) : (
              <ul className="sox-list">
                {list.map((t) => {
                  const phases = stepRows(t).length;
                  const sel = current?.key === t.key;
                  return (
                    <li key={t.key} className={`sox-row${t.active ? "" : " off"}${sel ? " sel" : ""}`}>
                      <span className={`sox-tile ${t.active ? "info" : ""}`}><Icon name={t.kind === "recurring" ? "refresh" : "list"} size={16} /></span>
                      <div className="sox-main">
                        <div className="sox-title">
                          <b>{t.name}</b><span className="sox-key">{t.key}</span>
                          <Chip tone="outline">v{t.version}</Chip>
                          {t.kind === "recurring" && <Chip tone="info">Repeats {CADENCE[t.cadence ?? ""] ?? ""}</Chip>}
                        </div>
                        <small>
                          {t.steps.length} {t.steps.length === 1 ? "step" : "steps"} in {phases} {phases === 1 ? "phase" : "phases"} · {totalEstimate(t)}
                          {t.appliesTo.length > 0 ? ` · for ${t.appliesTo.map(words).join(", ")}` : " · not tied to a package"}
                        </small>
                      </div>
                      <div className="sox-side">
                        <Toggle checked={t.active} disabled={busyKey === t.key} label={`${t.name} active`} onChange={(v) => void setActive(t, v)}><span>{t.active ? "On" : "Off"}</span></Toggle>
                        <button type="button" className={`btn sm${sel ? " primary" : ""}`} aria-expanded={sel} onClick={() => (sel ? open({ key: "" }) : open({ key: t.key }))}>{sel ? "Editing" : "Edit steps"}</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div aria-live="polite">
              {(notice || error) && <div className={`sox-card-foot sox-result${error ? " bad" : ""}`}><p role={error ? "alert" : "status"}><Icon name={error ? "alert" : "check"} size={14} />{error || notice}</p></div>}
            </div>
          </section>
        )}
        {editing === "new" && <SopEditor key="new" template={null} active existingKeys={list.map((t) => t.key)} onSaved={saved} onClose={() => setEditing(null)} />}
        {current && <SopEditor key={current.key} template={current} active={current.active} existingKeys={list.map((t) => t.key)} onSaved={saved} onClose={() => setEditing(null)} />}
      </div>
    </SettingsPage>
  );
}
