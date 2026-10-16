import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { parseSpendLimit } from "./spend";

export type SettingsDoc = Record<string, string | number>;
export interface UsageRow { service: string; units: number; est_cost_usd: number }

const FIELD_ERRORS: Record<string, string> = {
  logo_url: "Logo URL must be an https:// link",
  signature_json: "A link or image in your signature isn't a valid address. Links need http(s):// and the image must be https://.",
  resume_url: "Resume link must be a web address, like https://yoursite.com/resume.pdf",
  monthly_spend_limit_usd: "Enter a monthly spend limit between 0 and 10000.",
};

/** Set while any Settings page holds edits that are not saved; the sidebar asks before leaving and the browser warns on reload. */
export const unsaved = { current: false };
/** Fired after a list page (samples, services, ...) changes something, so the sidebar counts and the overview refresh. */
export const SETTINGS_CHANGED = "settings-changed";
export const notifySettingsChanged = () => window.dispatchEvent(new Event(SETTINGS_CHANGED));

/**
 * One settings page's worth of state: the loaded document, edits kept apart from what is saved (so the page can say "unsaved changes"
 * and offer Discard), and a save that sends only the keys that changed. The worker accepts partial updates.
 * `errors` holds a message per rejected field (cleared when that field is edited); `error` is the one-line summary for the save bar.
 */
export function useSettingsDoc() {
  const [saved, setSaved] = useState<SettingsDoc | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [draft, setDraft] = useState<SettingsDoc>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [justSaved, setJustSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    let live = true;
    api.get<{ settings: SettingsDoc; usage: UsageRow[] }>("/settings")
      .then((r) => { if (live) { setSaved(r.settings); setUsage(r.usage); } })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.message : "Couldn't load settings."); });
    return () => { live = false; clearTimeout(timer.current); unsaved.current = false; };
  }, []);
  const value = useCallback((k: string): string => String((k in draft ? draft[k] : saved?.[k]) ?? ""), [draft, saved]);
  const set = useCallback((k: string, v: string | number) => {
    setDraft((d) => (saved && String(saved[k] ?? "") === String(v) ? Object.fromEntries(Object.entries(d).filter(([key]) => key !== k)) : { ...d, [k]: v }));
    setJustSaved(false); setError("");
    setErrors((e) => (k in e ? Object.fromEntries(Object.entries(e).filter(([key]) => key !== k)) : e));
  }, [saved]);
  const dirtyKeys = Object.keys(draft);
  const dirty = dirtyKeys.length > 0;
  useEffect(() => {
    unsaved.current = dirty;
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const discard = useCallback(() => { setDraft({}); setError(""); setErrors({}); }, []);
  const save = useCallback(async () => {
    if (!saved || !Object.keys(draft).length) return true;
    const body: SettingsDoc = { ...draft };
    if ("monthly_spend_limit_usd" in body) {
      const limit = parseSpendLimit(body.monthly_spend_limit_usd);
      if (limit === null) { setError(FIELD_ERRORS.monthly_spend_limit_usd); setErrors({ monthly_spend_limit_usd: FIELD_ERRORS.monthly_spend_limit_usd }); return false; }
      body.monthly_spend_limit_usd = limit;
    }
    setSaving(true); setError(""); setErrors({});
    try {
      setSaved(await api.put<SettingsDoc>("/settings", body)); setDraft({}); setJustSaved(true); notifySettingsChanged();
      clearTimeout(timer.current); timer.current = setTimeout(() => setJustSaved(false), 3000);
      return true;
    } catch (e) {
      const fields = e instanceof ApiError ? e.fields.filter((f) => FIELD_ERRORS[f]) : [];
      setErrors(Object.fromEntries(fields.map((f) => [f, FIELD_ERRORS[f]])));
      setError(fields.length ? FIELD_ERRORS[fields[0]] : e instanceof ApiError ? `Couldn't save: ${e.message}` : "Couldn't save settings.");
      return false;
    } finally { setSaving(false); }
  }, [saved, draft]);
  return { loaded: saved !== null, saved, usage, value, set, dirty, dirtyKeys, save, saving, discard, error, errors, justSaved };
}
export type SettingsDocState = ReturnType<typeof useSettingsDoc>;
