import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../../api";
import { SETTINGS_CHANGED, unsaved } from "../../settingsData";
import Icon, { type IconName } from "../Icon";
import { SideItem, SideLabel, SideTitle } from "./parts";

export interface SettingsPageDef { slug: string; label: string; icon: IconName; group: "You" | "Outreach" | "Lead scoring" | "Account" }
/** Every settings page, in sidebar order. `slug` is the path under /settings. */
export const SETTINGS_PAGES: SettingsPageDef[] = [
  { slug: "profile", label: "Profile", icon: "user", group: "You" }, { slug: "job-search", label: "Job search", icon: "briefcase", group: "You" },
  { slug: "signature", label: "Email signature", icon: "pen", group: "You" },
  { slug: "voice", label: "Email voice", icon: "mail", group: "Outreach" }, { slug: "work-samples", label: "Work samples", icon: "image", group: "Outreach" },
  { slug: "services", label: "Services you sell", icon: "list", group: "Outreach" },
  { slug: "fit-profiles", label: "Fit profiles", icon: "target", group: "Lead scoring" }, { slug: "suppressions", label: "Suppressions", icon: "ban", group: "Lead scoring" },
  { slug: "scores", label: "How scores work", icon: "zap", group: "Lead scoring" },
  { slug: "google", label: "Google", icon: "link", group: "Account" }, { slug: "usage", label: "Usage & limits", icon: "card", group: "Account" },
  { slug: "footer", label: "Mailing footer", icon: "shield", group: "Account" },
];
const GROUPS = ["You", "Outreach", "Lead scoring", "Account"] as const;
const COUNTED: [string, string][] = [["work-samples", "/work-samples"], ["services", "/services"], ["fit-profiles", "/fit-profiles"], ["suppressions", "/suppressions"]];

/** Settings: an overview and the twelve pages, with counts where a page holds a list. The search icon filters the list. */
export default function SettingsSidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [finding, setFinding] = useState(false);
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    const load = () => COUNTED.forEach(([slug, path]) => api.get<unknown[]>(path).then((r) => { if (live) setCounts((c) => ({ ...c, [slug]: r.length })); }).catch(() => {}));
    load();
    window.addEventListener(SETTINGS_CHANGED, load);
    return () => { live = false; window.removeEventListener(SETTINGS_CHANGED, load); };
  }, [pathname]);
  // Leaving a page with unsaved edits (any in-app link) asks first; Cancel stays put.
  useEffect(() => {
    const guard = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href^='/']");
      if (!a || !unsaved.current || a.getAttribute("href") === pathname || e.defaultPrevented) return;
      if (!window.confirm("You have unsaved changes. Leave without saving?")) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener("click", guard, true);
    return () => document.removeEventListener("click", guard, true);
  }, [pathname]);
  useEffect(() => { if (finding) input.current?.focus(); }, [finding]);

  const needle = q.trim().toLowerCase();
  const shown = SETTINGS_PAGES.filter((p) => !needle || p.label.toLowerCase().includes(needle) || p.group.toLowerCase().includes(needle));
  const close = () => { setFinding(false); setQ(""); };
  return (
    <>
      <SideTitle title="Settings" action={
        <button type="button" className="icon-btn" aria-label="Find a setting" aria-pressed={finding} title="Find a setting" onClick={() => (finding ? close() : setFinding(true))}><Icon name="search" size={16} /></button>
      } />
      {finding && (
        <input ref={input} className="side-find" type="search" placeholder="Find a setting" aria-label="Find a setting" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") close(); if (e.key === "Enter" && shown[0] && unsavedOk()) { navigate(`/settings/${shown[0].slug}`); close(); } }} />
      )}
      {!needle && <SideItem to="/settings" icon="grid" label="Overview" active={pathname === "/settings"} />}
      {GROUPS.map((g) => {
        const items = shown.filter((p) => p.group === g);
        return items.length > 0 && (
          <div key={g} className="side-group">
            <SideLabel>{g}</SideLabel>
            {items.map((p) => <SideItem key={p.slug} to={`/settings/${p.slug}`} icon={p.icon} label={p.label} count={counts[p.slug]} active={pathname === `/settings/${p.slug}`} />)}
          </div>
        );
      })}
      {needle && shown.length === 0 && <p className="side-none">No setting matches “{q.trim()}”.</p>}
    </>
  );
}

const unsavedOk = () => !unsaved.current || window.confirm("You have unsaved changes. Leave without saving?");
