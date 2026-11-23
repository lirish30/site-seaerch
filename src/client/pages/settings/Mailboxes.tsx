import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { Chip } from "../../components/ds";
import Icon from "../../components/Icon";
import SettingsPage, { Callout } from "../../components/SettingsPage";
import type { Mailbox } from "../../types";
import MailboxCard from "./MailboxCard";

/** Settings > Outreach > Mailboxes: the outreach and main mailboxes, their warm-up clock and the reply check. */
export default function Mailboxes() {
  const [boxes, setBoxes] = useState<Mailbox[] | null>(null);
  const [err, setErr] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(() => api.get<{ mailboxes: Mailbox[] }>("/mailboxes")
    .then((r) => { if (alive.current) { setBoxes(r.mailboxes); setErr(""); } })
    .catch((e) => { if (alive.current) setErr(e instanceof ApiError ? e.message : "Couldn't load the mailboxes."); }), []);
  useEffect(() => { void load(); }, [load]);
  const replace = (mb: Mailbox) => setBoxes((all) => all && all.map((m) => (m.key === mb.key ? mb : m)));
  const on = boxes ? boxes.filter((m) => m.enabled === 1).length : 0;
  return (
    <SettingsPage title="Mailboxes" width={820} sub="Where outreach is sent from and where replies are checked. Passwords are Worker secrets, never saved here."
      badge={boxes ? <Chip tone={on ? "positive" : "outline"} dot>{on} of {boxes.length} on</Chip> : undefined}>
      <div className="bx sox">
        {err ? <Callout tone="critical" icon="alert">{err}</Callout>
          : !boxes ? <p className="st-loading">Loading…</p>
          : boxes.map((mb) => <MailboxCard key={mb.key} mailbox={mb} onChange={replace} />)}
        <p className="sox-foot"><Icon name="shield" size={14} />A new outreach mailbox sends nothing cold for 30 days while it warms up. The reply check runs on its own; the button runs it now.</p>
      </div>
    </SettingsPage>
  );
}
