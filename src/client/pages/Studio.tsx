import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, clientsApi, studioApi } from "../api";
import { latestOnly } from "../clientView";
import Icon, { type IconName } from "../components/Icon";
import { Banner, Card, Chip, Empty, Note, PageHeader, type Tone } from "../components/ds";
import { KIND_LABEL, captionWithTags, copyEdit, copyOf, imageName, isOpen, nextAction, newPostBody, pickerKey, statusLabel, statusTone, type StudioKind, type StudioPost } from "../studioView";
import { SwitchRow } from "../components/StepFields";
import type { ClientRow } from "../../worker/clients/record";

const sentence = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);
const MAX_UPLOAD = 1024 * 1024;
const IMAGE_TYPES = "image/png,image/jpeg,image/webp";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const dayLabel = (iso: string): string => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const KIND_ICON: Record<StudioKind, IconName> = { audit_tip: "list", before_after: "image", case_study: "trending" };

/** One picture box for a before and after post. The size is checked by the caller so the sentence comes before the upload. */
function PicturePicker({ label, onPick }: { label: string; onPick: (f: File | null) => void }) {
  return (
    <label className="crx-field"><span>{label}</span>
      <input type="file" accept={IMAGE_TYPES} onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
      <small>PNG, JPEG or WebP, up to 1 MB.</small>
    </label>
  );
}

const KINDS: { kind: StudioKind; text: string; mock: string[] }[] = [
  { kind: "audit_tip", text: "Up to 6 slides of tips taken from a real audit's findings.", mock: ["ink", "", "", ""] },
  { kind: "before_after", text: "Your two screenshots side by side, with Claude's words on top.", mock: ["", "sig"] },
  { kind: "case_study", text: "One card on a finished client: what was wrong and what changed.", mock: ["ink"] },
];

/** The New post panel: the three kinds as cards, what the kind needs, the two pictures for a before and after, and the anonymous box (unticked only once the client agreed). */
function NewPost({ clients, initialAudit, initialKind = "audit_tip", onMade, onClose }: { clients: ClientRow[]; initialAudit: string; initialKind?: StudioKind; onMade: () => Promise<void>; onClose: () => void }) {
  const [kind, setKind] = useState<StudioKind>(initialKind);
  const [auditId, setAuditId] = useState(initialAudit);
  const [businessId, setBusinessId] = useState("");
  const [anonymous, setAnonymous] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [before, setBefore] = useState<File | null>(null);
  const [after, setAfter] = useState<File | null>(null);
  const [pickerEpoch, setPickerEpoch] = useState(0); // bumped to remount the two picture boxes empty (a file input cannot be cleared by state)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [made, setMade] = useState(false);
  useEffect(() => { if (initialAudit) { setKind("audit_tip"); setAuditId(initialAudit); } }, [initialAudit]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const body = newPostBody({ kind, auditId, businessId, anonymous, agreed });
    if ("problem" in body) { setError(body.problem); return; }
    const picked = kind === "before_after" ? [["before", before], ["after", after]] as const : [];
    const big = picked.find(([, f]) => f && f.size > MAX_UPLOAD);
    if (big) { setError("That image is over 1 MB; shrink it and try again."); return; }
    setBusy(true); setError(""); setMade(false);
    let post: StudioPost | null = null;
    try {
      post = await studioApi.create(body.body);
      for (const [slot, file] of picked) if (file) await studioApi.upload(post.id, slot, file);
      setAuditId(""); setBefore(null); setAfter(null); setPickerEpoch((n) => n + 1); setAnonymous(true); setAgreed(false); setMade(true);
    } catch (err) {
      setError(post ? `The post was made, but a picture did not upload: ${sentence(err, "try again from the post")}` : sentence(err, "Couldn’t make the post. Try again."));
    } finally {
      setBusy(false);
      if (post) await onMade();
    }
  }

  return (
    <Card icon="plus" title="New post" note="1080 × 1350 pictures, ready for Instagram and LinkedIn"
      action={<button type="button" className="ds-icon-btn" aria-label="Close the new post panel" onClick={onClose}><Icon name="x" size={14} /></button>}>
      <form className="crx-edit" onSubmit={(e) => void submit(e)} aria-label="New post">
        <fieldset className="crx-kinds">
          <legend className="sr-only">Kind of post</legend>
          {KINDS.map((k) => (
            <label key={k.kind} className={`crx-kind${kind === k.kind ? " on" : ""}`}>
              <input type="radio" name="crx-kind" value={k.kind} checked={kind === k.kind} onChange={() => { setKind(k.kind); setBefore(null); setAfter(null); setPickerEpoch((n) => n + 1); setError(""); }} />
              <span className="crx-tick" aria-hidden="true"><Icon name="check" size={12} /></span>
              <span className="crx-mock" aria-hidden="true">{k.mock.map((m, i) => <i key={i} className={m} />)}</span>
              <b><Icon name={KIND_ICON[k.kind]} size={16} />{KIND_LABEL[k.kind]}</b>
              <span>{k.text}</span>
            </label>
          ))}
        </fieldset>
        <div className="crx-new-fields">
          {kind === "audit_tip" && (
            <label className="crx-field wide crx-short"><span>Which audit</span>
              <input value={auditId} onChange={(e) => setAuditId(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="Audit id" />
              <small>{auditId ? "Filled in from the lead you came from." : <>Open a lead with real findings and press <b>Post a tip</b> on its Website issues tab: it brings you back here with this filled in. <Link to="/leads">Go to leads</Link></>}</small>
            </label>
          )}
          {kind === "case_study" && (
            <label className="crx-field wide crx-short"><span>Client</span>
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
          <div className="crx-consent wide">
            <SwitchRow checked={agreed} onChange={(v) => { setAgreed(v); if (!v) setAnonymous(true); }} label="The client agreed to be named" help="Only with their OK in writing." />
            {agreed && <SwitchRow checked={anonymous} onChange={setAnonymous} label="Keep it anonymous anyway" help="No business name, address or phone on the slides." />}
            <small>{anonymous ? "The post will not say who the business is." : "The post names the business."}</small>
          </div>
        </div>
        <div className="crx-actions crx-form-foot">
          <button type="submit" className="btn primary" disabled={busy}><Icon name="sparkles" size={16} />{busy ? "Making…" : "Make the post"}</button>
          <span className="crx-ok">It stays a draft until you ask Claude for the words.</span>
        </div>
        {made && <p className="crx-ok" role="status">Made. It is the first post under In progress.</p>}
        {error && <p className="crx-err" role="alert">{error}</p>}
      </form>
    </Card>
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
    <div className="crx-edit">
      <label className="crx-field"><span>Headline</span><input value={headline} onChange={(e) => setHeadline(e.target.value)} /></label>
      <label className="crx-field"><span>Caption</span><textarea rows={5} value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
      {slides.map((s, i) => (
        <fieldset key={i} className="crx-slide-edit"><legend>Slide {i + 1}</legend>
          <label className="crx-field"><span>Title</span><input value={s.title} onChange={(e) => setSlide(i, "title", e.target.value)} /></label>
          <label className="crx-field"><span>Text</span><textarea rows={2} value={s.body} onChange={(e) => setSlide(i, "body", e.target.value)} /></label>
        </fieldset>
      ))}
      <label className="crx-field"><span>Tags</span><input value={tagText} onChange={(e) => setTagText(e.target.value)} autoCapitalize="off" /><small>One word each, separated by spaces.</small></label>
      <div className="crx-actions">
        <button type="button" className="btn primary sm" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save and redraw"}</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => onDone(false)}>Cancel</button>
      </div>
      {error && <p className="crx-err" role="alert">{error}</p>}
    </div>
  );
}

const TONE = (s: StudioPost["status"]): Tone => (s === "discarded" ? "outline" : (statusTone(s) || "neutral") as Tone);

/** What happens next on a post, in one plain line. */
function nextLine(p: StudioPost): { icon: IconName; text: ReactNode } | null {
  switch (p.status) {
    case "draft": return { icon: "sparkles", text: <>Next: press <b>{nextAction(p)?.label}</b> and Claude writes the headline, caption and slide text.</> };
    case "writing": return { icon: "clock", text: <>Waiting for Claude: the words arrive on their own. This page checks every 15 seconds.</> };
    case "review": return { icon: "inbox", text: <>Next: approve it in the inbox on <b>Today</b>, or edit the words first.</> };
    case "approved": return { icon: "upload", text: <><b>{nextAction(p)?.label}:</b> save the pictures, post them yourself, then mark it posted.</> };
    default: return null;
  }
}

/** One post as a card: its slides with a download on each, the headline and status, the caption with a Copy button, and the actions for its stage. Nothing here posts anywhere. */
function PostCard({ p, onChanged }: { p: StudioPost; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [sure, setSure] = useState(false);
  const [full, setFull] = useState(false);
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
  const line = nextLine(p);
  return (
    <li className={`crx-post${open ? "" : " done"}`}>
      {p.images > 0 ? (
        <ul className="crx-slides" aria-label="Slides">
          {Array.from({ length: p.images }, (_, i) => i + 1).map((n) => (
            <li key={n} className="crx-slide">
              <img src={studioApi.imageUrl(p.id, n, p.updatedAt)} alt={`Slide ${n} of ${p.images}`} loading="lazy" width={96} height={120} />
              <a href={studioApi.imageUrl(p.id, n, p.updatedAt)} download={imageName(p, n)} aria-label={`Download slide ${n}`} title={`Download slide ${n}`}><Icon name="arrow-up-right" size={14} /></a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="crx-noslides"><span className="ds-tile neutral"><Icon name={KIND_ICON[p.kind]} size={16} /></span>{p.status === "writing" ? "The slides are drawn once Claude's words arrive." : p.status === "draft" ? "No slides yet: they are drawn from Claude's words." : "No slides."}</p>
      )}
      <div className="crx-post-body">
        <div className="crx-post-head">
          <h3>{copy?.headline ?? `${KIND_LABEL[p.kind]} post`}</h3>
          <Chip tone={TONE(p.status)} dot>{statusLabel(p.status)}</Chip>
        </div>
        <p className="crx-post-meta">{KIND_LABEL[p.kind]} · {p.anonymize ? "Anonymous" : "Names the client (they agreed)"} · made {dayLabel(p.createdAt)}{p.postedOn ? ` · posted ${dayLabel(p.postedOn)}` : ""}</p>

        {copy && !editing && (
          <>
            <p className={`crx-caption${full ? " full" : ""}`}>{copy.caption}</p>
            {copy.tags.length > 0 && <p className="crx-tags">{copy.tags.map((t) => `#${t}`).join(" ")}</p>}
            <div className="crx-actions">
              <button type="button" className="btn sm" onClick={() => void copyText()}><Icon name="copy" size={14} />Copy caption</button>
              {copy.caption.length > 140 && <button type="button" className="btn sm" onClick={() => setFull((f) => !f)}>{full ? "Show less" : "Show all"}</button>}
            </div>
          </>
        )}
        {copy && editing && <EditWords post={p} onDone={(saved, warning) => { setEditing(false); if (warning) setError(warning); if (saved) void onChanged(); }} />}

        {p.kind === "before_after" && open && (
          <div className="crx-pick">
            <span className="crx-pick-text"><b>Pictures</b><small>PNG, JPEG or WebP, up to 1 MB. Slides are drawn again after a change.</small></span>
            {(["before", "after"] as const).map((slot) => (
              <label key={slot} className={`btn sm crx-file-btn${busy ? " is-busy" : ""}`}>
                <Icon name="upload" size={14} />Replace {slot}
                <input type="file" accept={IMAGE_TYPES} disabled={busy} aria-label={`Replace the ${slot} picture`} onChange={(e) => { void pick(slot, e.target.files?.[0] ?? null); e.currentTarget.value = ""; }} />
              </label>
            ))}
          </div>
        )}

        {line && <p className="crx-next-step"><Icon name={line.icon} size={14} /><span>{line.text}</span></p>}

        {open && (
          <div className="crx-post-foot">
            {p.status === "draft" && next && <button type="button" className="btn primary sm" disabled={busy} onClick={() => void run(() => studioApi.write(p.id), "Couldn’t ask for the words. Try again.")}><Icon name="sparkles" size={14} />{next.label}</button>}
            {p.status === "review" && next && <Link className="btn primary sm" to={next.route}>{next.label}</Link>}
            {p.status === "review" && copy && !editing && <button type="button" className="btn sm" disabled={busy} onClick={() => setEditing(true)}><Icon name="pen" size={14} />Edit the words</button>}
            {p.status === "approved" && <button type="button" className="btn primary sm" disabled={busy} onClick={() => void run(() => studioApi.posted(p.id), "Couldn’t mark it posted. Try again.")}><Icon name="check" size={14} />Mark posted</button>}
            <span className="crx-grow" />
            {!sure && <button type="button" className="btn sm" disabled={busy} onClick={() => setSure(true)}>Discard</button>}
            {sure && <>
              <span className="crx-ok">Discard this post?</span>
              <button type="button" className="btn sm crx-btn-danger" disabled={busy} onClick={() => { setSure(false); void run(() => studioApi.discard(p.id), "Couldn’t discard it. Try again."); }}>Yes, discard</button>
              <button type="button" className="btn sm" disabled={busy} onClick={() => setSure(false)}>Keep it</button>
            </>}
          </div>
        )}
        {note && <p className="crx-ok" role="status">{note}</p>}
        {error && <p className="crx-err" role="alert">{error}</p>}
      </div>
    </li>
  );
}

/** Studio: social posts made from audits, before and afters and finished work. Claude writes the words, you approve them in the inbox, download the pictures and post them yourself. */
export default function Studio() {
  const [params] = useSearchParams();
  const audit = params.get("audit") ?? "";
  const [posts, setPosts] = useState<StudioPost[] | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [making, setMaking] = useState(!!audit);
  const [startKind, setStartKind] = useState<StudioKind>("audit_tip");
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
  useEffect(() => { if (audit) setMaking(true); }, [audit]);
  // A post waiting for Claude changes without a click: look again every 15 seconds while one is.
  const waiting = (posts ?? []).some((p) => p.status === "writing");
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [waiting, load]);

  const all = posts ?? [];
  const n = (st: StudioPost["status"][]) => all.filter((p) => st.includes(p.status)).length;
  const flow: { title: string; text: string; icon: IconName; count: number; wait?: boolean }[] = [
    { title: "Make", text: "Pick a kind and what it's about", icon: "plus", count: n(["draft"]) },
    { title: "Claude writes", text: "Headline, caption, slide text", icon: "sparkles", count: n(["writing"]) },
    { title: "You approve", text: "On Today, with the other approvals", icon: "inbox", count: n(["review"]), wait: true },
    { title: "Download & post", text: "Post it yourself, then Mark posted", icon: "upload", count: n(["approved"]), wait: true },
  ];
  const open = all.filter(isOpen);
  const done = all.filter((p) => !isOpen(p));
  const review = n(["review"]), approved = n(["approved"]);

  return (
    <div className="ds-page crx">
      <PageHeader
        title="Studio"
        sub="Posts for your feed, made from real audits and real client work. Claude writes, you approve, you post. Nothing here posts for you."
        actions={<>
          <button type="button" className="ds-icon-btn crx-refresh" aria-label="Refresh" title="Refresh" onClick={() => void load()}><Icon name="refresh" size={16} /></button>
          <button type="button" className="btn primary" aria-expanded={making} onClick={() => setMaking((m) => !m)}><Icon name={making ? "x" : "plus"} size={16} />{making ? "Close new post" : "New post"}</button>
        </>}
      />
      <div className="ds-body">
        <section className="ds-card" aria-label="How a post moves">
          <ol className="crx-flow">
            {flow.map((f, i) => (
              <li key={f.title} className={`${f.count > 0 ? "on" : ""}${f.count > 0 && f.wait ? " wait" : ""}`}>
                <span className={`ds-tile ${f.count > 0 && f.wait ? "signal" : "neutral"}`}><Icon name={f.icon} size={16} /></span>
                <div><b>{i + 1}. {f.title}</b><small>{f.text}</small></div>
                {f.count > 0 && <span className="crx-count" aria-label={`${f.count} ${f.count === 1 ? "post" : "posts"}`}>{f.count}</span>}
              </li>
            ))}
          </ol>
        </section>

        {review > 0 ? (
          <Banner tone="warning" icon="inbox" title={`${plural(review, "post")} ${review === 1 ? "waits" : "wait"} for your OK`} action={<Link className="btn sm" to="/today">Approve on Today</Link>}>
            Read the words on the card below first; edit them if they are not right.
          </Banner>
        ) : approved > 0 ? (
          <Banner tone="signal" icon="upload" title={`${plural(approved, "post")} approved and ready to post`}>Download the slides, copy the caption, post it yourself, then press Mark posted.</Banner>
        ) : null}

        {making && <NewPost key={startKind} clients={clients} initialAudit={audit} initialKind={startKind} onMade={load} onClose={() => setMaking(false)} />}

        {failed && <Banner tone="critical" title="Couldn't load the posts" action={<button type="button" className="btn sm" onClick={() => void load()}>Try again</button>}>{posts ? "What you see may be out of date." : "Check your connection and try again."}</Banner>}
        {posts === null && !failed && <p className="crx-loading">Loading posts…</p>}
        {posts !== null && posts.length === 0 && !making && (
          <div className="ds-card"><Empty icon="image" title="No posts yet" action={<button type="button" className="btn" onClick={() => setMaking(true)}><Icon name="plus" size={16} />Make your first post</button>}>
            Your first post is one click away: an audit tip from a lead with real findings is the quickest. It stays a draft until you ask Claude for the words, then waits for your OK on Today.
          </Empty></div>
        )}
        {open.length > 0 && (
          <section className="crx-section" aria-label="In progress">
            <div className="ds-section-head"><h2>In progress</h2><span className="crx-dim">{plural(open.length, "post")}</span></div>
            <ul className="crx-posts">
              {open.map((p) => <PostCard key={p.id} p={p} onChanged={load} />)}
              {open.length < 3 && !making && (
                <li className="crx-post-new">
                  <span className="ds-tile signal big"><Icon name="plus" size={18} /></span>
                  <b>Make another post</b>
                  <small>Pick what it is made from. It stays a draft until you ask Claude for the words.</small>
                  <span className="crx-post-new-kinds">
                    {KINDS.map((k) => (
                      <button key={k.kind} type="button" className="btn sm" onClick={() => { setStartKind(k.kind); setMaking(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                        <Icon name={KIND_ICON[k.kind]} size={14} />{KIND_LABEL[k.kind]}
                      </button>
                    ))}
                  </span>
                </li>
              )}
            </ul>
          </section>
        )}
        {done.length > 0 && (
          <section className="crx-section" aria-label="Posted and discarded">
            <div className="ds-section-head"><h2>Posted and discarded</h2><span className="crx-dim">{plural(done.length, "post")}</span></div>
            <ul className="crx-posts">{done.map((p) => <PostCard key={p.id} p={p} onChanged={load} />)}</ul>
          </section>
        )}
        {all.length > 0 && <Note>Slides are 1080 × 1350 pictures. The arrow on each slide downloads it.</Note>}
      </div>
    </div>
  );
}
