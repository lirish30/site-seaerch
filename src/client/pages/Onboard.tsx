import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Icon from "../components/Icon";
import { formatSlot } from "../bookingView";
import { groupByPhase, progressLabel, progressPercent, type PublicOnboarding } from "../onboardView";
import { safeHttpsUrl } from "../proposalPageView";
import { isReportToken } from "../reportView";
import { makeApi } from "./onboard/api";
import ItemCard from "./onboard/ItemCard";
import Questionnaire, { type PageHooks } from "./onboard/Questionnaire";

type Load = "loading" | "ok" | "gone" | "busy" | "error";

/** A page that is only a message: link gone, load failed. */
function Notice({ icon, title, children }: { icon: "link" | "alert" | "check"; title: string; children?: React.ReactNode }) {
  return (
    <main className="rp">
      <div className="rp-wrap rp-wrap-narrow">
        <section className="rp-card rp-notice">
          <span className="rp-notice-icon" aria-hidden="true"><Icon name={icon} size={20} /></span>
          <h1>{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}

function Skeleton() {
  return (
    <main className="rp" aria-busy="true">
      <div className="rp-wrap">
        <div className="rp-card" role="status" aria-label="Loading your onboarding">
          <span className="rp-sk" style={{ height: 28, width: "60%" }} />
          <span className="rp-sk" style={{ height: 160, borderRadius: 12 }} />
        </div>
      </div>
    </main>
  );
}

/** The kickoff as "Tue, Mar 16, 10:00 AM PDT" in the owner's zone, or null when it is not a date. */
function kickoffText(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  try { return formatSlot(iso, tz); } catch { return null; }
}

function Welcome({ page }: { page: PublicOnboarding }) {
  const video = page.welcomeVideoUrl ? safeHttpsUrl(page.welcomeVideoUrl) : null;
  const kickoff = kickoffText(page.kickoffAt, page.timezone);
  return (
    <article className="rp-card ob-card">
      <div className="rp-head">
        <span className="rp-eyebrow">Getting started</span>
        <h1>{page.contactFirstName ? `Welcome, ${page.contactFirstName}` : "Welcome"}</h1>
        <p className="rp-based">Here is everything we need from you to build your site. Do what you can, and come back for the rest. Everything saves as you go.</p>
      </div>
      {video && <a className="btn ob-video" href={video} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} />Watch a short welcome video</a>}
      {kickoff && <p className="ob-kickoff"><Icon name="calendar" size={16} /><span>Kickoff call: {kickoff}</span></p>}
      <div className="ob-progress">
        <div className="ob-progress-text"><span>Your progress</span><span>{progressLabel(page.progress)}</span></div>
        <div className="ob-bar" role="progressbar" aria-label="Your progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent(page.progress)}>
          <span style={{ width: `${progressPercent(page.progress)}%` }} />
        </div>
      </div>
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

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Your onboarding";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    if (!meta) { meta = document.createElement("meta"); meta.name = "robots"; document.head.appendChild(meta); }
    const prevContent = meta.content;
    meta.content = "noindex, nofollow";
    return () => { document.title = prevTitle; if (created) meta.remove(); else meta.content = prevContent; };
  }, []);

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

  if (load === "loading") return <Skeleton />;
  if (load === "busy") return (
    <Notice icon="alert" title="Please wait a moment">
      <p>This page has been opened a lot in the last minute. Wait a minute, then try again.</p>
      <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
    </Notice>
  );
  if (load === "error") return (
    <Notice icon="alert" title="Couldn't load this page">
      <p>Something went wrong on our side, or your connection dropped. Please try again.</p>
      <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
    </Notice>
  );
  if (load === "gone" || !page || !api) return <Notice icon="link" title="This link is no longer active."><p>Reply to the email you were sent.</p></Notice>;

  const now = new Date();
  const groups = groupByPhase(page.items);
  return (
    <main className="rp ob">
      <div className="rp-wrap ob-wrap">
        <header className="rp-bar"><span className="rp-bar-name">{page.businessName ? `${page.businessName}: getting started` : "Getting started"}</span></header>
        {page.closed && (
          <section className="rp-card ob-card ob-closed" role="status">
            <h2><Icon name="check" size={18} />All done</h2>
            <p>{page.contactFirstName ? `Thank you, ${page.contactFirstName}. ` : "Thank you. "}We have what we need, and this page is now read-only.</p>
          </section>
        )}
        <Welcome page={page} />
        {!page.closed && (
          <aside className="ob-safe" aria-label="A note about passwords">
            <Icon name="shield" size={16} />
            <p>Please don't type any passwords here. We'll ask for access a safer way.</p>
          </aside>
        )}
        <Questionnaire page={page} api={api} now={now} closed={page.closed} hooks={hooks} />
        {groups.map((g) => (
          <section key={g.phase} className="rp-card ob-card" aria-labelledby={`ob-phase-${g.phase}`}>
            <h2 id={`ob-phase-${g.phase}`}>{g.title}</h2>
            <ul className="ob-items">
              {g.items.map((item) => <ItemCard key={item.id} item={item} api={api} now={now} timezone={page.timezone} readOnly={page.closed} hooks={hooks} />)}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
