import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import Icon from "./Icon";
import ParagraphEditor from "./ParagraphEditor";
import { initials } from "../scoreView";
import { findingChip } from "../evidenceView";
import { EmailFrame } from "./SignatureBuilder";
import InlineError from "./InlineError";
import type { CroItem, CroResponse } from "../cro";
import type { Audit, Contact } from "../types";
import {
  gapsMessage, mailtoHref, profileGaps, PURPOSE_HINT, PURPOSE_LABEL, purposeSwitchNotice, snippet, TWEAK_BUTTONS, variantTitle, wordCount,
  type Draft, type Purpose, type WorkSample,
} from "../emailView";

const TONE_OPTIONS: [string, string][] = [["", "Default tone (from Settings)"], ["friendly_local", "Friendly local"], ["consultative", "Consultative expert"], ["direct", "Direct & short"], ["formal", "Formal"]];
const MAX_PICKS = 5;

export interface ComposerHandle {
  /** Saves any edits. Resolves true when nothing is left unsaved. */
  save(): Promise<boolean>;
}

interface Profile { role_title: string; bio: string; goal_line: string; default_purpose: Purpose }
interface Composed { html: string; text: string }
interface Props {
  leadId: string; draft: Draft | null; variants: Draft[]; toContact: Contact | null; suppressed: boolean; lowPriority: boolean;
  findings: Audit["findings"];
  /** Reloads the lead after the draft changed on the server. */
  onChanged: () => Promise<void>;
  onMessage: (m: string) => void;
  onMarkContacted: () => Promise<boolean>;
  /** The issues picked to build the email on. Controlled by the lead page so the Website issues tab's "Use in email" boxes share it. */
  focus?: Set<string>; onFocusChange?: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Saves the draft to Gmail (the lead page owns that request). */
  onGmailDraft?: () => void; gmailBusy?: boolean;
}

/** The opening "Hi Dana," line is skipped in a card's preview so the snippet starts with what the email says. */
const withoutGreeting = (b: string) => b.replace(/^\s*(hi|hello|hey|dear)\b[^\n]{0,40},?\s*\n+/i, "");
const toggle = <T,>(set: React.Dispatch<React.SetStateAction<Set<T>>>, key: T) =>
  set((p) => { const n = new Set(p); if (n.has(key)) n.delete(key); else if (n.size < MAX_PICKS) n.add(key); return n; });

/**
 * Writing an email for a lead: choose what it's for, pick one of a few differently-angled options, edit it next to a
 * live preview of the real email (signature and all), and nudge it with quick rewrites.
 */
const EmailComposer = forwardRef<ComposerHandle, Props>(function EmailComposer(p, ref) {
  const { leadId, draft, variants, toContact, suppressed } = p;
  const [subject, setSubject] = useState(draft?.subject ?? ""); const [body, setBody] = useState(draft?.body ?? "");
  const [footer, setFooter] = useState(draft?.include_footer ?? false);
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [side, setSide] = useState<"preview" | "write">("preview");
  const [profile, setProfile] = useState<Profile | null>(null); const [samples, setSamples] = useState<WorkSample[] | null>(null);
  const [preview, setPreview] = useState<Composed | null>(null);
  const [versions, setVersions] = useState<Draft[]>([]);
  const [croItems, setCroItems] = useState<CroItem[]>([]);
  const [tone, setTone] = useState(""); const [steer, setSteer] = useState("");
  const [ownFocus, setOwnFocus] = useState<Set<string>>(new Set());
  const focus = p.focus ?? ownFocus; const setFocus = p.onFocusChange ?? setOwnFocus;
  const [croFocus, setCroFocus] = useState<Set<string>>(new Set()); const [pickIds, setPickIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const [showAllChips, setShowAllChips] = useState(false); const [versionsOpen, setVersionsOpen] = useState(false);
  const previewDialog = useRef<HTMLDialogElement>(null);

  const saved = useRef({ subject: draft?.subject ?? "", body: draft?.body ?? "", footer: draft?.include_footer ?? false });
  const latest = useRef({ subject, body, footer, draftId: draft?.id ?? null });
  latest.current = { subject, body, footer, draftId: draft?.id ?? null };
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const previewTick = useRef(0);

  // A different draft (a new set of options, a picked option, an earlier version) replaces the editor's contents.
  useEffect(() => {
    saved.current = { subject: draft?.subject ?? "", body: draft?.body ?? "", footer: draft?.include_footer ?? false };
    setSubject(saved.current.subject); setBody(saved.current.body); setFooter(saved.current.footer);
    setPurpose(null); setError("");
  }, [draft?.id]);

  useEffect(() => {
    api.get<{ settings: Profile }>("/settings").then((r) => setProfile(r.settings)).catch(() => setProfile(null));
    api.get<WorkSample[]>("/work-samples").then(setSamples).catch(() => setSamples([]));
    api.get<CroResponse>(`/leads/${leadId}/cro-audit`).then((r) => {
      const usable = r.audit?.status === "done" ? r.items.filter((i) => i.included) : [];
      setCroItems(usable);
      setCroFocus((s) => new Set([...s].filter((k) => usable.some((i) => i.id === k)))); // drop picks from an older audit
    }).catch(() => { setCroItems([]); setCroFocus(new Set()); });
  }, [leadId]);
  useEffect(() => { api.get<Draft[]>(`/leads/${leadId}/drafts`).then(setVersions).catch(() => setVersions([])); }, [leadId, draft?.id]);

  // The preview is the email as it will be saved to Gmail, so it reflects unsaved edits and the footer choice.
  useEffect(() => {
    if (!draft || !subject.trim() || !body.trim()) { setPreview(null); return; }
    const mine = ++previewTick.current;
    const t = setTimeout(() => {
      api.post<Composed>(`/leads/${leadId}/draft/preview`, { subject, body, include_footer: footer })
        .then((r) => { if (mine === previewTick.current) setPreview(r); }).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [leadId, draft?.id, subject, body, footer]);

  async function doSave(): Promise<boolean> {
    const l = latest.current;
    if (!l.draftId) return true;
    if (l.subject === saved.current.subject && l.body === saved.current.body && l.footer === saved.current.footer) return true;
    if (!l.subject.trim() || !l.body.trim()) { p.onMessage("Add a subject and a message before saving."); return false; }
    try {
      await api.patch(`/leads/${leadId}/draft`, { subject: l.subject, body: l.body, include_footer: l.footer });
      saved.current = { subject: l.subject, body: l.body, footer: l.footer };
      return true;
    } catch (e) { p.onMessage((e as Error).message); return false; }
  }
  const save = () => (queue.current = queue.current.then(doSave));
  useImperativeHandle(ref, () => ({ save }));
  useEffect(() => { if (footer !== saved.current.footer) void save(); }, [footer]);

  const eff: Purpose = purpose ?? draft?.purpose ?? profile?.default_purpose ?? "full_time";
  const gaps = profile && samples ? gapsMessage(profileGaps(eff, profile, samples.length)) : "";
  const tab = draft ? side : "write";
  const words = wordCount(body);

  async function write(extra: Record<string, unknown>, done: string) {
    if (!(await save())) return;
    setBusy(extra.tweak ? String(extra.tweak) : "write"); setError(""); p.onMessage("");
    try { await api.post(`/leads/${leadId}/regenerate`, extra); await p.onChanged(); p.onMessage(done); }
    catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }
  function writeOptions() {
    // Finding keys are "code:index" into the audit's findings.
    const focusIdx = [...focus].map((k) => Number(k.split(":").pop())).filter(Number.isInteger);
    const picked = focusIdx.length + croFocus.size;
    void write({
      purpose: eff, steeringNote: steer, focus: focusIdx, croFocus: [...croFocus], tone: tone || null,
      ...(eff === "full_time" && pickIds.size ? { sampleIds: [...pickIds] } : {}),
    }, picked ? `New options focused on ${picked} chosen issue(s).` : "New options written.");
    setSteer("");
  }
  const tweak = (key: string, label: string) => void write({ tweak: key }, `Rewrote it: ${label.toLowerCase()}.`);

  async function pick(v: Draft) {
    if (v.id === draft?.id) return;
    if (!(await save())) return;
    setError("");
    try { await api.post(`/leads/${leadId}/draft/select`, { draftId: v.id }); await p.onChanged(); }
    catch (e) { setError((e as Error).message); }
  }

  /** The email exactly as it will be saved, fetched fresh so a copy never misses the last keystroke. */
  async function composedText(): Promise<string | null> {
    if (!(await save())) return null;
    try { return (await api.post<Composed>(`/leads/${leadId}/draft/preview`, { subject, body, include_footer: footer })).text; }
    catch (e) { p.onMessage((e as Error).message); return null; }
  }
  async function copy(): Promise<boolean> {
    const text = await composedText();
    if (text === null) return false;
    try { await navigator.clipboard.writeText(`Subject: ${subject}\n\n${text}`); p.onMessage("Copied"); return true; }
    catch (e) { p.onMessage((e as Error).message); return false; }
  }
  async function copyAndMark() { if (await copy() && await p.onMarkContacted()) p.onMessage("Copied and marked contacted"); }

  const mailto = toContact && preview ? mailtoHref(toContact.value, subject, preview.text) : null;
  const switchNotice = draft ? purposeSwitchNotice(draft.purpose, eff) : null;
  const sampleChoices = eff === "full_time" ? samples ?? [] : [];

  const ranked = p.findings.map((f, i) => ({ f, key: `${f.code}:${i}` }))
    .sort((a, b) => ({ critical: 0, important: 1, nice: 2 }[a.f.severity] - { critical: 0, important: 1, nice: 2 }[b.f.severity]) || b.f.points - a.f.points);
  const chips: { id: string; label: string; on: boolean; disabled: boolean; toggle: () => void; kind: "finding" | "cro" | "sample" }[] = [
    ...ranked.map(({ f, key }) => ({ id: `f:${key}`, label: findingChip(f), on: focus.has(key), disabled: !focus.has(key) && focus.size >= MAX_PICKS, toggle: () => toggle(setFocus, key), kind: "finding" as const })),
    ...croItems.map((i) => ({ id: `c:${i.id}`, label: i.title.length > 32 ? `${i.title.slice(0, 31)}…` : i.title, on: croFocus.has(i.id), disabled: !croFocus.has(i.id) && croFocus.size >= MAX_PICKS, toggle: () => toggle(setCroFocus, i.id), kind: "cro" as const })),
    ...sampleChoices.map((w) => ({ id: `s:${w.id}`, label: w.title, on: pickIds.has(w.id), disabled: !pickIds.has(w.id) && pickIds.size >= 2,
      toggle: () => setPickIds((s) => { const n = new Set(s); if (n.has(w.id)) n.delete(w.id); else if (n.size < 2) n.add(w.id); return n; }), kind: "sample" as const })),
  ];
  // Picked chips always stay visible, even past the first eight.
  const shownChips = showAllChips ? chips : chips.filter((c, i) => i < 8 || c.on);
  const picked = focus.size + croFocus.size + pickIds.size;
  const toName = toContact?.person_name ?? null;

  return (
    <div className="composer">
      <div className="purpose-row">
        <div className="purpose-seg" role="group" aria-label="What is this email for?">
          {(["full_time", "freelance"] as Purpose[]).map((x) => (
            <button key={x} className={eff === x ? "on" : ""} aria-pressed={eff === x} onClick={() => setPurpose(x)}><Icon name={x === "full_time" ? "briefcase" : "zap"} size={14} />{PURPOSE_LABEL[x]}</button>
          ))}
        </div>
        <p>{PURPOSE_HINT[eff]}</p>
      </div>
      {switchNotice && <p className="hint">{switchNotice}</p>}
      {gaps && <p className="hint">{gaps} <Link to="/settings">Open Settings</Link></p>}

      {variants.length > 1 && <section aria-label="Options" className="variants">
        <p className="kicker">Pick a starting point</p>
        <div className="variant-grid">
          {variants.map((v, i) => {
            const on = v.id === draft?.id;
            return (
              <button key={v.id} className={`variant${on ? " on" : ""}`} aria-pressed={on} onClick={() => void pick(v)}>
                <span className="v-top"><span className="v-angle">{variantTitle(v, i)}</span>{on && <Icon name="check" size={14} />}</span>
                <span className="v-subject">{on ? subject : v.subject}</span>
                <span className="v-snip">{snippet(withoutGreeting(on ? body : v.body), 90)}</span>
              </button>
            );
          })}
        </div>
      </section>}

      {draft ? (
        <section className="compose-card" aria-label="Email">
          <div className="c-row c-to">
            <span className="c-label">To</span>
            {toContact
              ? <span className="to-chip"><span className="avatar-xs" aria-hidden="true">{initials(toName ?? toContact.value)}</span>{toName ? `${toName} <${toContact.value}>` : toContact.value}</span>
              : <span className="c-none">No email address found. Add a point of contact.</span>}
            <span className="grow" />
            <span className="c-reason">{draft.recipient_reason}</span>
          </div>
          <div className="c-row c-subject">
            <label className="c-label" htmlFor="subj">Subject</label>
            <input id="subj" value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={() => void save()} />
          </div>
          <ParagraphEditor value={body} onChange={setBody} onBlur={() => void save()} />
          <div className="c-meta">
            <span>{words} words · signature added automatically</span>
            <span className="grow" />
            <label className="switch sm"><input type="checkbox" role="switch" checked={footer} onChange={(e) => setFooter(e.target.checked)} /><i aria-hidden="true" /><span>Mailing address & opt-out line</span></label>
          </div>
          <div className="c-row c-tweaks" role="group" aria-label="Quick rewrites">
            <Icon name="sparkles" size={14} className="spark" /><b>Quick rewrite</b>
            {TWEAK_BUTTONS.filter((t) => !t.fullTimeOnly || draft.purpose === "full_time").map((t) => (
              <button key={t.key} className="pill" onClick={() => tweak(t.key, t.label)} disabled={!!busy || suppressed || !!switchNotice}
                title={suppressed ? "Suppressed: drafting is turned off" : switchNotice ?? ""}>{busy === t.key ? "Rewriting…" : t.label}</button>
            ))}
          </div>
          <div className="c-row c-actions">
            <button className="btn" onClick={() => void copy()}><Icon name="copy" size={16} />Copy email</button>
            {mailto && !suppressed && <a className="btn" href={mailto} onClick={() => void save()}><Icon name="external" size={16} />Open in mail app</a>}
            <button className="btn icon-only" onClick={() => previewDialog.current?.showModal()} disabled={!preview} aria-label="Preview the email" title="Preview the email as it will appear"><Icon name="eye" size={16} /></button>
            {versions.length > 1 && (
              <span className="versions-wrap">
                <button className="btn-plain" aria-expanded={versionsOpen} onClick={() => setVersionsOpen((o) => !o)}><Icon name="clock" size={16} />Earlier versions ({versions.length - 1})</button>
                {versionsOpen && (
                  <div className="popover versions-pop" role="dialog" aria-label="Earlier versions">
                    {versions.map((v) => (
                      <div key={v.id} className={`ver${v.id === draft.id ? " current" : ""}`}>
                        <span><b>{v.subject}</b><small>{new Date(v.created_at).toLocaleString()}{v.steering_note && ` · “${v.steering_note}”`}</small></span>
                        {v.id === draft.id ? <small>Current</small> : <button className="link-btn" onClick={() => { setVersionsOpen(false); void pick(v); }}>Use</button>}
                      </div>
                    ))}
                  </div>
                )}
              </span>
            )}
            <span className="grow" />
            {p.onGmailDraft && <button className="btn" onClick={p.onGmailDraft} disabled={p.gmailBusy || suppressed}><Icon name="mail" size={16} />{p.gmailBusy ? "Saving…" : "Create Gmail draft"}</button>}
            <button className="btn primary" onClick={() => void copyAndMark()} disabled={suppressed}><Icon name="check" size={16} />Copy & mark contacted</button>
          </div>
          <dialog ref={previewDialog} className="preview-dialog" onClick={(e) => { if (e.target === previewDialog.current) previewDialog.current?.close(); }}>
            <div className="pd-head"><b>Email preview</b><span className="muted small">Subject: {subject || "—"}</span><span className="grow" /><button className="btn sm" onClick={() => previewDialog.current?.close()}>Close</button></div>
            {preview ? <EmailFrame html={preview.html} title="Email preview" height={460} /> : <p className="muted small">The preview appears as you type.</p>}
            <p className="muted small">This is how it will look in the Gmail draft. Nothing is ever sent from here.</p>
          </dialog>
        </section>
      ) : <p className="muted">No email yet{p.lowPriority ? " (low priority lead)" : ""}. Choose what it's for, then write the options.</p>}

      <section className="write-card" aria-label="Write new options">
        <div className="w-head">
          <Icon name="refresh" size={15} /><h3>{draft ? "Write new options" : "Write the email"}</h3>
          <span className="grow" />
          {picked > 0 && <button className="link-btn" onClick={() => { setFocus(new Set()); setCroFocus(new Set()); setPickIds(new Set()); }}>Clear {picked} selected</button>}
          <button className="btn primary sm" onClick={writeOptions} disabled={!!busy || suppressed} title={suppressed ? "Suppressed: drafting is turned off" : ""}>
            <Icon name="sparkles" size={14} />{busy === "write" ? "Writing…" : draft ? "Write 3 options" : "Write options"}
          </button>
        </div>
        <div className="w-fields">
          <div><label htmlFor="tone">Tone</label>
            <span className="field"><select id="tone" value={tone} onChange={(e) => setTone(e.target.value)}>{TONE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{v === "" ? "Friendly local (default)" : l}</option>)}</select><Icon name="chevron-down" size={14} className="chev" /></span></div>
          <div><label htmlFor="steer">Extra instruction</label>
            <span className="field"><input id="steer" placeholder="e.g. mention I’m local, ask about their winter rush" value={steer} onChange={(e) => setSteer(e.target.value)} /></span></div>
        </div>
        {chips.length > 0 && (
          <div className="w-chips" role="group" aria-label="Build the options on">
            <span className="c-lbl">Build on</span>
            {shownChips.map((c) => (
              <button key={c.id} className={`chip-pick${c.on ? " on" : ""}`} aria-pressed={c.on} disabled={c.disabled} title={c.disabled ? `Up to ${c.kind === "sample" ? 2 : MAX_PICKS} can be picked` : undefined} onClick={c.toggle}>
                {c.on && <Icon name="check" size={12} />}{c.label}
              </button>
            ))}
            {chips.length > shownChips.length || showAllChips ? <button className="chip-pick more" onClick={() => setShowAllChips((x) => !x)}>{showAllChips ? "Show fewer" : `+${chips.length - shownChips.length} more`}</button> : null}
          </div>
        )}
        <InlineError message={error} />
      </section>
    </div>
  );
});

export default EmailComposer;
