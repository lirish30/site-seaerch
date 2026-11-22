import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, clientsApi, studioApi } from "../api";
import { latestOnly } from "../clientView";
import Icon, { type IconName } from "../components/Icon";
import { EmptyState } from "../components/PageBits";
import { KIND_LABEL, captionWithTags, copyEdit, copyOf, imageName, isOpen, nextAction, newPostBody, pickerKey, statusLabel, statusTone, type StudioKind, type StudioPost } from "../studioView";
import type { ClientRow } from "../../worker/clients/record";

const sentence = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);
const MAX_UPLOAD = 1024 * 1024;
const IMAGE_TYPES = "image/png,image/jpeg,image/webp";
const dayOf = (iso: string): string => iso.slice(0, 10);

/** One picture box for a before and after post. Checks the size here so the sentence comes before the upload. */
function PicturePicker({ label, onPick }: { label: string; onPick: (f: File | null) => void }) {
  return (
    <label className="deal-field"><span>{label}</span>
      <input type="file" accept={IMAGE_TYPES} onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
      <small>PNG, JPEG or WebP, up to 1 MB.</small>
    </label>
  );
}

const KINDS: { kind: StudioKind; icon: IconName; text: string; mock: string[] }[] = [
  { kind: "audit_tip", icon: "list", text: "Up to 6 slides of tips taken from a real audit's findings.", mock: ["ink", "", "", ""] },
  { kind: "before_after", icon: "image", text: "Your two screenshots side by side, with Claude's words on top.", mock: ["", "sig"] },
  { kind: "case_study", icon: "trending", text: "One card on a finished client: what was wrong and what changed.", mock: ["ink"] },
];

/** The New post form: the kind, what the kind needs, the two pictures for a before and after, and the anonymous box (unticked only once the client agreed). */
function NewPost({ clients, initialAudit, onMade }: { clients: ClientRow[]; initialAudit: string; onMade: () => Promise<void> }) {
  const [kind, setKind] = useState<StudioKind>("audit_tip");
  const [auditId, setAuditId] = useState(initialAudit);
  const [businessId, setBusinessId] = useState("");
  const [anonymous, setAnonymous] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [before, setBefore] = useState<File | null>(null);
  const [after, setAfter] = useState<File | null>(null);
  const [pickerEpoch, setPickerEpoch] = useState(0); // bumped to remount the two picture boxes empty (a file input cannot be cleared by state)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (initialAudit) { setKind("audit_tip"); setAuditId(initialAudit); } }, [initialAudit]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const made = newPostBody({ kind, auditId, businessId, anonymous, agreed });
    if ("problem" in made) { setError(made.problem); return; }
    const picked = kind === "before_after" ? [["before", before], ["after", after]] as const : [];
    const big = picked.find(([, f]) => f && f.size > MAX_UPLOAD);
    if (big) { setError("That image is over 1 MB; shrink it and try again."); return; }
    setBusy(true); setError("");
    let post: StudioPost | null = null;
    try {
      post = await studioApi.create(made.body);
      for (const [slot, file] of picked) if (file) await studioApi.upload(post.id, slot, file);
      setAuditId(""); setBefore(null); setAfter(null); setPickerEpoch((n) => n + 1); setAnonymous(true); setAgreed(false);
    } catch (err) {
      setError(post ? `The post was made, but a picture did not upload: ${sentence(err, "try again from the post")}` : sentence(err, "Couldn’t make the post. Try again."));
    } finally {
      setBusy(false);
      if (post) await onMade();
    }
  }

  return (
    <form className="hm-card pb-card st-new" onSubmit={(e) => void submit(e)} aria-label="New post">
      <header className="hm-card-head"><Icon name="plus" size={16} /><h2>New post</h2><span className="hm-head-note small">1080 × 1350 pictures, ready for Instagram and LinkedIn</span></header>
      <div className="hm-card-body">
      <fieldset className="st-kinds" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="sr-only">Kind of post</legend>
        {KINDS.map((k) => (
          <label key={k.kind} className={`st-kind${kind === k.kind ? " on" : ""}`}>
            <input type="radio" name="st-kind" value={k.kind} checked={kind === k.kind} onChange={() => { setKind(k.kind); setBefore(null); setAfter(null); setPickerEpoch((n) => n + 1); setError(""); }} />
            <span className="st-mock" aria-hidden="true">{k.mock.map((m, i) => <i key={i} className={m} />)}</span>
            <b><Icon name={k.icon} size={16} />{KIND_LABEL[k.kind]}</b>
            <span>{k.text}</span>
          </label>
        ))}
      </fieldset>
      <div className="cl-fields">
        {kind === "audit_tip" && (
          <label className="deal-field wide"><span>Which audit</span>
            <input value={auditId} onChange={(e) => setAuditId(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="Audit id" />
            <small>{auditId ? "Filled in from the lead you came from." : <>Open a lead with real findings and press <b>Post a tip</b> on its Website issues tab: it brings you back here with this filled in. <Link to="/leads">Go to leads</Link></>}</small>
          </label>
        )}
        {kind === "case_study" && (
          <label className="deal-field"><span>Client</span>
            <select value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
              <option value="">Choose a client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        {kind === "before_after" && <>
          <PicturePicker key={pickerKey("before", pickerEpoch)} label="Before picture" onPick={setBefore} />
          <PicturePicker key={pickerKey("after", pickerEpoch)} label="After picture" onPick={setAfter} />
        </>}
        <div className="deal-field wide st-consent">
          <span>Naming the business</span>
          <label className="st-check"><input className="cb" type="checkbox" checked={agreed} onChange={(e) => { setAgreed(e.target.checked); if (!e.target.checked) setAnonymous(true); }} />The client agreed to be named</label>
          <label className="st-check"><input className="cb" type="checkbox" checked={anonymous} disabled={!agreed} onChange={(e) => setAnonymous(e.target.checked)} />Keep it anonymous (no business name, address or phone)</label>
          <small>{anonymous ? "The post will not say who the business is." : "The post names the business. Only do this with their OK in writing."}</small>
        </div>
        <div className="cl-fields-actions">
          <button type="submit" className="btn primary" disabled={busy}><Icon name="sparkles" size={16} />{busy ? "Making…" : "Make the post"}</button>
        </div>
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
      </div>
    </form>
  );
}

/** The words of a post in boxes, saved as the server's copy. The pictures are drawn again after a save: a copy edit does not redraw them by itself. */
function EditWords({ post, onDone }: { post: StudioPost; onDone: (saved: boolean, warning?: string) => void }) {
  const copy = copyOf(post)!;
  const [headline, setHeadline] = useState(copy.headline);
  const [caption, setCaption] = useState(copy.caption);
  const [slides, setSlides] = useState(copy.slides);
  const [tagText, setTagText] = useState(copy.tags.join(" "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setSlide = (i: number, k: "title" | "body", v: string) => setSlides((all) => all.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  async function save() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await studioApi.saveCopy(post.id, copyEdit({ headline, caption, slides, tagText }));
      try { await studioApi.render(post.id); }
      catch (e) { onDone(true, `Your words are saved, but the pictures could not be drawn again: ${sentence(e, "try again")}`); return; }
      onDone(true);
    } catch (e) { setError(sentence(e, "Couldn’t save the words. Try again.")); setBusy(false); }
  }
  return (
    <div className="st-edit">
      <label className="deal-field"><span>Headline</span><input value={headline} onChange={(e) => setHeadline(e.target.value)} /></label>
      <label className="deal-field"><span>Caption</span><textarea rows={5} value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
      {slides.map((s, i) => (
        <fieldset key={i} className="st-slide-edit"><legend className="small">Slide {i + 1}</legend>
          <label className="deal-field"><span>Title</span><input value={s.title} onChange={(e) => setSlide(i, "title", e.target.value)} /></label>
          <label className="deal-field"><span>Text</span><textarea rows={2} value={s.body} onChange={(e) => setSlide(i, "body", e.target.value)} /></label>
        </fieldset>
      ))}
      <label className="deal-field"><span>Tags</span><input value={tagText} onChange={(e) => setTagText(e.target.value)} autoCapitalize="off" /><small>One word each, separated by spaces.</small></label>
      <div className="rp-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save and redraw"}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => onDone(false)}>Cancel</button>
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  );
}

/** One post: the status and what is next, the slides in a row with a Download each, the words with a Copy button, and Mark posted and Discard. Nothing here posts anywhere. */
function Card({ p, onChanged }: { p: StudioPost; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [sure, setSure] = useState(false);
  const copy = copyOf(p);
  const next = nextAction(p);
  async function run(job: () => Promise<unknown>, fail: string) {
    if (busy) return;
    setBusy(true); setError(""); setNote("");
    try { await job(); await onChanged(); }
    catch (e) { setError(sentence(e, fail)); }
    finally { setBusy(false); }
  }
  async function copyText() {
    if (!copy) return;
    try { await navigator.clipboard.writeText(captionWithTags(copy)); setNote("Caption copied."); }
    catch { setNote("Could not copy: select the caption and copy it by hand."); }
  }
  /** A picture replaced after the words exist is drawn into the slides again. */
  async function pick(slot: "before" | "after", file: File | null) {
    if (!file) return;
    if (file.size > MAX_UPLOAD) { setError("That image is over 1 MB; shrink it and try again."); return; }
    await run(async () => { let post = await studioApi.upload(p.id, slot, file); if (copy) post = await studioApi.render(p.id); return post; }, "Couldn’t upload the picture. Try again.");
  }
  const open = isOpen(p);
  return (
    <li className="cl-card cr-card st-card">
      <div className="cr-card-head">
        <h2 className="cr-name">{copy?.headline ?? KIND_LABEL[p.kind]}</h2>
        <span className="cr-chips">
          <span className="badge2">{KIND_LABEL[p.kind]}</span>
          <span className={`badge2${statusTone(p.status) ? ` ${statusTone(p.status)}` : ""}`}><i className="dot" aria-hidden="true" />{statusLabel(p.status)}</span>
        </span>
      </div>
      <p className="muted small">{p.anonymize ? "Anonymous" : "Names the client (they agreed)"} · made {dayOf(p.createdAt)}{p.postedOn ? ` · posted ${p.postedOn}` : ""}</p>

      {p.images > 0 && (
        <ul className="st-slides" aria-label="Slides">
          {Array.from({ length: p.images }, (_, i) => i + 1).map((n) => (
            <li key={n} className="st-slide">
              <img src={studioApi.imageUrl(p.id, n, p.updatedAt)} alt={`Slide ${n} of ${p.images}`} loading="lazy" width={108} height={135} />
              <a className="btn" href={studioApi.imageUrl(p.id, n, p.updatedAt)} download={imageName(p, n)}><Icon name="image" size={16} />Download {n}</a>
            </li>
          ))}
        </ul>
      )}

      {copy && !editing && (
        <div className="st-words">
          <p className="st-caption">{copy.caption}</p>
          {copy.tags.length > 0 && <p className="small muted">{copy.tags.map((t) => `#${t}`).join(" ")}</p>}
          <div className="rp-actions"><button type="button" className="btn" onClick={() => void copyText()}><Icon name="copy" size={16} />Copy caption</button></div>
        </div>
      )}
      {copy && editing && <EditWords post={p} onDone={(saved, warning) => { setEditing(false); if (warning) setError(warning); if (saved) void onChanged(); }} />}

      {p.kind === "before_after" && open && (
        <div className="cl-fields st-pics">
          <PicturePicker label="Replace the before picture" onPick={(f) => void pick("before", f)} />
          <PicturePicker label="Replace the after picture" onPick={(f) => void pick("after", f)} />
        </div>
      )}

      <div className="rp-actions">
        {p.status === "draft" && next && <button type="button" className="btn" disabled={busy} onClick={() => void run(() => studioApi.write(p.id), "Couldn’t ask for the words. Try again.")}>{next.label}</button>}
        {p.status === "writing" && <span className="muted small">Waiting for Claude: the words arrive on their own.</span>}
        {p.status === "review" && next && <Link className="btn" to={next.route}>{next.label}</Link>}
        {p.status === "approved" && <span className="small"><b>{nextAction(p)?.label}:</b> save the pictures, post them yourself, then mark it posted.</span>}
        {p.status === "review" && copy && !editing && <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>Edit the words</button>}
        {p.status === "approved" && <button type="button" className="btn" disabled={busy} onClick={() => void run(() => studioApi.posted(p.id), "Couldn’t mark it posted. Try again.")}>Mark posted</button>}
        {open && !sure && <button type="button" className="btn" disabled={busy} onClick={() => setSure(true)}>Discard</button>}
        {open && sure && <>
          <span className="small">Discard this post?</span>
          <button type="button" className="btn" disabled={busy} onClick={() => { setSure(false); void run(() => studioApi.discard(p.id), "Couldn’t discard it. Try again."); }}>Yes, discard</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setSure(false)}>Keep it</button>
        </>}
      </div>
      {note && <p className="small muted" role="status">{note}</p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </li>
  );
}

/** Studio: social posts made from audits, before and afters and finished work. Claude writes the words, you approve them in the inbox, download the pictures and post them yourself. */
export default function Studio() {
  const [params] = useSearchParams();
  const [posts, setPosts] = useState<StudioPost[] | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [guard] = useState(latestOnly);
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const next = await studioApi.list();
      if (guard.isLatest(ticket)) { setPosts(next); setFailed(false); }
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [guard]);
  useEffect(() => { void load(); return () => guard.cancel(); }, [load, guard]);
  useEffect(() => { clientsApi.list().then(setClients).catch(() => setClients([])); }, []);
  // A post waiting for Claude changes without a click: look again every 15 seconds while one is.
  const waiting = (posts ?? []).some((p) => p.status === "writing");
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [waiting, load]);

  const all = posts ?? [];
  const n = (st: StudioPost["status"][]) => all.filter((p) => st.includes(p.status)).length;
  const flow: [string, string, number][] = [
    ["Make", "Pick a kind and what it's about", n(["draft"])],
    ["Claude writes", "Headline, caption, slide text", n(["writing"])],
    ["You approve", "On Today, with the other approvals", n(["review"])],
    ["Download & post", "Post it yourself, then Mark posted", n(["approved"])],
  ];
  const open = all.filter(isOpen);
  const done = all.filter((p) => !isOpen(p));
  return (
    <div className="cl cr">
      <header className="page-header">
        <div>
          <h1>Studio</h1>
          <p>Posts for your feed, made from real audits and real client work. Claude writes, you approve, you post. Nothing here posts for you.</p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>
      <div className="pb-page">
        <section className="hm-card" aria-label="How a post moves">
          <ol className="st-flow">
            {flow.map(([t, d, c], i) => <li key={t}><b><em>{i + 1}</em>{t}{c > 0 && <span className="badge2 warning">{c}</span>}</b>{d}</li>)}
          </ol>
        </section>
        <NewPost clients={clients} initialAudit={params.get("audit") ?? ""} onMade={load} />
        {failed && <p className="error" role="alert">Couldn’t load the posts{posts ? ". What you see may be out of date" : ""}. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {posts === null && !failed && <p className="muted">Loading…</p>}
        {posts !== null && posts.length === 0 && (
          <EmptyState icon="image" title="No posts yet">
            Your first post is one click away: an audit tip from a lead with real findings is the quickest. It stays a draft until you ask Claude for the words.
          </EmptyState>
        )}
        {open.length > 0 && <><h2 className="pb-section">In progress <span>{open.length}</span></h2><ul className="cr-board">{open.map((p) => <Card key={p.id} p={p} onChanged={load} />)}</ul></>}
        {done.length > 0 && <><h2 className="pb-section">Posted and discarded <span>{done.length}</span></h2><ul className="cr-board">{done.map((p) => <Card key={p.id} p={p} onChanged={load} />)}</ul></>}
      </div>
    </div>
  );
}
