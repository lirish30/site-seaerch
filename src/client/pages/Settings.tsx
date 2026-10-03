import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { parseSpendLimit } from "../spend";

type S = Record<string, string | number>;
// Fields that appear on the public shared report, with the help text shown under each.
const HELP: Record<string, string> = {
  your_name: "Also shown on shared reports.", business_name: "Also shown on shared reports.", logo_url: "An https image shown on shared reports.",
};
const FIELDS: [string, string, "input" | "textarea"][] = [
  ["your_name", "Your name", "input"], ["business_name", "Business name", "input"], ["contact_email", "Contact email (in the crawler user-agent and shown on shared reports)", "input"],
  ["services_blurb", "What you offer", "textarea"], ["signature", "Signature", "textarea"],
  ["physical_address", "Physical mailing address (required by CAN-SPAM)", "input"], ["opt_out_line", "Opt-out line", "input"],
  ["tone_notes", "Voice / tone notes for drafts", "textarea"], ["logo_url", "Logo URL (https)", "input"],
];

export default function Settings() {
  const [s, setS] = useState<S | null>(null);
  const [usage, setUsage] = useState<{ service: string; units: number; est_cost_usd: number }[]>([]);
  const [saved, setSaved] = useState(false); const [err, setErr] = useState(""); const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.get<{ settings: S; usage: typeof usage }>("/settings")
      .then((r) => { if (!cancelled) { setS(r.settings); setUsage(r.usage); } })
      .catch((e) => { if (!cancelled) setErr(e instanceof ApiError ? e.message : "Couldn't load settings."); });
    return () => { cancelled = true; };
  }, []);
  if (!s) return err ? <p className="error">{err}</p> : <p>Loading…</p>;
  const set = (k: string, v: string | number) => { setS({ ...s, [k]: v }); setSaved(false); setErr(""); };
  async function save() {
    const limit = parseSpendLimit(s!.monthly_spend_limit_usd);
    if (limit === null) { setErr("Enter a monthly spend limit between 0 and 10000."); return; }
    setSaving(true); setErr("");
    try { setS(await api.put<S>("/settings", { ...s, monthly_spend_limit_usd: limit })); setSaved(true); }
    catch (e) {
      setErr(e instanceof ApiError && e.fields.includes("logo_url") ? "Logo URL must be an https:// link"
        : e instanceof ApiError ? `Couldn't save: ${e.message}` : "Couldn't save settings.");
    }
    finally { setSaving(false); }
  }
  const total = usage.reduce((t, u) => t + u.est_cost_usd, 0);
  return (
    <div className="grid2">
      <div className="card">
        <h2>Your profile</h2>
        {FIELDS.map(([k, label, kind]) => (
          <div key={k}>
            <label htmlFor={k}>{label}</label>
            {kind === "input"
              ? <input id={k} value={String(s[k] ?? "")} onChange={(e) => set(k, e.target.value)} />
              : <textarea id={k} value={String(s[k] ?? "")} onChange={(e) => set(k, e.target.value)} />}
            {HELP[k] && <p className="muted">{HELP[k]}</p>}
          </div>
        ))}
        <label htmlFor="limit">Monthly spend limit (USD)</label>
        <input id="limit" type="number" min={0} value={String(s.monthly_spend_limit_usd ?? "")} onChange={(e) => set("monthly_spend_limit_usd", e.target.value)} />
        <p className="row"><button className="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>{saved && <span className="muted">Saved</span>}{err && <span className="error">{err}</span>}</p>
      </div>
      <div className="card">
        <h2>This month</h2>
        <table><tbody>
          {usage.map((u) => <tr key={u.service}><td>{u.service}</td><td>{u.units} calls</td><td>${u.est_cost_usd.toFixed(2)}</td></tr>)}
          <tr><td><strong>Total</strong></td><td /><td><strong>${total.toFixed(2)}</strong> of ${(parseSpendLimit(s.monthly_spend_limit_usd) ?? 0).toFixed(2)}</td></tr>
        </tbody></table>
      </div>
    </div>
  );
}
