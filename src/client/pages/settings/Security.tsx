import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { Chip } from "../../components/ds";
import Icon from "../../components/Icon";
import SettingsPage, { Callout } from "../../components/SettingsPage";
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
  const supported = passkeysSupported();

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
  const count = Array.isArray(rows) ? rows.length : 0;

  return (
    <SettingsPage title="Security" width={760} sub="Sign in with Touch ID or another passkey. Your password still works as a fallback."
      badge={Array.isArray(rows) ? (count ? <Chip tone="positive" dot>{count} {count === 1 ? "passkey" : "passkeys"}</Chip> : <Chip tone="outline" dot>Password only</Chip>) : undefined}>
      <div className="bx sox">
        {!supported && <Callout tone="warn" icon="alert">This browser doesn't support passkeys. Open the app in Safari or Chrome on your Mac to add one.</Callout>}
        <section className="st-card">
          <header><div><h2>Passkeys</h2><p>A passkey is tied to this site's address. If the address changes, add one again.</p></div></header>
          {rows === null && <p className="sox-row sox-sub">Loading…</p>}
          {rows === false && <p className="sox-row bx-err" role="alert">Couldn't load your passkeys.</p>}
          <ul className="sox-list">
            {Array.isArray(rows) && rows.map((p) => (
              <li key={p.id} className="sox-row">
                <span className="sox-tile positive"><Icon name="key" size={16} /></span>
                <div className="sox-main"><b>{p.nickname || "Passkey"}</b><small>Added {day(p.created_at)} · {p.last_used_at ? `last used ${day(p.last_used_at)}` : "never used"}</small></div>
                <button type="button" className="btn sm" onClick={() => void remove(p.id)}>Remove</button>
              </li>
            ))}
            <li>
              <form className="sox-row" onSubmit={(e) => { e.preventDefault(); if (!busy && supported) void add(); }}>
                <span className="sox-tile signal"><Icon name="plus" size={16} /></span>
                <div className="sox-main"><b>{count ? "Add another passkey" : "Add your first passkey"}</b><small>Your Mac asks for Touch ID. The name is optional, for example MacBook Touch ID.</small></div>
                <div className="sox-side">
                  <input id="pk-name" className="in sox-w" aria-label="Name (optional)" placeholder="Name (optional)" value={nickname} maxLength={60} onChange={(e) => setNickname(e.target.value)} />
                  <button type="submit" className="btn primary" disabled={busy || !supported}>{busy ? "Waiting for Touch ID…" : "Add a passkey"}</button>
                </div>
              </form>
            </li>
          </ul>
          {msg && <div className="st-card-body"><p className="bx-err" role="alert">{msg}</p></div>}
        </section>
        <p className="sox-foot"><Icon name="shield" size={14} />Your password keeps working whatever you do here. Removing a passkey only stops that one device signing in with it.</p>
      </div>
    </SettingsPage>
  );
}
