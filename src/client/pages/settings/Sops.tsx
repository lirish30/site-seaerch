import { useEffect, useState } from "react";
import { api } from "../../api";
import SettingsPage, { Callout, Card } from "../../components/SettingsPage";
import SopEditor from "../../components/SopEditor";
import { unsaved } from "../../settingsData";
import { totalEstimate } from "../../sopView";
import type { SopTemplate } from "../../../worker/sop/model";

const leave = () => !unsaved.current || window.confirm("You have unsaved changes. Leave them behind?");

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

  return (
    <SettingsPage title="SOPs" width={900} sub="The step-by-step plans a new project starts from. Each step says who does it and what done looks like.">
      <div className="wk sp">
        {templates === null && <p className="st-loading">Loading…</p>}
        {templates === false && <Callout tone="critical" icon="alert">Couldn’t load the SOPs.</Callout>}
        {Array.isArray(templates) && (
          <Card title="Templates" sub="Turn a template off and no new project starts from it. Projects already running are not touched."
            action={<button type="button" className="btn" onClick={() => open("new")}>New template</button>}>
            {error && <p className="warn small" role="alert">{error}</p>}
            <div className="st-live" aria-live="polite">{notice && <p className="small" role="status">{notice}</p>}</div>
            {list.length === 0 ? <p className="muted">No templates yet.</p> : (
              <ul className="sp-templates">
                {list.map((t) => (
                  <li key={t.key} className="sp-trow">
                    <div className="sp-trow-main">
                      <b>{t.name}</b> <span className="wk-key">{t.key}</span>
                      <p className="muted small">Version {t.version} · {t.steps.length} {t.steps.length === 1 ? "step" : "steps"} · {totalEstimate(t)}{t.kind === "recurring" ? " · recurring" : ""}</p>
                    </div>
                    <label className="sp-switch">
                      <input type="checkbox" role="switch" checked={t.active} disabled={busyKey === t.key} onChange={(e) => void setActive(t, e.target.checked)} />
                      <span>{t.active ? "Active" : "Off"}</span>
                    </label>
                    <button type="button" className="btn" aria-expanded={current?.key === t.key} onClick={() => open({ key: t.key })}>Edit</button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {editing === "new" && <SopEditor key="new" template={null} active existingKeys={list.map((t) => t.key)} onSaved={saved} onClose={() => setEditing(null)} />}
        {current && <SopEditor key={current.key} template={current} active={current.active} existingKeys={list.map((t) => t.key)} onSaved={saved} onClose={() => setEditing(null)} />}
      </div>
    </SettingsPage>
  );
}
