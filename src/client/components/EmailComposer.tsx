import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { FindingsList } from "./AuditPanel";
import { EmailFrame } from "./SignatureBuilder";
import InlineError from "./InlineError";
import type { CroItem, CroResponse } from "../cro";
import type { Audit, Contact } from "../types";
import {
  gapsMessage, mailtoHref, profileGaps, PURPOSE_HINT, PURPOSE_LABEL, snippet, TWEAK_BUTTONS, variantTitle, wordCount,
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
}

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
  const [focus, setFocus] = useState<Set<string>>(new Set()); const [croFocus, setCroFocus] = useState<Set<string>>(new Set()); const [pickIds, setPickIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(""); const [error, setError] = useState("");

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
  const sampleChoices = eff === "full_time" ? samples ?? [] : [];

  return (
    <div className="card composer">
      <div className="composer-top">
        <div className="segmented" role="group" aria-label="What is this email for?">
          {(["full_time", "freelance"] as Purpose[]).map((x) => (
            <button key={x} className={eff === x ? "on" : ""} aria-pressed={eff === x} onClick={() => setPurpose(x)}>{PURPOSE_LABEL[x]}</button>
          ))}
        </div>
        <p className="muted small">{PURPOSE_HINT[eff]}</p>
        {draft && draft.purpose !== eff && <p className="muted small">The email below was written for {PURPOSE_LABEL[draft.purpose].toLowerCase()}. Write new options to switch.</p>}
        {gaps && <p className="hint">{gaps} <Link to="/settings">Open Settings</Link></p>}
      </div>

      {variants.length > 1 && <section aria-label="Options" className="variants">
        <h3>Pick a starting point</h3>
        <div className="variant-grid">
          {variants.map((v, i) => (
            <button key={v.id} className={`variant${v.id === draft?.id ? " on" : ""}`} aria-pressed={v.id === draft?.id} onClick={() => void pick(v)}>
              <strong>{variantTitle(v, i)}</strong>
              <span className="small">{v.id === draft?.id ? subject : v.subject}</span>
              <span className="muted small">{snippet(v.id === draft?.id ? body : v.body)}</span>
            </button>
          ))}
        </div>
      </section>}

      <div className="email-grid">
        <div>
          {draft ? <>
            <p><strong>To:</strong> {toContact?.value ?? "—"} <span className="muted">({draft.recipient_reason})</span></p>
            <label htmlFor="subj">Subject</label>
            <input id="subj" value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={() => void save()} />
            <label htmlFor="body">Message</label>
            <textarea id="body" style={{ minHeight: 320 }} value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => void save()} />
            <p className="muted small">{words} words · your signature is added automatically</p>
            <label className="check"><input type="checkbox" checked={footer} onChange={(e) => setFooter(e.target.checked)} /> Add my mailing address and opt-out line</label>
            <div className="tweaks" role="group" aria-label="Quick rewrites">
              <span className="muted small">Quick rewrite</span>
              {TWEAK_BUTTONS.filter((t) => !t.fullTimeOnly || draft.purpose === "full_time").map((t) => (
                <button key={t.key} onClick={() => tweak(t.key, t.label)} disabled={!!busy || suppressed}
                  title={suppressed ? "Suppressed: drafting is turned off" : ""}>{busy === t.key ? "Rewriting…" : t.label}</button>
              ))}
            </div>
            <p className="row">
              <button onClick={() => void copy()}>Copy email</button>
              {mailto && !suppressed && <a href={mailto} onClick={() => void save()}><button>Open in mail app</button></a>}
              <button className="primary" onClick={() => void copyAndMark()} disabled={suppressed}>Copy & mark contacted</button>
            </p>
          </> : <p className="muted">No email yet{p.lowPriority ? " (low priority lead)" : ""}. Choose what it's for, then write the options.</p>}

          {versions.length > 1 && <>
            <h3>Earlier versions</h3>
            <ul className="versions">{versions.map((v) => (
              <li key={v.id} className={v.id === draft?.id ? "current" : ""}>
                <span>{new Date(v.created_at).toLocaleString()} · {v.subject}{v.steering_note && <span className="muted"> · “{v.steering_note}”</span>}</span>
                {v.id !== draft?.id && <button className="link-btn" onClick={() => void pick(v)}>Use</button>}
              </li>
            ))}</ul>
          </>}
        </div>

        <div>
          {draft && <div className="segmented side-tabs" role="group" aria-label="Side panel">
            <button className={tab === "preview" ? "on" : ""} aria-pressed={tab === "preview"} onClick={() => setSide("preview")}>Preview</button>
            <button className={tab === "write" ? "on" : ""} aria-pressed={tab === "write"} onClick={() => setSide("write")}>Write new options</button>
          </div>}

          {tab === "preview" && draft && <div className="preview-pane">
            <p className="small"><span className="muted">Subject:</span> <strong>{subject || "—"}</strong></p>
            {preview ? <EmailFrame html={preview.html} title="Email preview" height={460} /> : <p className="muted small">The preview appears as you type.</p>}
            <p className="muted small">This is how it will look in the Gmail draft. Nothing is ever sent from here.</p>
          </div>}

          {tab === "write" && <div>
            <h3>{draft ? "Write new options" : "Write the email"}</h3>
            <label htmlFor="tone">Tone for this email</label>
            <select id="tone" value={tone} onChange={(e) => setTone(e.target.value)}>
              {TONE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label htmlFor="steer">Extra instruction (optional)</label>
            <input id="steer" placeholder="mention I'm local / ask about their summer rush" value={steer} onChange={(e) => setSteer(e.target.value)} />
            {sampleChoices.length > 0 && <>
              <label>Work to mention <span className="muted small">(optional; none = the best fit)</span></label>
              <div className="picker-box">{sampleChoices.map((w) => (
                <label key={w.id} className="row small check"><input type="checkbox" checked={pickIds.has(w.id)} disabled={!pickIds.has(w.id) && pickIds.size >= 2}
                  onChange={() => setPickIds((s) => { const n = new Set(s); if (n.has(w.id)) n.delete(w.id); else if (n.size < 2) n.add(w.id); return n; })} />{w.title}</label>
              ))}</div>
            </>}
            {p.findings.length > 0 && <>
              <label>Site issues to build on <span className="muted small">(pick up to {MAX_PICKS}; none = the most important)</span></label>
              <div className="picker-box"><FindingsList findings={p.findings} selectable selected={focus} onToggle={(k) => toggle(setFocus, k)} /></div>
            </>}
            {croItems.length > 0 && <>
              <label>CRO opportunities <span className="muted small">(from the CRO audit; pick up to {MAX_PICKS})</span></label>
              <div className="picker-box">{croItems.map((i) => (
                <label key={i.id} className="row small check"><input type="checkbox" checked={croFocus.has(i.id)} disabled={!croFocus.has(i.id) && croFocus.size >= MAX_PICKS}
                  onChange={() => toggle(setCroFocus, i.id)} />{i.title}</label>
              ))}</div>
            </>}
            <p className="row" style={{ marginTop: 12 }}>
              <button className="primary" onClick={writeOptions} disabled={!!busy || suppressed} title={suppressed ? "Suppressed: drafting is turned off" : ""}>
                {busy === "write" ? "Writing…" : draft ? "Write new options" : "Write options"}
              </button>
              {focus.size + croFocus.size > 0 && <button className="link-btn" onClick={() => { setFocus(new Set()); setCroFocus(new Set()); }}>Clear {focus.size + croFocus.size} selected</button>}
            </p>
          </div>}
          <InlineError message={error} />
        </div>
      </div>
    </div>
  );
});

export default EmailComposer;
