import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { formatSlot } from "../bookingView";
import CallPrepPanel from "../components/CallPrepPanel";
import UpcomingBooking from "../components/UpcomingBooking";
import { Banner, Card, Chip, Empty, Facts, LinkRow, PageHeader, Tabs, type Tone } from "../components/ds";
import Icon from "../components/Icon";
import { callDoneCheck, canOfferTimes, formOf, isNotesDirty, nextActions, notesOf, optionSummary, priceDrift, type NotesForm } from "../dealView";
import { dollars, formatPrice, parseDollars, type Package } from "../packagesView";
import { formOf as proposalFormOf, isProposalDirty, type ProposalForm } from "../proposalView";
import OnboardingTab from "./OnboardingTab";
import ProposalTab, { DOC_STATUS, DOC_TONE, useProposalActions, type ProposalData } from "./ProposalTab";
import { STAGE_LABEL, cardPackage, type DealStage } from "../pipelineView";
import { dealProjects, startOffers } from "../projectView";
import type { ProjectRow } from "../workData";
import type { Document } from "../../worker/db/documents";
import type { Deal } from "../../worker/db/deals";
import type { OnboardingState } from "../../worker/onboarding/owner";
import { DISCOVERY_QUESTIONS } from "../../worker/sales/discovery";
import { hasNotes, LEAD_TYPE_GUIDE, monthlyAtStakeCents } from "../../worker/sales/notes";
import type { Option } from "../../worker/sales/options";

type Tab = "overview" | "notes" | "recap" | "proposal" | "onboarding";
const POLL_MS = 15_000;
const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const STAGE_TONE: Record<DealStage, Tone> = { booked: "info", discovery_done: "info", recommendation_booked: "info", recommended: "signal", proposal_sent: "signal", won: "positive", lost: "neutral" };
/** Which tab each next step is done on. */
const ACTION_TAB: Record<string, Tab> = { "Hold the discovery call": "overview", "Write notes": "notes", "Draft recap": "recap", "Offer two times": "recap", "Present the recommendation": "recap" };

/**
 * A deal's page. Overview: what to do next, the call prep, the booked calls, the deck and the projects. Call notes: the notes from the discovery call.
 * Recap and options: the recap with the three options and the follow-up meeting. Proposal: the proposal builder. Onboarding: once the deal is won.
 */
export default function DealPage() {
  const { id = "" } = useParams();
  // `?tab=` opens a tab directly (a link from elsewhere, or a reload); otherwise the tab follows the deal's stage.
  const [params] = useSearchParams();
  const askedTab = params.get("tab");
  const [deal, setDeal] = useState<Deal | null>(null);
  // Whether the discovery call was recorded and matched (the server says so, never more). It lets "Draft recap" work without typed notes.
  const [hasRecording, setHasRecording] = useState(false);
  const [lead, setLead] = useState<{ name: string; platform: string | null; findings: { code: string; evidence: string }[] } | null>(null);
  // The notes form lives here, not in the Notes tab, so typing survives a switch to another tab and back. It is replaced only by a save (or a new deal).
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
    setDeal(null); setHasRecording(false); setLead(null); setForm(null); setProposal(null); setPform(null); setProposalFailed(false); setOnboarding(null); setOnboardingFailed(false); setProjects([]); setStartError(""); setStartNotice(""); setTab(null); setFailed(false);
    api.get<Deal & { hasRecording?: boolean }>(`/deals/${id}`).then((d) => {
      if (!live) return;
      setDeal(d); setHasRecording(d.hasRecording === true);
      // Projects started from this deal (by its paid deposit, or a test); the link is only offered when there is one.
      api.get<{ projects: ProjectRow[] }>(`/projects?businessId=${encodeURIComponent(d.businessId)}`).then((r) => { if (live) setProjects(dealProjects(r.projects, d.id)); }).catch(() => {});
      const TAB_KEYS: Tab[] = ["overview", "notes", "recap", "proposal", "onboarding"];
      if (askedTab && (TAB_KEYS as string[]).includes(askedTab)) { setTab(askedTab as Tab); }
      else setTab(d.stage === "proposal_sent" || ((d.stage === "recommended" || d.skipCall) && d.options) ? "proposal" : d.recap ? "recap" : d.stage === "booked" ? "overview" : "notes");
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
  const pa = useProposalActions({ deal, data: proposal, form: pform, dirty: proposalDirty, onReload: reloadProposal });
  // Closing or reloading the page with typed notes or a proposal that are not saved asks first (the same browser prompt the Settings pages use).
  const unsaved = dirty || proposalDirty;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  if (failed) return (
    <div className="ds-page slx-deal">
      <PageHeader crumbs={[{ label: "Sales" }, { label: "Pipeline", to: "/pipeline" }, { label: "Deal" }]} title="Deal" />
      <div className="ds-body"><Banner tone="critical" title="Couldn’t load this deal" action={<Link className="btn sm" to="/pipeline">Back to the pipeline</Link>}>It may have been removed, or the connection dropped.</Banner></div>
    </div>
  );
  if (!deal || !tab || !form) return <div className="ds-page slx-deal"><div className="ds-body"><p className="slx-muted">Loading the deal…</p></div></div>;

  const name = lead?.name ?? "Deal";
  const actions = nextActions({ ...deal, hasRecording });
  const next = actions.find((a) => !a.done);
  const offers = startOffers(deal, proposal?.history ?? [], projects);
  const current = proposal?.current ?? null;
  const showOnboarding = !!onboarding && (!!onboarding.onboarding || deal.stage === "won" || onboarding.canStartTest);
  const closed = deal.stage === "won" || deal.stage === "lost";
  const TABS: { key: Tab; label: string; count?: ReactNode }[] = [
    { key: "overview", label: "Overview" },
    { key: "notes", label: "Call notes" },
    { key: "recap", label: "Recap and options", count: deal.options ? deal.options.length : undefined },
    { key: "proposal", label: "Proposal", count: current ? `v${current.version}` : undefined },
  ];
  if (showOnboarding) TABS.push({ key: "onboarding", label: "Onboarding", count: onboarding?.items.length || undefined });

  const preview = current ? `/api/documents/${current.id}/preview.html?v=${encodeURIComponent(current.updatedAt)}` : null;
  const editable = !current || current.status === "draft";
  const headerActions = tab === "proposal" && deal.options && deal.recap && pform ? (
    <>
      {preview && <a className="btn" href={preview} target="_blank" rel="noreferrer"><Icon name="eye" size={16} />Preview as client</a>}
      <button type="button" className="btn" disabled={pa.busy || closed || !editable} onClick={pa.save}>Save draft</button>
      <button type="button" className="btn primary" disabled={!pa.canSend} onClick={pa.send}><Icon name="send" size={16} />Send for approval</button>
    </>
  ) : (
    <>
      <Link className="btn" to={`/leads/${deal.businessId}`}><Icon name="user" size={16} />Open lead</Link>
      {deal.recap && deal.options && <Link className="btn" to={`/deals/${deal.id}/deck`}><Icon name="layout" size={16} />Open the deck</Link>}
      {next && ACTION_TAB[next.label] && ACTION_TAB[next.label] !== tab && <button type="button" className="btn primary" onClick={() => setTab(ACTION_TAB[next.label])}>{next.label}</button>}
      {!next && deal.options && !closed && tab !== "proposal" && <button type="button" className="btn primary" onClick={() => setTab("proposal")}>{current ? "Open the proposal" : "Build the proposal"}</button>}
    </>
  );

  return (
    <div className="ds-page slx-deal">
      <PageHeader
        crumbs={[{ label: "Sales" }, { label: "Pipeline", to: "/pipeline" }, ...(tab === "proposal" ? [{ label: name, to: `/deals/${deal.id}` }, { label: "Proposal" }] : [{ label: name }])]}
        avatar={name}
        title={tab === "proposal" ? <>Proposal <span className="slx-title-sep">·</span> {name}</> : name}
        chips={<>
          {tab === "proposal" && current ? <Chip tone={DOC_TONE[current.status]} dot>{DOC_STATUS[current.status]}{current.test ? " (test)" : ""}</Chip>
            : <Chip tone={STAGE_TONE[deal.stage]} dot>{STAGE_LABEL[deal.stage]}</Chip>}
          {current && <Chip tone="outline">Version {current.version}</Chip>}
          {current && <Chip tone="outline">Ref {current.content.header.reference}</Chip>}
        </>}
        meta={[
          { icon: "tag", text: <>{cardPackage(deal)}{deal.valueCents !== null && <> · {dollars(deal.valueCents)} first year</>}</> },
          { icon: "calendar", text: `Started ${day(deal.createdAt)}` },
          ...(deal.lostReason ? [{ icon: "ban" as const, text: `Lost: ${deal.lostReason}` }] : []),
          ...projects.map((p) => ({ icon: "briefcase" as const, text: <Link to={`/projects/${p.id}`}>{projects.length === 1 ? "Project" : p.name}{p.test ? " (test)" : ""}</Link> })),
        ]}
        actions={headerActions}
        tabs={<Tabs tabs={TABS} value={tab} onChange={setTab} label="Deal sections" />}
      />
      <div className="ds-body">
        {onboardingFailed && <Banner tone="warning" title="Couldn’t load the onboarding">Its tab is hidden. Reload the page to try again.</Banner>}
        {tab === "overview" && (
          <Overview deal={deal} lead={lead} actions={actions} next={next} onGo={setTab} catalog={catalog} projects={projects}
            offers={offers} starting={starting} startError={startError} startNotice={startNotice} onStart={(k) => void startProjects(k)} />
        )}
        {tab === "notes" && <NotesTab deal={deal} form={form} setForm={setForm} audit={lead} dirty={dirty} onChange={setDeal} />}
        {tab === "recap" && <RecapTab deal={deal} hasRecording={hasRecording} catalog={catalog} onChange={setDeal} onProposal={() => setTab("proposal")} />}
        {tab === "proposal" && (pform
          ? <ProposalTab deal={deal} catalog={catalog} data={proposal} form={pform} setForm={setPform} dirty={proposalDirty} actions={pa} onRecap={() => setTab("recap")} />
          : proposalFailed ? <Banner tone="critical" title="Couldn’t load the proposal">Reload the page to try again.</Banner> : <p className="slx-muted">Loading the proposal…</p>)}
        {tab === "onboarding" && <OnboardingTab dealId={deal.id} data={onboarding} onReload={reloadOnboarding} />}
      </div>
    </div>
  );
}

/** The first tab: the one thing to do next, the steps so far, the call prep, the booked calls, the facts, the deck and the projects. */
function Overview({ deal, lead, actions, next, onGo, catalog, projects, offers, starting, startError, startNotice, onStart }: {
  deal: Deal; lead: { name: string; findings: { code: string; evidence: string }[] } | null; actions: { label: string; done: boolean }[]; next: { label: string } | undefined; onGo: (t: Tab) => void; catalog: Package[];
  projects: ProjectRow[]; offers: { canStart: boolean; canStartTest: boolean }; starting: boolean; startError: string; startNotice: string; onStart: (k: "start" | "test") => void;
}) {
  const closed = deal.stage === "won" || deal.stage === "lost";
  return (
    <>
      {offers.canStart && (
        <Banner tone="warning" title="Won, but no project has started"
          action={<button type="button" className="btn primary sm" disabled={starting} onClick={() => onStart("start")}>{starting ? "Starting…" : "Start projects"}</button>}>
          Projects start by themselves when the deposit is paid. This is the retry if they did not.
        </Banner>
      )}
      {offers.canStartTest && (
        <Banner tone="info" title="A signed test proposal is ready"
          action={<button type="button" className="btn sm" disabled={starting} onClick={() => onStart("test")}>{starting ? "Starting…" : "Start a test project"}</button>}>
          A test project has the same steps, never sends anything to Claude unasked, and is marked Test.
        </Banner>
      )}
      {startError && <Banner tone="critical" title="Couldn’t start the projects">{startError}</Banner>}
      {startNotice && <Banner tone="positive" title={startNotice} />}
      {next && ACTION_TAB[next.label] && (
        <Banner tone="signal" icon="arrow-right" title={`Next: ${next.label}`}
          action={ACTION_TAB[next.label] !== "overview" ? <button type="button" className="btn sm" onClick={() => onGo(ACTION_TAB[next.label])}>Go to {next.label.toLowerCase()}</button> : undefined}>
          {next.label === "Hold the discovery call" ? "The prep below has the opener, the questions and what to watch for." : `It is on the ${ACTION_TAB[next.label] === "notes" ? "Call notes" : "Recap and options"} tab.`}
        </Banner>
      )}
      {deal.stage === "lost" && <Banner tone="info" icon="ban" title="This deal is lost">{deal.lostReason ?? "No reason was given."}</Banner>}
      <div className="ds-cols c2">
        <div className="ds-col">
          {actions.length > 0 && (
            <Card icon="list" title="Steps to a proposal" note={`${actions.filter((a) => a.done).length} of ${actions.length} done`}>
              <ul className="slx-steps">
                {actions.map((a) => (
                  <li key={a.label} className={a.done ? "done" : ""}>
                    <span className="slx-step-mark" aria-hidden="true">{a.done && <Icon name="check" size={12} />}</span>
                    <span className="slx-step-text">{a.label}</span>
                    {!a.done && ACTION_TAB[a.label] && ACTION_TAB[a.label] !== "overview" && <button type="button" className="btn sm" onClick={() => onGo(ACTION_TAB[a.label])}>Open</button>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <div className="slx-legacy"><CallPrepPanel leadId={deal.businessId} findings={lead?.findings ?? []} /></div>
          {deal.recap && (
            <Card icon="file-text" title="Recap" note={LEAD_TYPE_GUIDE.find((g) => g.type === deal.recap!.leadType)?.lead}
              action={<button type="button" className="btn sm" onClick={() => onGo("recap")}>Open</button>}>
              <p className="slx-text">{deal.recap.recommendation}</p>
            </Card>
          )}
        </div>
        <div className="ds-col">
          <Card icon="info" title="About this deal">
            <Facts rows={[
              { label: "Stage", value: STAGE_LABEL[deal.stage] },
              { label: "Lead", value: <Link to={`/leads/${deal.businessId}`}>{lead?.name ?? "Open the lead"}</Link> },
              { label: "Value", value: deal.valueCents !== null ? `${dollars(deal.valueCents)} first year` : "Set by the recap" },
              { label: "Came from", value: deal.source === "booking" ? "A booked call" : deal.skipCall ? "Started by hand, no call" : "Started by hand" },
              { label: "Call held", value: deal.notes?.callHeldAt ? when(deal.notes.callHeldAt) : "Not yet" },
              { label: "Updated", value: when(deal.updatedAt) },
            ]} />
          </Card>
          <div className="slx-legacy"><UpcomingBooking key={deal.stage} leadId={deal.businessId} /></div>
          <DeckCard deal={deal} catalog={catalog} />
          {projects.length > 0 && (
            <Card icon="briefcase" title="Projects" flush note={`${projects.length}`}>
              {projects.map((p) => <LinkRow key={p.id} to={`/projects/${p.id}`} icon="briefcase" title={p.name} sub={`${p.openTasks} open · ${p.doneTasks} done${p.test ? " · test" : ""}`} />)}
            </Card>
          )}
        </div>
      </div>
    </>
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

  const bar = (
    <div className="slx-actions">
      <button type="button" className="btn primary" disabled={busy || closed} onClick={() => run(async () => { await save(); })}>Save notes</button>
      {deal.stage === "booked" && <button type="button" className="btn" disabled={busy} onClick={callDone}><Icon name="check" size={16} />Call done</button>}
      {dirty && !saved && <span className="slx-hint">Unsaved changes.</span>}
      {saved && <span className="slx-ok" role="status">Saved.</span>}
      {deal.notes?.callHeldAt && <span className="slx-hint">Call held {when(deal.notes.callHeldAt)}.</span>}
    </div>
  );

  return (
    <div className="ds-cols c2">
      <Card icon="pen" title="What the owner said" note="Their own words">
        <section className="slx-form" aria-label="Call notes">
          <p className="slx-hint">Write what the owner said in their own words. The recap and the deck use only the numbers they gave.</p>
          {DISCOVERY_QUESTIONS.map((q, i) => (
            <label key={i} className="slx-field">
              <span><b className="slx-qn">{i + 1}</b>{q}</span>
              <textarea rows={2} maxLength={2000} value={form.answers[i]} disabled={closed} onChange={(e) => setAt("answers", i, e.target.value)} />
            </label>
          ))}
          {error && <p className="slx-error" role="alert">{error}</p>}
          {bar}
        </section>
      </Card>
      <div className="ds-col">
        <Card icon="trending" title="What is at stake" note="From their numbers">
          <div className="slx-form">
            <label className="slx-field"><span>Average job is worth (dollars)</span>
              <input inputMode="decimal" value={form.avgJob} disabled={closed} onChange={(e) => set({ avgJob: e.target.value })} /></label>
            <label className="slx-field"><span>Jobs missed in a month</span>
              <input inputMode="numeric" value={form.missed} disabled={closed} onChange={(e) => set({ missed: e.target.value })} /></label>
            <p className={atStake !== null ? "slx-stake" : "slx-hint"}>{atStake !== null ? <><b>{dollars(atStake)}</b> a month at stake</> : "Fill in both numbers to see what is at stake each month. Nothing is estimated."}</p>
          </div>
        </Card>
        <Card icon="target" title="Goals and where they are">
          <div className="slx-form">
            <fieldset className="slx-field" disabled={closed}>
              <legend>Their goals (up to three)</legend>
              {form.goals.map((g, i) => <input key={i} aria-label={`Goal ${i + 1}`} maxLength={200} value={g} onChange={(e) => setAt("goals", i, e.target.value)} />)}
            </fieldset>
            <fieldset className="slx-field" disabled={closed}>
              <legend>Where they are now (up to three)</legend>
              {form.currentState.map((g, i) => <input key={i} aria-label={`Where they are now ${i + 1}`} maxLength={200} value={g} onChange={(e) => setAt("currentState", i, e.target.value)} />)}
            </fieldset>
          </div>
        </Card>
        <Card icon="globe" title="Their site and who decides">
          <div className="slx-form">
            <label className="slx-field"><span>Their site is on</span>
              <select value={form.platform} disabled={closed} onChange={(e) => set({ platform: e.target.value as NotesForm["platform"] })}>
                <option value="wordpress">WordPress</option><option value="other">Something else (Wix, Squarespace, GoDaddy…)</option>
              </select><small className="slx-hint">Care is only offered for WordPress sites.</small></label>
            <label className="slx-field"><span>Who decides</span>
              <input maxLength={300} value={form.decisionMakers} disabled={closed} onChange={(e) => set({ decisionMakers: e.target.value })} /></label>
          </div>
        </Card>
      </div>
    </div>
  );
}

/** The deck: whether its prices are frozen, any drift from today's catalog, and the links to open it or download the PDF. */
function DeckCard({ deal, catalog }: { deal: Deal; catalog: Package[] }) {
  if (!deal.recap || !deal.options) {
    return <Card icon="layout" title="Recommendation deck"><p>Draft the recap first: the deck is built from the notes and the recap.</p></Card>;
  }
  const drift = priceDrift(deal, catalog);
  const frozen = deal.deckFrozenAt ? when(deal.deckFrozenAt) : null;
  return (
    <Card icon="layout" title="Recommendation deck" note={frozen ? "Prices frozen" : "Draft"}>
      <p>{frozen ? `Prices frozen ${frozen}. The deck shows those prices even if the catalog changes.` : "Draft: the prices freeze the first time you open the deck or download the PDF."}</p>
      {drift.length > 0 && (
        <div className="slx-warn-box" role="status">
          <p>The catalog has changed since the prices were frozen:</p>
          <ul>{drift.map((d) => <li key={d}>{d}</li>)}</ul>
          <p>Open the deck and choose “Freeze prices” to use today’s prices.</p>
        </div>
      )}
      <div className="slx-actions">
        <Link className="btn sm" to={`/deals/${deal.id}/deck`}><Icon name="layout" size={14} />Open the deck</Link>
        <a className="btn sm" href={`/api/deals/${deal.id}/deck.pdf`} download><Icon name="arrow-up-right" size={14} />Download PDF</a>
      </div>
    </Card>
  );
}

function RecapTab({ deal, hasRecording, catalog, onChange, onProposal }: { deal: Deal; hasRecording: boolean; catalog: Package[]; onChange: (d: Deal) => void; onProposal: () => void }) {
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
  const canDraft = hasNotes(deal.notes) || hasRecording;

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
  const draftBtn = <button type="button" className={`btn${recap ? "" : " primary"}`} disabled={busy || queued || closed || !canDraft} onClick={draft}><Icon name="sparkles" size={16} />{recap ? "Draft recap again" : "Draft recap"}</button>;
  return (
    <>
      {queued && <Banner tone="signal" icon="clock" title="Recap queued">Claude writes it the next time it works the queue. This page checks for it every few seconds.</Banner>}
      {error && <Banner tone="critical" title="That didn’t work">{error}</Banner>}
      {booked && <Banner tone="positive" title={`Recommendation meeting booked for ${booked}`}>The invite is on its way.</Banner>}
      <div className="ds-cols c2">
        <div className="ds-col">
          <Card icon="file-text" title="What I heard" note={leadLabel ? `Kind of lead: ${leadLabel}` : undefined} action={recap ? draftBtn : undefined}>
            {recap ? (
              <div className="slx-recap">
                <p className="slx-text">{recap.playback}</p>
                <h3>Their goals</h3>
                <ul className="slx-checks">{recap.goals.map((g, i) => <li key={i}><Icon name="check" size={14} />{g}</li>)}</ul>
                {recap.currentState.length > 0 && <><h3>Where they are now</h3><ul className="slx-dots">{recap.currentState.map((g, i) => <li key={i}>{g}</li>)}</ul></>}
                <h3>My recommendation</h3>
                <p className="slx-callout">{recap.recommendation}</p>
              </div>
            ) : (
              <Empty icon="file-text" title="No recap yet" action={draftBtn}>
                {canDraft ? "“Draft recap” asks Claude to write it from the notes and the call recording, with three options to offer."
                  : "Write the call notes first, or record the call: the recap is built from the owner’s own words."}
              </Empty>
            )}
          </Card>
          {options && (
            <Card icon="grid" title="The three options" note={deal.valueCents !== null ? `Recommended: ${dollars(deal.valueCents)} first year` : undefined}
              action={!closed ? <button type="button" className="btn sm" onClick={() => setEditing(!editing)}><Icon name="pen" size={14} />{editing ? "Close editor" : "Edit options"}</button> : undefined}>
              {!editing ? (
                <>
                  <div className="slx-options">
                    {options.map((o) => {
                      const s = optionSummary(o, catalog);
                      return (
                        <article key={o.id} className={`slx-option${o.recommended ? " rec" : ""}`}>
                          <header><span className="slx-option-id">{o.id.toUpperCase()}</span><h4>{o.label}</h4>{o.recommended && <Chip tone="signal">Recommended</Chip>}</header>
                          {o.tagline && <p className="slx-hint">{o.tagline}</p>}
                          <ul className="slx-checks">{s.items.map((x, i) => <li key={i}><Icon name="check" size={14} />{x}</li>)}</ul>
                          <p className="slx-option-price">{[s.upfront && `${s.upfront} up front`, s.monthly].filter(Boolean).join(" + ")}</p>
                        </article>
                      );
                    })}
                  </div>
                  <p className="slx-hint">First-year value is up front plus 12 months. Prices are from the catalog as of the recap.</p>
                </>
              ) : <OptionsEditor deal={deal} options={options} catalog={catalog} onSaved={(d) => { onChange(d); setEditing(false); }} />}
            </Card>
          )}
        </div>
        <div className="ds-col">
          <Card icon="calendar" title="Recommendation meeting">
            {canOffer ? (
              <>
                <p>Offer the owner two times on the call. Booking sends them a calendar invite with a Meet link and a confirmation email.</p>
                <div className="slx-actions"><button type="button" className="btn" disabled={busy} onClick={offer}><Icon name="clock" size={16} />Offer two times</button></div>
              </>
            ) : <p>{hasMeeting ? "A recommendation meeting is booked. It is on the Overview tab." : closed ? "The deal is closed." : deal.stage === "recommended" || deal.stage === "proposal_sent" ? "The recommendation has been presented." : "Draft the recap first, then offer two times."}</p>}
            {times && (
              <div className="slx-times">
                {times.slots.length === 0 && <p className="slx-hint">No times to offer. Set your availability and connect Google in Settings, then try again.</p>}
                {times.slots.map((s) => <button key={s} type="button" className="btn" disabled={busy} onClick={() => book(s, times.tz)}>Book {formatSlot(s, times.tz)}</button>)}
              </div>
            )}
          </Card>
          <DeckCard deal={deal} catalog={catalog} />
          {options && !closed && (
            <Card icon="file-text" title="Proposal">
              <p>When they pick an option, build the proposal from it.</p>
              <div className="slx-actions"><button type="button" className="btn sm" onClick={onProposal}>Open the proposal builder</button></div>
            </Card>
          )}
        </div>
      </div>
    </>
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
    <div className="slx-form">
      <p className="slx-hint">The middle option is the recommended one. A discount comes off a setup fee only, never a monthly price.</p>
      <div className="slx-options">
        {draft.map((o) => (
          <fieldset key={o.id} className="slx-option">
            <legend>Option {o.id.toUpperCase()}{o.recommended ? " (recommended)" : ""}</legend>
            <label className="slx-field"><span>Name</span><input maxLength={60} value={o.label} onChange={(e) => edit(o.id, { label: e.target.value })} /></label>
            <label className="slx-field"><span>One line</span><input maxLength={150} value={o.tagline} onChange={(e) => edit(o.id, { tagline: e.target.value })} /></label>
            {choosable.map((p) => {
              const on = o.items.some((i) => i.key === p.key);
              return (
                <div key={p.key} className="slx-pkg">
                  <label><input type="checkbox" className="cb" checked={on} onChange={() => toggle(o, p.key)} /> {p.name} <span className="slx-hint">{formatPrice(p)}</span></label>
                  {on && (p.setupCents > 0 || p.kind === "one_time") && (
                    <input aria-label={`Setup discount on ${p.name} (dollars)`} placeholder="Setup discount, $" inputMode="decimal" value={disc[`${o.id}:${p.key}`] ?? ""}
                      onChange={(e) => setDisc({ ...disc, [`${o.id}:${p.key}`]: e.target.value })} />
                  )}
                </div>
              );
            })}
          </fieldset>
        ))}
      </div>
      {problems.length > 0 && <ul className="slx-error" role="alert">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      <div className="slx-actions"><button type="button" className="btn primary" disabled={busy} onClick={save}>Save options</button></div>
    </div>
  );
}
