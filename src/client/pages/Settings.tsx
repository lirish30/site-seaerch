import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { parseSpendLimit } from "../spend";

type S = Record<string, string | number>;
const FIELDS: [string, string, "input" | "textarea"][] = [
  ["your_name", "Your name", "input"], ["business_name", "Business name", "input"], ["contact_email", "Contact email (used in crawler user-agent)", "input"],
  ["services_blurb", "What you offer", "textarea"], ["signature", "Signature", "textarea"],
  ["physical_address", "Physical mailing address (required by CAN-SPAM)", "input"], ["opt_out_line", "Opt-out line", "input"],
];

const VOICE: [string, string, [string, string][]][] = [
  ["tone_preset", "Tone", [["friendly_local", "Friendly local"], ["consultative", "Consultative expert"], ["direct", "Direct & short"], ["formal", "Formal"]]],
  ["email_length", "Length", [["short", "Short (≈120 words)"], ["medium", "Medium (≈180 words)"], ["long", "Long (≈250 words)"]]],
  ["cta_style", "Ask them to…", [["mini_audit", "Receive their free audit report"], ["call", "Book a 10-minute call"], ["reply", "Reply yes/no"], ["proposal", "Receive a proposal with prices"]]],
];

export default function Settings() {
  const [s, setS] = useState<S | null>(null);
  const [usage, setUsage] = useState<{ service: string; units: number; est_cost_usd: number }[]>([]);
  const [saved, setSaved] = useState(false); const [err, setErr] = useState(""); const [saving, setSaving] = useState(false);
  const [google, setGoogle] = useState<{ configured: boolean; connected: boolean; email: string | null } | null>(null);
  const googleResult = new URLSearchParams(location.search).get("google");
  useEffect(() => { api.get<typeof google>("/google/status").then(setGoogle).catch(() => setGoogle(null)); }, []);
  async function disconnectGoogle() {
    if (!window.confirm("Disconnect Google? Exports to Gmail and Drive will stop until you reconnect.")) return;
    await api.post("/google/disconnect"); setGoogle(await api.get("/google/status"));
  }
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
    catch (e) { setErr(e instanceof ApiError ? `Couldn't save: ${e.message}` : "Couldn't save settings."); }
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
          </div>
        ))}
        <h2 style={{ marginTop: 24 }}>Email voice</h2>
        <p className="muted small">Applies to every draft. You can still change the tone for a single email on the lead page.</p>
        <div className="voice-grid">
          {VOICE.map(([k, label, opts]) => (
            <div key={k}>
              <label htmlFor={k}>{label}</label>
              <select id={k} value={String(s[k] ?? opts[0][0])} onChange={(e) => set(k, e.target.value)}>
                {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          ))}
        </div>
        <label htmlFor="tone_notes">Voice notes (phrases you use, things to avoid)</label>
        <textarea id="tone_notes" value={String(s.tone_notes ?? "")} onChange={(e) => set("tone_notes", e.target.value)} />
        <label htmlFor="limit">Monthly spend limit (USD)</label>
        <input id="limit" type="number" min={0} value={String(s.monthly_spend_limit_usd ?? "")} onChange={(e) => set("monthly_spend_limit_usd", e.target.value)} />
        <p className="row"><button className="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>{saved && <span className="muted">Saved</span>}{err && <span className="error">{err}</span>}</p>
      </div>
      <div className="side-stack">
      <div className="card">
        <h2>Google</h2>
        <p className="muted small">Create Gmail drafts (never sent) and save audit reports to Google Drive.</p>
        {googleResult === "connected" && <p className="ok">Google connected.</p>}
        {googleResult === "failed" && <p className="error">Couldn't connect Google. Try again.</p>}
        {!google ? <p className="muted">Checking…</p>
          : !google.configured ? <p className="muted small">Not set up yet: add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> secrets (see README).</p>
          : google.connected ? <p className="row">Connected as <strong>{google.email ?? "your account"}</strong><button className="link-btn danger" onClick={disconnectGoogle}>Disconnect</button></p>
          : <a href="/api/google/connect"><button className="primary">Connect Google</button></a>}
      </div>
      <div className="card">
        <h2>This month</h2>
        <table><tbody>
          {usage.map((u) => <tr key={u.service}><td>{u.service}</td><td>{u.units} calls</td><td>${u.est_cost_usd.toFixed(2)}</td></tr>)}
          <tr><td><strong>Total</strong></td><td /><td><strong>${total.toFixed(2)}</strong> of ${(parseSpendLimit(s.monthly_spend_limit_usd) ?? 0).toFixed(2)}</td></tr>
        </tbody></table>
      </div>
      </div>
    </div>
  );
}
