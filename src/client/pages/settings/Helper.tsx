import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import SettingsPage, { Callout, Card, Field } from "../../components/SettingsPage";
import { helperLine, type HelperStatus } from "../../helperView";

interface Device { id: string; name: string; created_at: string; last_seen_at: string | null }
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Settings > Mac helper: whether it is running, the Macs paired to it, and pairing a new one. A pairing token is shown once and never again. */
export default function Helper() {
  const [status, setStatus] = useState<HelperStatus | null | false>(null);
  const [devices, setDevices] = useState<Device[] | null | false>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const load = useCallback(() => {
    api.get<HelperStatus>("/helper/status").then(setStatus).catch(() => setStatus(false));
    api.get<{ devices: Device[] }>("/helper/devices").then((r) => setDevices(r.devices)).catch(() => setDevices(false));
  }, []);
  useEffect(load, [load]);

  async function pair() {
    setBusy(true); setMsg("");
    try {
      const made = await api.post<{ token: string; device: Device }>("/helper/devices", { name });
      setFresh({ name: made.device.name, token: made.token }); setName(""); load();
    } catch (e) { setMsg(e instanceof ApiError ? e.message : "Couldn't pair that Mac."); }
    setBusy(false);
  }
  async function remove(id: string) {
    setMsg("");
    try { await api.del(`/helper/devices/${id}`); load(); } catch { setMsg("Couldn't remove that Mac."); }
  }

  return (
    <SettingsPage title="Mac helper" width={720} sub="A small app on your Mac makes the cloned voice and renders the video. It asks this site for work, so nothing here needs to reach into your Mac.">
      <div className="bx">
        <Card title="Status">
          {status === null && <p className="st-loading">Loading…</p>}
          {status === false && <Callout tone="critical" icon="alert">Couldn't load the helper's state.</Callout>}
          {status && <p>{helperLine(status)}{status.lastSeenAt ? ` Last seen ${new Date(status.lastSeenAt).toLocaleString()}.` : ""}</p>}
        </Card>
        <Card title="Paired Macs" sub="Removing a Mac stops its token working at once.">
          {devices === null && <p className="st-loading">Loading…</p>}
          {devices === false && <Callout tone="critical" icon="alert">Couldn't load your Macs.</Callout>}
          {Array.isArray(devices) && (devices.length === 0
            ? <p className="st-loading">No Mac is paired yet.</p>
            : <ul className="st-list">{devices.map((d) => (
                <li key={d.id} className="st-list-row">
                  <div><b>{d.name}</b><span> · paired {day(d.created_at)}{d.last_seen_at ? ` · last seen ${day(d.last_seen_at)}` : " · never seen"}</span></div>
                  <button type="button" className="btn-plain" onClick={() => void remove(d.id)}>Remove</button>
                </li>
              ))}</ul>)}
        </Card>
        <Card title="Pair a Mac" sub="You get a token to paste into the helper. It is shown once: this site keeps only a fingerprint of it.">
          <Field label="Name" htmlFor="hp-name" help="For example, Studio Mac.">
            <input id="hp-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </Field>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={() => void pair()}>{busy ? "Pairing…" : "Pair this Mac"}</button>
          {msg && <div className="st-field"><p className="help err" role="alert">{msg}</p></div>}
          {fresh && (
            <Callout tone="warn" icon="key">
              Token for {fresh.name}. Copy it now, it will not be shown again: <code>{fresh.token}</code>
            </Callout>
          )}
        </Card>
      </div>
    </SettingsPage>
  );
}
