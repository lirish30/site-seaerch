import { useState } from "react";
import { ApiError, clientsApi } from "../../api";
import { addressProblem, problemText, safeHref, siteTitle } from "../../clientView";
import { noteProblem, type SiteFlag } from "../../../worker/sites/access";
import type { AccessMethod, Cms, HostingTier, Site, SiteFields } from "../../../worker/db/sites";
import type { ClientAccessItem } from "../../../worker/clients/record";
import AccessChecklist from "./AccessChecklist";

const CMS: [Cms, string][] = [
  ["wordpress", "WordPress"], ["webflow", "Webflow"], ["wix", "Wix"], ["squarespace", "Squarespace"], ["shopify", "Shopify"], ["custom", "Custom"], ["unknown", "Not known yet"],
];
const TIERS: [HostingTier, string][] = [["logan_hosted", "Hosted by you"], ["client_hosted", "Hosted by the client"], ["unknown", "Not known yet"]];
const METHODS: [AccessMethod, string][] = [["ssh_wpcli", "SSH with WP-CLI"], ["mainwp", "MainWP"], ["none", "None"], ["unknown", "Not known yet"]];
const label = <T extends string>(list: [T, string][], v: T): string => list.find(([k]) => k === v)?.[1] ?? v;

type TextKey = "url" | "domain" | "hostProvider" | "registrar" | "dnsProvider" | "adminUrl" | "notes";
const TEXT: { key: TextKey; label: string; type?: "url"; multiline?: boolean; hint?: string }[] = [
  { key: "url", label: "Site address", type: "url", hint: "Starts with http:// or https://. The domain is worked out from it." },
  { key: "domain", label: "Domain" },
  { key: "adminUrl", label: "Admin address", type: "url", hint: "The login page address only. Never put a username or password in it." },
  { key: "hostProvider", label: "Host" },
  { key: "registrar", label: "Registrar" },
  { key: "dnsProvider", label: "DNS provider" },
  { key: "notes", label: "Notes", multiline: true },
];
const draftOf = (s: Site): Record<TextKey, string> => ({
  url: s.url ?? "", domain: s.domain ?? "", adminUrl: s.adminUrl ?? "", hostProvider: s.hostProvider ?? "", registrar: s.registrar ?? "", dnsProvider: s.dnsProvider ?? "", notes: s.notes ?? "",
});

/** The refusal to show before the request goes out, in the server's words for the same checks, or null. Never repeats what was typed. */
function localProblem(d: Record<TextKey, string>, changed: TextKey[]): string | null {
  for (const k of changed) {
    const v = d[k].trim();
    if (!v) continue;
    if (k === "url" || k === "adminUrl") { const p = addressProblem(v, k === "url" ? "The site address" : "The admin address"); if (p) return p; }
    if (k === "notes") { const p = noteProblem(v); if (p) return p; }
  }
  return null;
}

/** A link only when the address is a plain http or https one; anything else is shown as text and never becomes an href. */
function SafeLink({ url, children }: { url: string | null; children: React.ReactNode }) {
  const href = safeHref(url);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <>{url ? <span>{url}</span> : null}</>;
}

/** One site: its fields (text fields save together, the three choices save the moment you pick), the warnings, and the access checklist. */
export default function SitePanel({ clientId, site, access, flags, onChanged }: {
  clientId: string; site: Site; access: ClientAccessItem[]; flags: SiteFlag[]; onChanged: () => Promise<void>;
}) {
  const title = siteTitle(site);
  const original = draftOf(site);
  const [draft, setDraft] = useState(original);
  const [base, setBase] = useState(original);
  const [seen, setSeen] = useState(site.updatedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  // The record was reloaded (a choice was made, or a save went through): fields you have not touched follow the server (a changed address re-works the domain); fields you are typing in stay as typed.
  if (seen !== site.updatedAt) {
    setSeen(site.updatedAt); setBase(original);
    setDraft((d) => Object.fromEntries(TEXT.map((f) => [f.key, d[f.key].trim() === base[f.key] ? original[f.key] : d[f.key]])) as Record<TextKey, string>);
  }
  const dirty = TEXT.map((f) => f.key).filter((k) => draft[k].trim() !== original[k]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || dirty.length === 0) return;
    const problem = localProblem(draft, dirty);
    setSaved(false);
    if (problem) { setError(problem); return; }
    setBusy(true); setError("");
    try {
      const patch: Partial<SiteFields> = {};
      for (const k of dirty) patch[k] = draft[k].trim() || null;
      const { site: next } = await clientsApi.patchSite(clientId, site.id, patch);
      setDraft(draftOf(next)); setBase(draftOf(next));
      await onChanged();
      setSaved(true);
    } catch (err) { setError(err instanceof ApiError ? problemText(err, "Could not save.") : "Could not save."); }
    finally { setBusy(false); }
  }

  async function choose(patch: Partial<SiteFields>) {
    setBusy(true); setError(""); setSaved(false);
    try { await clientsApi.patchSite(clientId, site.id, patch); await onChanged(); }
    catch (err) { setError(err instanceof ApiError ? problemText(err, "Could not save.") : "Could not save."); }
    finally { setBusy(false); }
  }

  async function archive() {
    if (!window.confirm(`Archive ${title}? It leaves this page and frees its domain. Its history stays in the timeline.`)) return;
    setBusy(true); setError("");
    try { await clientsApi.archiveSite(clientId, site.id); await onChanged(); }
    catch (err) { setError(err instanceof ApiError ? problemText(err, "Could not archive.") : "Could not archive."); }
    finally { setBusy(false); }
  }

  return (
    <article className="cl-site" aria-label={`Site ${title}`}>
      <header className="cl-site-head">
        <h3 className="cl-site-title">{title}</h3>
        {site.test && <span className="badge2 info"><i className="dot" />Test</span>}
        <span className="badge2 outline">{label(TIERS, site.hostingTier)}</span>
        <span className="cl-site-links small">
          {safeHref(site.url) && <SafeLink url={site.url}>Open site</SafeLink>}
          {safeHref(site.adminUrl) && <SafeLink url={site.adminUrl}>Open admin</SafeLink>}
        </span>
      </header>

      {flags.length > 0 && (
        <div className="cl-flags" role="group" aria-label={`Warnings for ${title}`}>
          {flags.map((f) => <p key={f.code} className="small">{f.text}</p>)}
        </div>
      )}

      <div className="cl-choices">
        <label className="deal-field"><span>Platform</span>
          <select aria-label={`Platform for ${title}`} value={site.cms} disabled={busy} onChange={(e) => void choose({ cms: e.target.value as Cms })}>
            {CMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="deal-field"><span>Hosting</span>
          <select aria-label={`Hosting tier for ${title}`} value={site.hostingTier} disabled={busy} onChange={(e) => void choose({ hostingTier: e.target.value as HostingTier })}>
            {TIERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="deal-field"><span>Access method</span>
          <select aria-label={`Access method for ${title}`} value={site.accessMethod} disabled={busy} onChange={(e) => void choose({ accessMethod: e.target.value as AccessMethod })}>
            {METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      </div>

      <form className="cl-fields" onSubmit={(e) => void save(e)} noValidate>
        {TEXT.map((f) => {
          const id = `${site.id}-${f.key}`;
          const common = {
            id, value: draft[f.key], "aria-label": `${f.label} for ${title}`, "aria-describedby": f.hint ? `${id}-hint` : undefined,
            onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft((d) => ({ ...d, [f.key]: e.target.value })); setSaved(false); setError(""); },
          };
          return (
            <label key={f.key} className={`deal-field${f.multiline ? " wide" : ""}`} htmlFor={id}><span>{f.label}</span>
              {f.multiline
                ? <textarea {...common} rows={2} maxLength={600} />
                : <input {...common} type="text" inputMode={f.type === "url" ? "url" : undefined} autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={320} />}
              {f.hint && <small id={`${id}-hint`} className="muted">{f.hint}</small>}
            </label>
          );
        })}
        {error && <p className="error small cl-fields-msg" role="alert">{error}</p>}
        <div className="cl-fields-actions">
          <button type="submit" className="btn primary" disabled={busy || dirty.length === 0} aria-label={`Save changes to ${title}`}>Save changes</button>
          {saved && dirty.length === 0 && <span className="small muted" role="status">Saved.</span>}
          <button type="button" className="btn" disabled={busy} onClick={() => void archive()} aria-label={`Archive site ${title}`}>Archive site</button>
        </div>
      </form>

      <AccessChecklist clientId={clientId} siteId={site.id} siteName={title} items={access} onChanged={onChanged} />
    </article>
  );
}
