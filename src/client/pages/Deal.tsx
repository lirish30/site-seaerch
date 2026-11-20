import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { formatSlot } from "../bookingView";
import CallPrepPanel from "../components/CallPrepPanel";
import UpcomingBooking from "../components/UpcomingBooking";
import { callDoneCheck, canOfferTimes, formOf, isNotesDirty, nextActions, notesOf, optionSummary, priceDrift, type NotesForm } from "../dealView";
import { dollars, formatPrice, parseDollars, type Package } from "../packagesView";
import { formOf as proposalFormOf, isProposalDirty, type ProposalForm } from "../proposalView";
import OnboardingTab from "./OnboardingTab";
import ProposalTab, { type ProposalData } from "./ProposalTab";
import { STAGE_LABEL } from "../pipelineView";
import { dealProjects, startOffers } from "../projectView";
import type { ProjectRow } from "../workData";
import type { Document } from "../../worker/db/documents";
import type { Deal } from "../../worker/db/deals";
import type { OnboardingState } from "../../worker/onboarding/owner";
import { DISCOVERY_QUESTIONS } from "../../worker/sales/discovery";
import { hasNotes, LEAD_TYPE_GUIDE, monthlyAtStakeCents } from "../../worker/sales/notes";
import type { Option } from "../../worker/sales/options";

type Tab = "prep" | "notes" | "recap" | "deck" | "proposal" | "onboarding";
const POLL_MS = 15_000;
const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** A deal's page: the prep for the call, the notes from it, the recap with the three options and the follow-up meeting. The deck tab opens the recommendation deck. */
export default function DealPage() {
  const { id = "" } = useParams();
  const [deal, setDeal] = useState<Deal | null>(null);
  const [lead, setLead] = useState<{ name: string; platform: string | null; findings: { code: string; evidence: string }[] } | null>(null);
  // The notes form lives here, not in the Notes tab, so typing survives a switch to Prep and back. It is replaced only by a save (or a new deal).
  const [form, setForm] = useState<NotesForm | null>(null);
  const [catalog, setCatalog] = useState<Package[]>([]);
  // The proposal form lives here too, for the same reason: typing survives a switch of tab. Saving, sending and voiding replace it from what the server stored.
  const [proposal, setProposal] = useState<ProposalData | null>(null);
  const [pform, setPform] = useState<ProposalForm | null>(null);
  const [proposalFailed, setProposalFailed] = useState(false);
  // The onboarding is loaded with the deal so the tab can be offered only when there is something to show (an onboarding, a won deal, or a signed proposal to test with).
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [onboardingFailed, setOnboardingFailed] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [startNotice, setStartNotice] = useState("");
  const [tab, setTab] = useState<Tab | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setDeal(null); setLead(null); setForm(null); setProposal(null); setPform(null); setProposalFailed(false); setOnboarding(null); setOnboardingFailed(false); setProjects([]); setStartError(""); setStartNotice(""); setTab(null); setFailed(false);
    api.get<Deal>(`/deals/${id}`).then((d) => {
      if (!live) return;
      setDeal(d);
      // Projects started from this deal (by its paid deposit, or a test); the link is only offered when there is one.
      api.get<{ projects: ProjectRow[] }>(`/projects?businessId=${encodeURIComponent(d.businessId)}`).then((r) => { if (live) setProjects(dealProjects(r.projects, d.id)); }).catch(() => {});
      setTab(d.recap ? "recap" : d.stage === "booked" ? "prep" : "notes");
      const ready = (name: string, platform: string | null, findings: { code: string; evidence: string }[]) => {
        if (!live) return;
        setLead({ name, platform, findings });
        setForm(formOf(d.notes, { platform }));
      };
      api.get<{ business: { name: string }; audit: { platform: string | null; findings: { code: string; evidence: string }[] } | null }>(`/leads/${d.businessId}`)
        .then((x) => ready(x.business.name, x.audit?.platform ?? null, x.audit?.findings ?? []))
        .catch(() => ready("this lead", null, []));
    }).catch(() => { if (live) setFailed(true); });
    api.get<Package[]>("/packages").then((c) => { if (live) setCatalog(c); }).catch(() => {});
    api.get<ProposalData>(`/deals/${id}/proposal`).then((p) => { if (live) setProposal(p); }).catch(() => { if (live) setProposalFailed(true); });
    api.get<OnboardingState>(`/deals/${id}/onboarding`).then((x) => { if (live) setOnboarding(x); }).catch(() => { if (live) setOnboardingFailed(true); });
    return () => { live = false; };
  }, [id]);

  // The form starts from the saved proposal (or the recommended option) once both the deal and its proposal have loaded, and not again until a save replaces it.
  useEffect(() => {
    if (deal && proposal && !pform) setPform(proposalFormOf(proposal.current, { recommendedOptionId: deal.recommendedOptionId, contact: proposal.defaultContact }));
  }, [deal, proposal, pform]);
  const reloadProposal = useCallback(async (fresh: Document | null | undefined) => {
    const next = await api.get<ProposalData>(`/deals/${id}/proposal`);
    setProposal(next);
    if (fresh !== undefined && deal) setPform(proposalFormOf(fresh ?? next.current, { recommendedOptionId: deal.recommendedOptionId, contact: next.defaultContact }));
  }, [id, deal]);

  // "Start projects" is the retry for a paid deal whose projects did not start by themselves; "Start a test project" rehearses it from a signed test proposal.
  const startProjects = useCallback(async (kind: "start" | "test") => {
    if (!deal) return;
    setStarting(true); setStartError(""); setStartNotice("");
    try {
      const r = await api.post<{ projects: { id: string; name: string }[] }>(`/deals/${deal.id}/projects/${kind}`);
      setStartNotice(`${kind === "test" ? "Test project started" : "Projects started"}: ${r.projects.map((p) => p.name).join(", ")}.`);
      const all = await api.get<{ projects: ProjectRow[] }>(`/projects?businessId=${encodeURIComponent(deal.businessId)}`);
      setProjects(dealProjects(all.projects, deal.id));
    } catch (e) { setStartError(errorText(e, "Couldn’t start the projects.")); }
    finally { setStarting(false); }
  }, [deal]);

  const reloadOnboarding = useCallback(async () => { setOnboarding(await api.get<OnboardingState>(`/deals/${id}/onboarding`)); }, [id]);

  // Every hook is called above the early returns below: a render that skips one (the failed load) would throw "Rendered fewer hooks than expected".
  const dirty = !!deal && !!form && !!lead && isNotesDirty(form, deal.notes, lead);
  const proposalDirty = !!deal && !!proposal && !!pform && isProposalDirty(pform, proposal.current, { recommendedOptionId: deal.recommendedOptionId, contact: proposal.defaultContact });
  // Closing or reloading the page with typed notes or a proposal that are not saved asks first (the same browser prompt the Settings pages use).
  const unsaved = dirty || proposalDirty;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  if (failed) return <div className="deal"><p className="error deal-body" role="alert">Couldn’t load this deal. <Link to="/pipeline">Back to the pipeline</Link></p></div>;
  if (!deal || !tab || !form) return <div className="deal"><p className="muted deal-body">Loading…</p></div>;

  const actions = nextActions(deal);
  const offers = startOffers(deal, proposal?.history ?? [], projects);
  const TABS: [Tab, string][] = [["prep", "Prep"], ["notes", "Notes"], ["recap", "Recap"], ["deck", "Deck"], ["proposal", "Proposal"]];
  if (onboarding && (onboarding.onboarding || deal.stage === "won" || onboarding.canStartTest)) TABS.push(["onboarding", "Onboarding"]);
  return (
    <div className="deal">
      <header className="page-header">
        <div>
          <p><Link to="/pipeline">Pipeline</Link></p>
          <h1>{lead ? <Link to={`/leads/${deal.businessId}`}>{lead.name}</Link> : "Deal"}</h1>
          <p><span className="badge2 info"><i className="dot" />{STAGE_LABEL[deal.stage]}</span>{deal.lostReason && <> Lost: {deal.lostReason}</>}</p>
          {projects.length > 0 && <p>{projects.length > 1 && "Projects: "}{projects.map((p, i) => <span key={p.id}>{i > 0 && ", "}<Link to={`/projects/${p.id}`}>{projects.length === 1 ? "Project" : p.name}</Link>{p.test ? " (test)" : ""}</span>)}</p>}
        </div>
      </header>
      <div className="deal-body">
        {(offers.canStart || offers.canStartTest || startError || startNotice) && (
          <section className="deal-form" aria-label="Projects">
            {offers.canStart && <p className="muted small">The deal is won and has no project. Projects start by themselves when the deposit is paid; this is the retry if they did not.</p>}
            {offers.canStartTest && <p className="muted small">The latest signed proposal is a test copy. A test project has the same steps, never sends anything to Claude unasked, and is marked Test.</p>}
            <div className="cp-actions">
              {offers.canStart && <button type="button" className="btn primary" disabled={starting} onClick={() => void startProjects("start")}>{starting ? "Starting…" : "Start projects"}</button>}
              {offers.canStartTest && <button type="button" className="btn" disabled={starting} onClick={() => void startProjects("test")}>{starting ? "Starting…" : "Start a test project"}</button>}
            </div>
            {startError && <p className="warn small" role="alert">{startError}</p>}
            {startNotice && <p className="small" role="status">{startNotice}</p>}
          </section>
        )}
        {actions.length > 0 && (
          <ul className="deal-actions" aria-label="Next steps">
            {actions.map((a) => <li key={a.label} className={a.done ? "done" : ""}>{a.done ? "Done: " : "Next: "}{a.label}</li>)}
          </ul>
        )}
        <UpcomingBooking key={deal.stage} leadId={deal.businessId} />
        <div className="seg-pills" role="group" aria-label="Deal sections">
          {TABS.map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}
        </div>
        {onboardingFailed && <p className="error" role="alert">Couldn’t load the onboarding, so its tab is hidden. Reload the page to try again.</p>}
        {tab === "prep" && <CallPrepPanel leadId={deal.businessId} findings={lead?.findings ?? []} />}
        {tab === "notes" && <NotesTab deal={deal} form={form} setForm={setForm} audit={lead} dirty={dirty} onChange={setDeal} />}
        {tab === "recap" && <RecapTab deal={deal} catalog={catalog} onChange={setDeal} />}
        {tab === "deck" && <DeckTab deal={deal} catalog={catalog} />}
        {tab === "proposal" && (pform
          ? <ProposalTab deal={deal} catalog={catalog} data={proposal} form={pform} setForm={setPform} dirty={proposalDirty} onReload={reloadProposal} />
          : proposalFailed ? <p className="error" role="alert">Couldn’t load the proposal. Reload the page to try again.</p> : <p className="muted">Loading…</p>)}
        {tab === "onboarding" && <OnboardingTab dealId={deal.id} data={onboarding} onReload={reloadOnboarding} />}
      </div>
    </div>
  );
}

function NotesTab({ deal, form, setForm, audit, dirty, onChange }: {
  deal: Deal; form: NotesForm; setForm: (f: NotesForm) => void; audit: { platform: string | null } | null; dirty: boolean; onChange: (d: Deal) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const closed = deal.stage === "won" || deal.stage === "lost";
  const set = (patch: Partial<NotesForm>) => { setForm({ ...form, ...patch }); setSaved(false); setError(""); };
  const setAt = (key: "answers" | "goals" | "currentState", i: number, v: string) => set({ [key]: form[key].map((x, j) => (j === i ? v : x)) });

  const parsed = notesOf(form, deal.notes?.callHeldAt ?? null);
  const atStake = parsed.ok ? monthlyAtStakeCents(parsed.notes) : null;

  async function save(): Promise<boolean> {
    setError("");
    if (!parsed.ok) { setError(parsed.error); return false; }
    try {
      const stored = await api.put<Deal>(`/deals/${deal.id}/notes`, parsed.notes);
      setForm(formOf(stored.notes, audit)); onChange(stored); setSaved(true); return true;
    }
    catch (e) { setError(errorText(e, "Could not save the notes")); return false; }
  }
  async function run(fn: () => Promise<void>) { setBusy(true); try { await fn(); } finally { setBusy(false); } }
  /** Stops when the typed notes are not valid (the reason is shown), and saves what is typed first, so marking the call done never leaves notes behind. */
  const callDone = () => run(async () => {
    const check = callDoneCheck(form, deal.notes?.callHeldAt ?? null, deal.notes);
    if (!check.ok) { setError(check.error); return; }
    if (check.save && !(await save())) return;
    try { onChange(await api.post<Deal>(`/deals/${deal.id}/call-done`)); setSaved(false); }
    catch (e) { setError(errorText(e, "Could not mark the call done")); }
  });

  return (
    <section className="deal-form" aria-label="Call notes">
      <p className="muted small">Write what the owner said in their own words. The recap and the deck use only the numbers they gave.</p>
      {DISCOVERY_QUESTIONS.map((q, i) => (
        <label key={i} className="deal-field">
          <span>{i + 1}. {q}</span>
          <textarea rows={2} maxLength={2000} value={form.answers[i]} disabled={closed} onChange={(e) => setAt("answers", i, e.target.value)} />
        </label>
      ))}
      <div className="field-row">
        <label className="deal-field"><span>Average job is worth (dollars, the owner’s number)</span>
          <input inputMode="decimal" value={form.avgJob} disabled={closed} onChange={(e) => set({ avgJob: e.target.value })} /></label>
        <label className="deal-field"><span>Jobs missed in a month (the owner’s number)</span>
          <input inputMode="numeric" value={form.missed} disabled={closed} onChange={(e) => set({ missed: e.target.value })} /></label>
      </div>
      <p className="muted small">{atStake !== null ? `${dollars(atStake)} a month at stake, from the two numbers above.` : "Fill in both numbers to see what is at stake each month. Nothing is estimated."}</p>
      <fieldset className="deal-field" disabled={closed}>
        <legend>Their goals (up to three)</legend>
        {form.goals.map((g, i) => <input key={i} aria-label={`Goal ${i + 1}`} maxLength={200} value={g} onChange={(e) => setAt("goals", i, e.target.value)} />)}
      </fieldset>
      <fieldset className="deal-field" disabled={closed}>
        <legend>Where they are now (up to three)</legend>
        {form.currentState.map((g, i) => <input key={i} aria-label={`Where they are now ${i + 1}`} maxLength={200} value={g} onChange={(e) => setAt("currentState", i, e.target.value)} />)}
      </fieldset>
      <div className="field-row">
        <label className="deal-field"><span>Their site is on</span>
          <select value={form.platform} disabled={closed} onChange={(e) => set({ platform: e.target.value as NotesForm["platform"] })}>
            <option value="wordpress">WordPress</option><option value="other">Something else (Wix, Squarespace, GoDaddy…)</option>
          </select><small className="muted">Care is only offered for WordPress sites.</small></label>
        <label className="deal-field"><span>Who decides</span>
          <input maxLength={300} value={form.decisionMakers} disabled={closed} onChange={(e) => set({ decisionMakers: e.target.value })} /></label>
      </div>
      {error && <p className="warn small" role="alert">{error}</p>}
      <div className="cp-actions">
        <button type="button" className="btn" disabled={busy || closed} onClick={() => run(async () => { await save(); })}>Save notes</button>
        {deal.stage === "booked" && <button type="button" className="btn" disabled={busy} onClick={callDone}>Call done</button>}
        {dirty && !saved && <span className="muted small">Unsaved changes.</span>}
        {saved && <span className="muted small" role="status">Saved.</span>}
        {deal.notes?.callHeldAt && <span className="muted small">Call held {new Date(deal.notes.callHeldAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.</span>}
      </div>
    </section>
  );
}

function DeckTab({ deal, catalog }: { deal: Deal; catalog: Package[] }) {
  if (!deal.recap || !deal.options) return <p className="muted">Draft the recap first: the deck is built from the notes and the recap.</p>;
  const drift = priceDrift(deal, catalog);
  const frozen = deal.deckFrozenAt ? new Date(deal.deckFrozenAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  return (
    <section className="deal-recap" aria-label="Deck">
      <p>{frozen ? `Prices frozen ${frozen}. The deck shows those prices even if the catalog changes.` : "Draft: the prices freeze the first time you open the deck or download the PDF."}</p>
      {drift.length > 0 && (
        <div className="warn small" role="status">
          <p>The catalog has changed since the prices were frozen:</p>
          <ul>{drift.map((d) => <li key={d}>{d}</li>)}</ul>
          <p>Open the deck and choose “Freeze prices” to use today’s prices.</p>
        </div>
      )}
      <div className="cp-actions">
        <Link className="btn" to={`/deals/${deal.id}/deck`}>Open the deck</Link>
        <a className="btn-ghost-sm" href={`/api/deals/${deal.id}/deck.pdf`} download>Download PDF</a>
      </div>
    </section>
  );
}

function RecapTab({ deal, catalog, onChange }: { deal: Deal; catalog: Package[]; onChange: (d: Deal) => void }) {
  const [queued, setQueued] = useState(false);
  const [editing, setEditing] = useState(false);
  const [times, setTimes] = useState<{ slots: string[]; tz: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [booked, setBooked] = useState("");
  // Whether a recommendation meeting is confirmed for this lead (null while loading). A guest who cancels theirs leaves the deal at "meeting booked" with none.
  const [hasMeeting, setHasMeeting] = useState<boolean | null>(null);
  const [meetingReloads, setMeetingReloads] = useState(0);
  const shownAt = useRef<string | null>(deal.recap?.generatedAt ?? null);
  const closed = deal.stage === "won" || deal.stage === "lost";
  const written = hasNotes(deal.notes);

  useEffect(() => {
    let live = true;
    api.get<{ kind: string }[]>(`/bookings?lead=${encodeURIComponent(deal.businessId)}`).then((all) => { if (live) setHasMeeting(all.some((b) => b.kind === "recommendation")); }).catch(() => { if (live) setHasMeeting(null); });
    return () => { live = false; };
  }, [deal.businessId, deal.stage, meetingReloads]);

  // While a recap is queued, look again every so often; a newer `generatedAt` means Claude wrote it.
  const reload = useCallback(() => api.get<Deal>(`/deals/${deal.id}`).then(onChange), [deal.id, onChange]);
  useEffect(() => {
    if (!queued) return;
    const t = setInterval(() => {
      api.get<Deal>(`/deals/${deal.id}`).then((d) => {
        if ((d.recap?.generatedAt ?? null) !== shownAt.current) { shownAt.current = d.recap?.generatedAt ?? null; onChange(d); setQueued(false); }
      }).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [queued, deal.id, onChange]);

  async function run(fn: () => Promise<void>) { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(errorText(e, "Something went wrong")); } finally { setBusy(false); } }
  const draft = () => run(async () => { await api.post(`/deals/${deal.id}/recap`); setQueued(true); });
  const offer = () => run(async () => { setBooked(""); setTimes(await api.get<{ slots: string[]; tz: string }>(`/deals/${deal.id}/followup-slots`)); });
  const book = (start: string, tz: string) => run(async () => {
    await api.post(`/deals/${deal.id}/book-recommendation`, { start });
    setTimes(null); setBooked(formatSlot(start, tz)); setMeetingReloads((n) => n + 1); await reload();
  });

  const recap = deal.recap, options = deal.options;
  const leadLabel = recap ? LEAD_TYPE_GUIDE.find((g) => g.type === recap.leadType)?.lead : null;
  const canOffer = canOfferTimes(deal.stage, hasMeeting);
  return (
    <section className="deal-recap" aria-label="Recap">
      <div className="cp-actions">
        <button type="button" className="btn" disabled={busy || queued || closed || !written} onClick={draft}>{recap ? "Draft recap again" : "Draft recap"}</button>
        {canOffer && <button type="button" className="btn" disabled={busy} onClick={offer}>Offer two times</button>}
        {options && !closed && <button type="button" className="btn-ghost-sm" onClick={() => setEditing(!editing)}>{editing ? "Close editor" : "Edit options"}</button>}
      </div>
      {!written && <p className="muted small">Write the call notes first: the recap is built from the owner’s own words.</p>}
      {queued && <p className="muted small" role="status">Queued. Claude writes it the next time it works the queue.</p>}
      {error && <p className="warn small" role="alert">{error}</p>}
      {booked && <p role="status">Recommendation meeting booked for {booked}. The invite is on its way.</p>}
      {times && (
        <div className="deal-times">
          {times.slots.length === 0 && <p className="muted small">No times to offer. Set your availability and connect Google in Settings, then try again.</p>}
          {times.slots.map((s) => <button key={s} type="button" className="btn" disabled={busy} onClick={() => book(s, times.tz)}>Book {formatSlot(s, times.tz)}</button>)}
          {times.slots.length > 0 && <p className="muted small">Booking sends the owner a calendar invite with a Meet link and a confirmation email.</p>}
        </div>
      )}

      {recap && (
        <>
          {leadLabel && <p className="muted small">Kind of lead: {leadLabel}</p>}
          <h3>What I heard</h3>
          <p>{recap.playback}</p>
          <h3>Their goals</h3>
          <ul>{recap.goals.map((g, i) => <li key={i}>{g}</li>)}</ul>
          {recap.currentState.length > 0 && <><h3>Where they are now</h3><ul>{recap.currentState.map((g, i) => <li key={i}>{g}</li>)}</ul></>}
          <h3>My recommendation</h3>
          <p className="deal-reco">{recap.recommendation}</p>
        </>
      )}
      {options && !editing && (
        <>
          <div className="deal-options">
            {options.map((o) => {
              const s = optionSummary(o, catalog);
              return (
                <article key={o.id} className={`deal-option${o.recommended ? " rec" : ""}`}>
                  <h4>{o.label}{o.recommended && <span className="badge2 info"><i className="dot" />Recommended</span>}</h4>
                  {o.tagline && <p className="muted small">{o.tagline}</p>}
                  <ul>{s.items.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  <p><strong>{[s.upfront && `${s.upfront} up front`, s.monthly].filter(Boolean).join(" + ")}</strong></p>
                </article>
              );
            })}
          </div>
          {deal.valueCents !== null && <p className="muted small">First-year value of the recommended option: {dollars(deal.valueCents)} (up front plus 12 months). Prices are from the catalog as of the recap.</p>}
        </>
      )}
      {options && editing && <OptionsEditor deal={deal} options={options} catalog={catalog} onSaved={(d) => { onChange(d); setEditing(false); }} />}
      {!recap && !queued && written && <p className="muted small">No recap yet. “Draft recap” asks Claude to write it from the notes.</p>}
    </section>
  );
}

/** Logan's edit of the three options: name, tagline, the packages in each, and a setup discount where the package has a setup fee. The server revalidates it all. */
function OptionsEditor({ deal, options, catalog, onSaved }: { deal: Deal; options: Option[]; catalog: Package[]; onSaved: (d: Deal) => void }) {
  const [draft, setDraft] = useState<Option[]>(options);
  const [disc, setDisc] = useState<Record<string, string>>(() =>
    Object.fromEntries(options.flatMap((o) => o.items.filter((i) => i.setupDiscountCents).map((i) => [`${o.id}:${i.key}`, String(i.setupDiscountCents! / 100)]))));
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const choosable = catalog.filter((p) => p.active && p.publicOffer && p.kind !== "hourly");
  const edit = (id: Option["id"], patch: Partial<Option>) => setDraft(draft.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  const toggle = (o: Option, key: Package["key"]) => edit(o.id, { items: o.items.some((i) => i.key === key) ? o.items.filter((i) => i.key !== key) : [...o.items, { key }] });

  async function save() {
    const out: Option[] = [];
    for (const o of draft) {
      const items = [];
      for (const i of o.items) {
        const text = (disc[`${o.id}:${i.key}`] ?? "").trim();
        const cents = text === "" ? 0 : parseDollars(text);
        if (cents === null) { setProblems([`${o.label}: the discount on ${i.key} must be a dollar amount.`]); return; }
        items.push(cents > 0 ? { key: i.key, setupDiscountCents: cents } : { key: i.key });
      }
      out.push({ ...o, items });
    }
    setBusy(true); setProblems([]);
    try { onSaved(await api.put<Deal>(`/deals/${deal.id}/options`, { options: out })); }
    catch (e) {
      const body = e instanceof ApiError ? (e.body as { problems?: string[] } | undefined) : undefined;
      setProblems(body?.problems?.length ? body.problems : [errorText(e, "Could not save the options")]);
    } finally { setBusy(false); }
  }

  return (
    <div className="deal-editor">
      <p className="muted small">The middle option is the recommended one. A discount comes off a setup fee only, never a monthly price.</p>
      {draft.map((o) => (
        <fieldset key={o.id} className="deal-option">
          <legend>Option {o.id.toUpperCase()}{o.recommended ? " (recommended)" : ""}</legend>
          <label className="deal-field"><span>Name</span><input maxLength={60} value={o.label} onChange={(e) => edit(o.id, { label: e.target.value })} /></label>
          <label className="deal-field"><span>One line</span><input maxLength={150} value={o.tagline} onChange={(e) => edit(o.id, { tagline: e.target.value })} /></label>
          {choosable.map((p) => {
            const on = o.items.some((i) => i.key === p.key);
            return (
              <div key={p.key} className="deal-pkg">
                <label><input type="checkbox" className="cb" checked={on} onChange={() => toggle(o, p.key)} /> {p.name} <span className="muted">{formatPrice(p)}</span></label>
                {on && (p.setupCents > 0 || p.kind === "one_time") && (
                  <input aria-label={`Setup discount on ${p.name} (dollars)`} placeholder="Setup discount, $" inputMode="decimal" value={disc[`${o.id}:${p.key}`] ?? ""}
                    onChange={(e) => setDisc({ ...disc, [`${o.id}:${p.key}`]: e.target.value })} />
                )}
              </div>
            );
          })}
        </fieldset>
      ))}
      {problems.length > 0 && <ul className="warn small" role="alert">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      <div className="cp-actions"><button type="button" className="btn" disabled={busy} onClick={save}>Save options</button></div>
    </div>
  );
}
