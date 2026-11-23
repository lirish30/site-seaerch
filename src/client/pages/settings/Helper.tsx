import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { Chip } from "../../components/ds";
import Icon from "../../components/Icon";
import SettingsPage, { Callout } from "../../components/SettingsPage";
import { helperLine, type HelperStatus } from "../../helperView";
import { meetilyLine } from "../../meetingsView";
import type { MeetilySyncStatus } from "../../../worker/routes/meetings";

interface Device { id: string; name: string; created_at: string; last_seen_at: string | null }
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Settings > Mac helper: whether it is running, the Macs paired to it, and pairing a new one. A pairing token is shown once and never again. */
export default function Helper() {
  const [status, setStatus] = useState<HelperStatus | null | false>(null);
  const [meetily, setMeetily] = useState<MeetilySyncStatus | null | false>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [devices, setDevices] = useState<Device[] | null | false>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => {
    api.get<HelperStatus>("/helper/status").then(setStatus).catch(() => setStatus(false));
    api.get<MeetilySyncStatus>("/meetings/sync-status").then(setMeetily).catch(() => setMeetily(false));
    api.get<{ devices: Device[] }>("/helper/devices").then((r) => setDevices(r.devices)).catch(() => setDevices(false));
  }, []);
  useEffect(load, [load]);

  async function pair() {
    setBusy(true); setMsg(""); setCopied(false);
    try {
      const made = await api.post<{ token: string; device: Device }>("/helper/devices", { name });
      setFresh({ name: made.device.name, token: made.token }); setName(""); load();
    } catch (e) { setMsg(e instanceof ApiError ? e.message : "Couldn't pair that Mac."); }
    setBusy(false);
  }
  async function syncNow() {
    setSyncing(true); setSyncMsg("");
    try {
      const r = await api.post<{ queued: boolean; reason?: "no windows" | "already queued" }>("/meetings/sync");
      setSyncMsg(r.queued ? "Asked your Mac to look at Meetily. It runs the next time the helper checks in." : r.reason === "already queued" ? "A sync is already waiting for your Mac." : "Nothing to look for: no booked call or calendar meeting in the last three days.");
      load();
    } catch (e) { setSyncMsg(e instanceof ApiError ? e.message : "Couldn't ask for a sync."); }
    setSyncing(false);
  }
  async function remove(id: string) {
    setMsg("");
    try { await api.del(`/helper/devices/${id}`); load(); } catch { setMsg("Couldn't remove that Mac."); }
  }
  const copy = () => { if (fresh) void navigator.clipboard?.writeText(fresh.token).then(() => setCopied(true), () => setCopied(false)); };
  const pending = status ? Object.entries(status.pending).filter(([, n]) => n > 0) : [];

  return (
    <SettingsPage title="Mac helper" width={760} sub="A small app on your Mac makes the cloned voice and renders the video. It asks this site for work, so nothing here needs to reach into your Mac."
      badge={status ? (status.online ? <Chip tone="positive" dot>Online</Chip> : <Chip tone="outline" dot>Offline</Chip>) : undefined}>
      <div className="bx sox">
        <section className="st-card">
          <header><div><h2>Status</h2><p>What the helper is doing and what it reads for you.</p></div></header>
          <ul className="sox-list">
            <li className="sox-row">
              {status === null && <p className="sox-sub">Loading…</p>}
              {status === false && <p className="bx-err" role="alert">Couldn't load the helper's state.</p>}
              {status && <>
                <span className={`sox-tile ${status.online ? "positive" : "warning"}`}><Icon name="zap" size={16} /></span>
                <div className="sox-main">
                  <b>{helperLine(status)}</b>
                  <small>{status.lastSeenAt ? `Last seen ${new Date(status.lastSeenAt).toLocaleString()}` : "Never seen: pair a Mac below, then start the helper on it."}</small>
                </div>
                {pending.length > 0 && <div className="sox-side">{pending.map(([k, n]) => <Chip key={k} tone="info">{k}: {n} open</Chip>)}</div>}
              </>}
            </li>
            <li className="sox-row">
              <span className="sox-tile info"><Icon name="phone" size={16} /></span>
              <div className="sox-main">
                <b>Meetily</b>
                {meetily === null && <small>Loading…</small>}
                {meetily === false && <small className="bad">Couldn't load Meetily's sync state.</small>}
                {meetily && <small>{meetilyLine(meetily)}</small>}
                <small>Your Mac sends the recordings that match a booked call or a calendar meeting. It also looks every 15 minutes by itself.</small>
                {syncMsg && <small role="status" style={{ color: "var(--text)" }}>{syncMsg}</small>}
              </div>
              <div className="sox-side"><button type="button" className="btn sm" disabled={syncing} onClick={() => void syncNow()}><Icon name="refresh" size={13} />{syncing ? "Asking…" : "Sync now"}</button></div>
            </li>
          </ul>
        </section>

        <section className="st-card">
          <header>
            <div><h2>Paired Macs</h2><p>Removing a Mac stops its token working at once.</p></div>
            {Array.isArray(devices) && devices.length > 0 && <Chip tone="outline">{devices.length} paired</Chip>}
          </header>
          {devices === null && <p className="sox-row sox-sub">Loading…</p>}
          {devices === false && <p className="sox-row bx-err" role="alert">Couldn't load your Macs.</p>}
          <ul className="sox-list">
            {Array.isArray(devices) && devices.map((d) => (
              <li key={d.id} className="sox-row">
                <span className={`sox-tile ${d.last_seen_at ? "" : "warning"}`}><Icon name="smartphone" size={16} /></span>
                <div className="sox-main"><b>{d.name}</b><small>Paired {day(d.created_at)} · {d.last_seen_at ? `last seen ${day(d.last_seen_at)}` : "never seen: start the helper on it"}</small></div>
                <button type="button" className="btn sm" onClick={() => void remove(d.id)}>Remove</button>
              </li>
            ))}
            <li>
              <form className="sox-row" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !busy) void pair(); }}>
                <span className="sox-tile signal"><Icon name="plus" size={16} /></span>
                <div className="sox-main">
                  <b>{Array.isArray(devices) && devices.length === 0 ? "Pair your first Mac" : "Pair another Mac"}</b>
                  <small>You get a token to paste into the helper. It is shown once: this site keeps only a fingerprint of it.</small>
                </div>
                <div className="sox-side">
                  <input id="hp-name" className="in sox-w" aria-label="Name for this Mac" placeholder="Studio Mac" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                  <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy ? "Pairing…" : "Pair this Mac"}</button>
                </div>
              </form>
            </li>
          </ul>
          {(msg || fresh) && (
            <div className="st-card-body">
              {msg && <p className="bx-err" role="alert">{msg}</p>}
              {fresh && (
                <Callout tone="warn" icon="key" action={<button type="button" className="btn sm" onClick={copy}><Icon name={copied ? "check" : "copy"} size={13} />{copied ? "Copied" : "Copy"}</button>}>
                  Token for {fresh.name}. Copy it now, it will not be shown again: <code>{fresh.token}</code>
                </Callout>
              )}
            </div>
          )}
        </section>
      </div>
    </SettingsPage>
  );
}
