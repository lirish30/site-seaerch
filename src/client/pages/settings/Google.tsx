import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import Icon from "../../components/Icon";
import SettingsPage, { Card } from "../../components/SettingsPage";
import { Pill, Toggle } from "../../components/settingsBits";
import { useSettingsDoc } from "../../settingsData";
import { PERMISSIONS, sinceLabel } from "../../settingsView";

interface GoogleStatus { configured: boolean; connected: boolean; email: string | null; connected_at?: string }

/** Settings > Google: whether Gmail drafts and Drive saves are connected, and what the connection can do. */
export default function Google() {
  const doc = useSettingsDoc();
  const [params, setParams] = useSearchParams();
  const result = params.get("google");
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [statusErr, setStatusErr] = useState("");
  const [busy, setBusy] = useState(false); const [actionErr, setActionErr] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(() => {
    setStatusErr("");
    return api.get<GoogleStatus>("/google/status").then((s) => { if (alive.current) setStatus(s); })
      .catch((e) => { if (alive.current) setStatusErr(e instanceof ApiError ? e.message : "Couldn't check the Google connection."); });
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function disconnect() {
    if (!window.confirm("Disconnect Google? Exports to Gmail and Drive will stop until you reconnect.")) return;
    setBusy(true); setActionErr("");
    try {
      await api.post("/google/disconnect");
      if (alive.current) { setParams({}, { replace: true }); await load(); }
    } catch (e) { if (alive.current) setActionErr(`Couldn't disconnect: ${e instanceof ApiError ? e.message : "request failed"}`); }
    finally { if (alive.current) setBusy(false); }
  }

  const connected = !!status?.connected;
  const badge = !status ? null : connected ? <Pill tone="positive">Connected</Pill> : <Pill>{status.configured ? "Not connected" : "Not set up"}</Pill>;
  return (
    <SettingsPage title="Google" width={720} doc={doc} badge={badge} sub="Gmail drafts and Drive files. Siteline never sends email.">
      <div className="bx gg">
        {result === "connected" && connected && <p className="gg-banner ok" role="status"><Icon name="check" size={14} />Google connected.</p>}
        {result === "failed" && <p className="gg-banner bad" role="alert"><Icon name="alert" size={14} />Couldn’t connect Google. Try again.</p>}
        <Card title="Connection">
          {statusErr ? <p className="bx-err" role="alert">{statusErr}</p>
            : !status ? <p className="bx-muted">Checking…</p>
            : (
              <div className="gg-conn">
                <span className="gg-g" aria-hidden="true">G</span>
                <div className="gg-who">
                  {connected ? <>
                    <b>Connected as {status.email ?? "your account"}</b>
                    <span>{status.connected_at ? `Since ${sinceLabel(status.connected_at)} · ` : ""}token stored encrypted</span>
                  </> : status.configured ? <>
                    <b>Not connected</b>
                    <span>Connect to create Gmail drafts and save reports to Drive.</span>
                  </> : <>
                    <b>Google isn’t set up yet</b>
                    <span>Add the <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> secrets (see the README), then connect.</span>
                  </>}
                </div>
                {connected && <button type="button" className="btn sm" onClick={() => void disconnect()} disabled={busy}>{busy ? "Disconnecting…" : "Disconnect"}</button>}
                {!connected && status.configured && <a className="btn primary" href="/api/google/connect">Connect Google</a>}
              </div>
            )}
          {actionErr && <p className="bx-err" role="alert">{actionErr}</p>}
        </Card>
        <Card title="What Siteline can do" sub="Only these two permissions are requested.">
          {PERMISSIONS.map((p) => (
            <div key={p.scope} className="gg-perm">
              <span className="gg-tile"><Icon name={p.icon} size={15} /></span>
              <div className="gg-who"><b>{p.title}</b><span>{p.text}</span></div>
              <span className="badge2 outline">{p.scope}</span>
            </div>
          ))}
        </Card>
        <Card title="Defaults">
          <div className="gg-def">
            <span id="gg-attach">Attach the audit PDF to Gmail drafts</span>
            <Toggle checked={doc.value("attach_audit_pdf") !== "0"} onChange={(on) => doc.set("attach_audit_pdf", on ? 1 : 0)} label="Attach the audit PDF to Gmail drafts" />
          </div>
        </Card>
        <p className="gg-note"><Icon name="shield" size={14} />Siteline only ever creates drafts. It never calls Gmail’s send endpoint.</p>
      </div>
    </SettingsPage>
  );
}
