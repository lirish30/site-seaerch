import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Icon from "../components/Icon";
import { Meter, PubBar, PubContact, PubError, PubGone, PubNotice, PubSkeleton, Tile, useNoIndex } from "../components/PublicPage";
import { formatSlot } from "../bookingView";
import { groupByPhase, isBuildOnboarding, nextStep, phaseHeading, progressLabel, progressPercent, type PublicOnboarding } from "../onboardView";
import { safeHttpsUrl } from "../proposalPageView";
import { isReportToken } from "../reportView";
import { makeApi } from "./onboard/api";
import ItemCard from "./onboard/ItemCard";
import Questionnaire, { type PageHooks } from "./onboard/Questionnaire";

type Load = "loading" | "ok" | "gone" | "busy" | "error";

const KIND = "Getting started";

/** The kickoff as "Tue, Mar 16, 10:00 AM PDT" in the owner's zone, or null when it is not a date. */
function kickoffText(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  try { return formatSlot(iso, tz); } catch { return null; }
}

/** The side card: who it is for, progress, the one next thing, the kickoff and the welcome video. */
function Welcome({ page }: { page: PublicOnboarding }) {
  const video = page.welcomeVideoUrl ? safeHttpsUrl(page.welcomeVideoUrl) : null;
  const kickoff = kickoffText(page.kickoffAt, page.timezone);
  const next = nextStep(page);
  const pct = progressPercent(page.progress);
  return (
    <article className="pbx-card tight">
      <div className="pbx-col" style={{ gap: 6 }}>
        <p className="pbx-eyebrow">{page.businessName ? `Getting started · ${page.businessName}` : "Getting started"}</p>
        <h1 style={{ fontSize: 24, lineHeight: "30px", letterSpacing: "-.5px" }}>{page.contactFirstName ? `Welcome, ${page.contactFirstName}` : "Welcome"}</h1>
        <p className="pbx-sub">{page.closed ? "Everything we asked for, and what you sent us." : `Here is everything we need from you ${isBuildOnboarding(page.items) ? "to build your site" : "to get you set up"}. Do what you can, and come back for the rest. Everything saves as you go.`}</p>
      </div>
      <Meter label="Your progress" value={progressLabel(page.progress)} percent={pct} tone={pct >= 100 ? "positive" : "signal"} />
      {next && (
        <a className="pbx-next" href={`#${next.target}`}>
          <div><small>Up next</small><b>{next.label}</b></div>
          <Icon name="arrow-right" size={16} />
        </a>
      )}
      {!next && !page.closed && <div className="pbx-done"><Tile icon="check" size={28} /><div><b>Nothing is waiting on you</b><p>We'll be in touch if we need anything else.</p></div></div>}
      {kickoff && <div className="pbx-kick"><Tile icon="calendar" tone="info" size={32} /><div><small>Kickoff call</small><b>{kickoff}</b></div></div>}
      {video && <a className="btn pbx-go" href={video} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} />Watch a short welcome video</a>}
    </article>
  );
}

// Public page: deliberately bypasses api.ts, whose 401 handling redirects to /login. Every string from the server (names, the owner's instructions, the client's
// own answers and file names) is shown as React text, which escapes it; the only link is the welcome video, and only when it is https.
export default function Onboard() {
  const rest = useParams()["*"];
  const token = isReportToken(rest) ? rest : undefined;
  const api = useMemo(() => (token ? makeApi(token) : null), [token]);
  const [load, setLoad] = useState<Load>("loading");
  const [page, setPage] = useState<PublicOnboarding | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alive = useRef(true);
  useNoIndex("Your onboarding");

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(refreshTimer.current); };
  }, []);

  useEffect(() => {
    if (!api) { setLoad("gone"); return; }
    let cancelled = false;
    setLoad("loading");
    void api.load().then(({ status, page: data }) => {
      if (cancelled) return;
      if (data) { setPage(data); setLoad("ok"); }
      else setLoad(status === 404 ? "gone" : status === 429 ? "busy" : "error");
    });
    return () => { cancelled = true; };
  }, [api, attempt]);

  /** Takes the page as the server has it now, quietly: no spinner, and a failed try changes nothing on screen. */
  const refreshNow = useCallback(async () => {
    if (!api) return;
    const { status, page: data } = await api.refresh();
    if (!alive.current) return;
    if (data) setPage(data);
    else if (status === 404) setLoad("gone");
  }, [api]);

  // After something is saved, look at the page again once things have settled: progress and each item's state come from the server.
  const refreshSoon = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void refreshNow(), 2500);
  }, [refreshNow]);

  const hooks: PageHooks = useMemo(() => ({
    onSaved: refreshSoon,
    onSubmitted: () => void refreshNow(),
    onLocked: () => void refreshNow(),
    onGone: () => setLoad("gone"),
  }), [refreshNow, refreshSoon]);

  if (load === "loading") return <PubSkeleton kind={KIND} label="Loading your onboarding" two />;
  if (load === "busy") return (
    <PubNotice kind={KIND} icon="clock" tone="warning" title="Please wait a moment">
      <p>This page has been opened a lot in the last minute. Wait a minute, then try again.</p>
      <button type="button" className="btn primary" onClick={() => setAttempt((n) => n + 1)}><Icon name="refresh" size={16} />Try again</button>
    </PubNotice>
  );
  if (load === "error") return <PubError kind={KIND} what="this page" onRetry={() => setAttempt((n) => n + 1)} />;
  if (load === "gone" || !page || !api) return <PubGone kind={KIND} title="This link is no longer active."><p>Reply to the email you were sent.</p></PubGone>;

  const now = new Date();
  const groups = groupByPhase(page.items);
  const next = nextStep(page);
  const build = isBuildOnboarding(page.items);
  return (
    <main className="ds-page pbx pbx-ob">
      <PubBar name={KIND} right={<>
        {page.businessName && <span className="pbx-bar-meta hide-sm">For {page.businessName}</span>}
        {page.closed ? <span className="ds-chip positive"><i className="ds-dot" />All done</span> : <span className="ds-chip outline">{progressLabel(page.progress)}</span>}
      </>} />
      <div className="pbx-grid">
        <aside className="pbx-side" aria-label="Your progress">
          <Welcome page={page} />
          {!page.closed && (
            <aside className="pbx-safe" aria-label="A note about passwords">
              <Icon name="shield" size={16} />
              <p>Please don't type any passwords here. We'll ask for access a safer way.</p>
            </aside>
          )}
        </aside>
        <div className="pbx-col">
          {page.closed && (
            <section className="pbx-card tight" role="status">
              <div className="pbx-done"><Tile icon="check" size={32} /><div><b>All done</b><p>{page.contactFirstName ? `Thank you, ${page.contactFirstName}. ` : "Thank you. "}We have what we need, and this page is now read-only.</p></div></div>
            </section>
          )}
          <Questionnaire page={page} api={api} now={now} closed={page.closed} hooks={hooks} />
          {groups.map((g) => {
            const done = g.items.filter((i) => i.status !== "waiting").length;
            return (
              <section key={g.phase} className="pbx-card flush" aria-labelledby={`ob-phase-${g.phase}`}>
                <div className="pbx-card-head">
                  <Tile icon={!build ? "key" : g.phase === 1 ? "layout" : "grid"} tone={done === g.items.length ? "positive" : "neutral"} />
                  <div><h2 id={`ob-phase-${g.phase}`}>{phaseHeading(g, build)}</h2><small>{done} of {g.items.length} done{done < g.items.length ? ". Open a row to answer or upload." : ""}</small></div>
                </div>
                <ul className="pbx-items">
                  {g.items.map((item) => <ItemCard key={item.id} item={item} api={api} now={now} timezone={page.timezone} readOnly={page.closed} hooks={hooks} open={next?.target === `ob-item-${item.id}`} />)}
                </ul>
              </section>
            );
          })}
          <PubContact text="Stuck on something, or not sure what we mean? Reply to the email you were sent." />
        </div>
      </div>
    </main>
  );
}
