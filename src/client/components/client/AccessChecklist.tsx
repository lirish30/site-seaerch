import { useState } from "react";
import { ApiError, clientsApi } from "../../api";
import { accessActions, accessTone, accessWords, problemText, serverProblem, vaultHint } from "../../clientView";
import { ACCESS_LABELS, noteProblem, vaultNameProblem } from "../../../worker/sites/access";
import type { AccessItem, AccessStatus } from "../../../worker/db/sites";
import type { ClientAccessItem } from "../../../worker/clients/record";
import { Meter } from "../ds";
import Icon from "../Icon";

const TONE = { neutral: "outline", good: "positive", warn: "warning" } as const;
const NOTE_MAX = 500;
const VAULT_MAX = 80;
const ANSWER_SHOWN = 400;

/** "3 Nov" or "3 Nov 2025" in the owner's own zone, from a stored timestamp. */
function stampDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

/**
 * The dates on a line. `requestedAt` keeps the FIRST ask and is never cleared, so it is only ever "Requested <date>": it says when you first asked, not how long you have been waiting.
 */
function stamps(i: AccessItem): string {
  const parts: string[] = [];
  if (i.requestedAt && (i.status === "requested" || i.status === "received" || i.status === "verified")) parts.push(`Requested ${stampDay(i.requestedAt)}`);
  if (i.receivedAt && (i.status === "received" || i.status === "verified")) parts.push(`Received ${stampDay(i.receivedAt)}`);
  if (i.verifiedAt && i.status === "verified") parts.push(`Verified ${stampDay(i.verifiedAt)}`);
  return parts.filter((p) => !p.endsWith(" ")).join(" · ");
}

function Row({ clientId, siteId, siteName, item, onChanged }: { clientId: string; siteId: string; siteName: string; item: ClientAccessItem; onChanged: () => Promise<void> }) {
  const meta = ACCESS_LABELS[item.key];
  const [vault, setVault] = useState(item.vaultItem ?? "");
  const [note, setNote] = useState(item.note ?? "");
  // The stored values we last saw. When a reload brings a different stored value, a field you have not touched follows it; one you are typing in stays as typed.
  const [storedVault, setStoredVault] = useState(item.vaultItem ?? "");
  const [storedNote, setStoredNote] = useState(item.note ?? "");
  if ((item.vaultItem ?? "") !== storedVault) { setStoredVault(item.vaultItem ?? ""); if (vault.trim() === storedVault) setVault(item.vaultItem ?? ""); }
  if ((item.note ?? "") !== storedNote) { setStoredNote(item.note ?? ""); if (note.trim() === storedNote) setNote(item.note ?? ""); }
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [vaultProblem, setVaultProblem] = useState<string | null>(null);
  const [noteError, setNoteError] = useState("");
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);
  const tone = accessTone(item.status);
  const id = `${siteId}-${item.key}`;
  const vaultDirty = vault.trim() !== (item.vaultItem ?? "");
  const noteDirty = note.trim() !== (item.note ?? "");
  const when = stamps(item);

  async function changeStatus(status: AccessStatus) {
    setBusy(true); setStatusError(""); setSaved(false);
    try { await clientsApi.setAccess(clientId, siteId, item.key, { status }); await onChanged(); }
    catch (e) { setStatusError(e instanceof ApiError ? problemText(e, "Could not change the status.", ["status"]) : "Could not change the status."); }
    finally { setBusy(false); }
  }

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    if (busy || (!vaultDirty && !noteDirty)) return;
    // Refuse here first, with the same checks the server makes, so a login never leaves the page. Neither problem repeats what was typed.
    const vp = vaultDirty ? vaultNameProblem(vault) : null;
    const np = noteDirty ? noteProblem(note) : null;
    setVaultProblem(vp); setNoteError(np ?? ""); setSaved(false);
    if (vp || np) return;
    const patch: { vaultItem?: string | null; note?: string | null } = {};
    if (vaultDirty) patch.vaultItem = vault.trim() || null;
    if (noteDirty) patch.note = note.trim() || null;
    setBusy(true);
    try {
      const next = await clientsApi.setAccess(clientId, siteId, item.key, patch);
      setVault(next.vaultItem ?? ""); setNote(next.note ?? ""); setSaved(true);
      await onChanged();
    } catch (err) {
      // The server's own refusal, in its words, beside the field it is about.
      if (err instanceof ApiError) {
        const v = serverProblem(err.body, "", ["vaultItem"]);
        const n = serverProblem(err.body, "", ["note"]);
        if (v) setVaultProblem(v);
        if (n) setNoteError(n);
        if (!v && !n) setNoteError(problemText(err, "Could not save."));
      } else setNoteError("Could not save.");
    } finally { setBusy(false); }
  }

  const moves = accessActions(item.status);
  const [next, ...rest] = moves;
  const TILE = { neutral: "neutral", good: "positive", warn: "warning" } as const;
  const ICON = { neutral: "ban", good: "check", warn: "key" } as const;
  return (
    <li className={`clx-acc ${tone}${open ? " open" : ""}`} aria-label={`${meta.label} access for ${siteName}`}>
      <div className="clx-acc-row">
        <span className={`ds-tile ${TILE[tone]}`}><Icon name={ICON[tone]} size={15} /></span>
        <button type="button" className="clx-acc-name" aria-expanded={open} aria-controls={`${id}-more`} onClick={() => setOpen(!open)}>
          <b>{meta.label}</b>
          <small>{item.vaultItem ? `“${item.vaultItem}”` : when || (item.status === "needed" ? "Not asked for yet" : accessWords(item.status))}</small>
        </button>
        <span className={`badge2 ${TONE[tone]}`}><i className="dot" />{accessWords(item.status)}</span>
        {next && item.status !== "verified" && item.status !== "not_applicable" && (
          <button type="button" className="btn sm clx-acc-next" disabled={busy} aria-label={`Mark ${accessWords(next).toLowerCase()}: ${meta.label} for ${siteName}`} onClick={() => void changeStatus(next)}>Mark {accessWords(next).toLowerCase()}</button>
        )}
        <button type="button" className="ds-icon-btn clx-acc-chev" aria-label={`${open ? "Hide" : "Show"} details for ${meta.label}`} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? "chevron-up" : "chevron-down"} size={14} /></button>
      </div>
      {statusError && <p className="error small" role="alert">{statusError}</p>}
      {open && (
        <div className="clx-acc-more" id={`${id}-more`}>
          <p className="clx-help">{meta.help}</p>
          {when && <p className="clx-acc-when"><Icon name="clock" size={13} />{when}</p>}
          {item.clientAnswer && (
            // The client's own words: untrusted, so plain text only (React escapes it; it is never a link), cut short, and labelled as possibly wrong.
            <blockquote className="clx-answer" aria-label={`What the client wrote about ${meta.label} for ${siteName}`}>
              <span>Client wrote (may be wrong)</span>
              <q>{item.clientAnswer.length > ANSWER_SHOWN ? `${item.clientAnswer.slice(0, ANSWER_SHOWN).trimEnd()}…` : item.clientAnswer}</q>
            </blockquote>
          )}
          <div className="clx-acc-moves" role="group" aria-label={`Change the status of ${meta.label}`}>
            <span className="ds-label">Mark as</span>
            {(item.status === "verified" || item.status === "not_applicable" ? moves : rest).map((st) => (
              <button key={st} type="button" className="btn sm" disabled={busy} onClick={() => void changeStatus(st)}>{accessWords(st)}</button>
            ))}
          </div>
          <form className="ds-form" onSubmit={(e) => void saveDetails(e)} noValidate>
            <label className="deal-field wide" htmlFor={`${id}-vault`}>
              <span>Password manager item</span>
              <input id={`${id}-vault`} type="text" value={vault} maxLength={VAULT_MAX + 40} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="Acme · WP admin"
                aria-label={`Password manager item for ${meta.label} on ${siteName}`} aria-describedby={`${id}-vault-hint`} aria-invalid={vaultProblem ? true : undefined}
                onChange={(e) => { setVault(e.target.value); setVaultProblem(null); setSaved(false); }} />
              <small id={`${id}-vault-hint`} className={vaultProblem ? "error" : undefined} role={vaultProblem ? "alert" : undefined}>{vaultHint(vaultProblem, vault)}</small>
            </label>
            <label className="deal-field wide" htmlFor={`${id}-note`}>
              <span>Note for you only</span>
              <textarea id={`${id}-note`} rows={2} value={note} maxLength={NOTE_MAX + 100} aria-label={`Note for you only: ${meta.label} on ${siteName}`} aria-describedby={`${id}-note-hint`}
                aria-invalid={noteError ? true : undefined}
                onChange={(e) => { setNote(e.target.value); setNoteError(""); setSaved(false); }} />
              <small id={`${id}-note-hint`} className={noteError ? "error" : undefined} role={noteError ? "alert" : undefined}>
                {noteError || "Describe the access in words. Never paste a password, key or login link."}
              </small>
            </label>
            <div className="ds-form-actions">
              <button type="submit" className="btn primary sm" disabled={busy || (!vaultDirty && !noteDirty)} aria-label={`Save details for ${meta.label} on ${siteName}`}>Save details</button>
              {saved && !vaultDirty && !noteDirty && <span className="clx-saved" role="status"><Icon name="check" size={14} />Saved.</span>}
            </div>
          </form>
        </div>
      )}
    </li>
  );
}

/** The six access lines of one site: a status you move along, the NAME of the password manager item, and a note only you see. Nothing here ever stores a login. */
export default function AccessChecklist({ clientId, siteId, siteName, items, onChanged }: {
  clientId: string; siteId: string; siteName: string; items: ClientAccessItem[]; onChanged: () => Promise<void>;
}) {
  const counted = items.filter((i) => i.status !== "not_applicable");
  const inHand = counted.filter((i) => i.status === "received" || i.status === "verified").length;
  const all = counted.length > 0 && inHand === counted.length;
  return (
    <section className="ds-card clx-access" aria-label={`Access checklist for ${siteName}`}>
      <header className="ds-card-head">
        <Icon name="key" size={16} />
        <h2>Access</h2>
        <span className="ds-card-note">{inHand} of {counted.length} in</span>
      </header>
      <div className="clx-access-top">
        <Meter value={inHand} max={Math.max(counted.length, 1)} tone={all ? "positive" : inHand === 0 ? "warning" : "signal"} label={`Access in: ${inHand} of ${counted.length}`} />
        <p className="clx-help">{all ? "Everything is in. Mark each one verified once you have logged in." : inHand === 0 ? "Nothing in yet. Ask the client for these, then mark each one as it arrives." : "Mark each one received as the client sends it."}</p>
      </div>
      <ul className="clx-acc-list">
        {items.map((item) => <Row key={item.key} clientId={clientId} siteId={siteId} siteName={siteName} item={item} onChanged={onChanged} />)}
      </ul>
    </section>
  );
}
