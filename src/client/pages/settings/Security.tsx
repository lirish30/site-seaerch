import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import SettingsPage, { Callout, Card, Field } from "../../components/SettingsPage";
import { passkeysSupported, registerPasskey } from "../../passkey";

interface PasskeyRow { id: string; nickname: string | null; created_at: string; last_used_at: string | null }
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Settings > Security: passkeys for Touch ID sign-in. The password always keeps working as a fallback. */
export default function Security() {
  const [rows, setRows] = useState<PasskeyRow[] | null | false>(null);
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { api.get<PasskeyRow[]>("/passkey").then(setRows).catch(() => setRows(false)); }, []);
  useEffect(load, [load]);

  async function add() {
    setBusy(true); setMsg("");
    const r = await registerPasskey(nickname.trim() || undefined);
    setBusy(false);
    if (r.ok) { setNickname(""); load(); } else setMsg(r.message);
  }
  async function remove(id: string) {
    setMsg("");
    try { await api.del(`/passkey/${id}`); load(); } catch { setMsg("Couldn't remove that passkey."); }
  }

  return (
    <SettingsPage title="Security" width={720} sub="Sign in with Touch ID or another passkey. Your password still works as a fallback.">
      <div className="bx">
        <Card title="Passkeys" sub="A passkey is tied to this site's address. If the address changes, add one again.">
          {rows === null && <p className="st-loading">Loading…</p>}
          {rows === false && <Callout tone="critical" icon="alert">Couldn't load your passkeys.</Callout>}
          {Array.isArray(rows) && (rows.length === 0
            ? <p className="st-loading">No passkeys yet.</p>
            : <ul className="st-list">{rows.map((p) => (
                <li key={p.id} className="st-list-row">
                  <div><b>{p.nickname || "Passkey"}</b><span> · added {day(p.created_at)}{p.last_used_at ? ` · last used ${day(p.last_used_at)}` : " · never used"}</span></div>
                  <button type="button" className="btn-plain" onClick={() => void remove(p.id)}>Remove</button>
                </li>
              ))}</ul>)}
        </Card>
        <Card title="Add a passkey">
          {!passkeysSupported() && <Callout tone="warn" icon="alert">This browser doesn't support passkeys.</Callout>}
          <Field label="Name (optional)" htmlFor="pk-name" help="For example, MacBook Touch ID.">
            <input id="pk-name" value={nickname} maxLength={60} onChange={(e) => setNickname(e.target.value)} />
          </Field>
          <button type="button" className="btn primary" disabled={busy || !passkeysSupported()} onClick={() => void add()}>{busy ? "Waiting for Touch ID…" : "Add a passkey"}</button>
          {msg && <div className="st-field"><p className="help err" role="alert">{msg}</p></div>}
        </Card>
      </div>
    </SettingsPage>
  );
}
