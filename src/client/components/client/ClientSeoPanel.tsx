import { useCallback, useEffect, useState } from "react";
import { seoApi, type SeoOverview } from "../../api";
import { latestOnly } from "../../clientView";
import { profileStatusLabel } from "../../seoView";
import { Say, sentence } from "./seo/seoBits";
import { Content as SeoContent } from "./seo/SeoContent";
import { Citations, NapBlock, Ranks, Snapshot } from "./seo/SeoRanks";
import { SeoReport } from "./seo/SeoReport";
import { Reviews } from "./seo/SeoReviews";
import { Keywords, ProfileForm, type SiteChoice } from "./seo/SeoSetup";
import { Link } from "react-router-dom";
import { dayLabel } from "../../careReportPageView";
import { Card, Chip } from "../ds";
import Icon, { type IconName } from "../Icon";

/**
 * A client's Local SEO on their page: the Google listing and search terms, the 3x3 rank grids with what changed since the check before, the listing's numbers, the name, address and phone check, the directories,
 * the reviews with Claude's reply drafts, the month's content, and the month's report with its words and link. It shows for a client with a Local SEO plan or a profile. Nothing in it posts or publishes anywhere:
 * every draft is words to copy, and "Mark posted" and "Mark published" only record what Logan did himself.
 */
export default function ClientSeoPanel({ businessId, clientName, clientAddress, sites, hasPlan }: {
  businessId: string; clientName: string; clientAddress: string; sites: SiteChoice[]; hasPlan: boolean;
}) {
  const [data, setData] = useState<SeoOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [guard] = useState(latestOnly);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const next = await seoApi.overview(businessId);
      if (guard.isLatest(ticket)) { setData(next); setFailed(false); }
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [businessId, guard]);
  useEffect(() => { setData(null); setFailed(false); setOk(""); setError(""); void load(); return () => guard.cancel(); }, [load, guard]);
  const patch = (p: Partial<SeoOverview>) => setData((d) => (d ? { ...d, ...p } : d));

  const INCLUDES: { icon: IconName; title: string; sub: string }[] = [
    { icon: "pin", title: "Google listing watch", sub: "The profile’s rating, reviews, photos and hours, read every day" },
    { icon: "grid", title: "Rank checks", sub: "Up to ten search terms, each checked from nine points around the business" },
    { icon: "star", title: "Review replies", sub: "Claude drafts a reply to each new review for you to post" },
    { icon: "pen", title: "Pages and posts", sub: "A page or post and a Google post planned each month" },
    { icon: "file-text", title: "Monthly report", sub: "What changed, in plain words, sent after you approve it" },
  ];
  const noPlan = (
    <div className="clx-seo-none">
      <Card icon="target" title="Local SEO" note={<Chip tone="outline">Not on this client’s plan</Chip>}>
        <div className="clx-seo-pitch">
          <span className="ds-tile signal big"><Icon name="target" size={18} /></span>
          <div>
            <b>Help {clientName} show up on Google Maps</b>
            <p>When a client signs a Local SEO plan, its Google listing, search terms, rank checks, reviews and monthly report are set up and run from this tab.</p>
          </div>
        </div>
        <ul className="clx-includes">
          {INCLUDES.map((i) => (
            <li key={i.title}><span className="ds-tile neutral"><Icon name={i.icon} size={15} /></span><span className="clx-setup-text"><b>{i.title}</b><small>{i.sub}</small></span></li>
          ))}
        </ul>
        <div className="ds-row"><Link to={`/leads/${encodeURIComponent(businessId)}`} className="btn"><Icon name="arrow-right" size={16} />Propose it from the lead record</Link></div>
      </Card>
    </div>
  );
  if (data === null) {
    if (!hasPlan) return noPlan;
    return (
      <Card icon="target" title="Local SEO">
        {failed ? <p className="error small" role="alert">Couldn’t load Local SEO. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p> : <p className="muted small">Loading…</p>}
      </Card>
    );
  }
  if (!hasPlan && data.profile === null) return noPlan;

  const canCheck = !!data.profile?.placeId;
  const waiting = data.reviews.filter((r) => r.replyStatus === "drafted").length + data.content.filter((c) => c.status === "drafted").length;
  async function baseline() {
    if (busy) return;
    setBusy(true); setOk(""); setError("");
    try {
      const r = await seoApi.baseline(businessId);
      setOk(`Baseline taken: ${r.ranked} of ${data!.keywords.filter((k) => k.active).length} search terms have a usable rank check.${r.napNote ? ` Name, address and phone not checked: ${r.napNote}` : ""}`);
      await load();
    } catch (e) { setError(sentence(e, "Couldn’t take the baseline. Try again.")); }
    finally { setBusy(false); }
  }
  const status = data.profile ? profileStatusLabel(data.profile.status) : "Not set up yet";
  return (
    <div className="sx clx-seo">
      <div className="ds-card clx-seo-top-card">
        <div className="clx-seo-top">
          <span className={`ds-tile ${data.profile?.status === "active" ? "positive" : "signal"}`}><Icon name="target" size={16} /></span>
          <span className="clx-site-title"><b>Local SEO</b><small>{status}{data.profile?.lastWatchOn ? ` · last looked ${dayLabel(data.profile.lastWatchOn) ?? data.profile.lastWatchOn}` : ""}</small></span>
          {waiting > 0 && <Chip tone="signal" dot>{waiting} {waiting === 1 ? "draft" : "drafts"} waiting for you</Chip>}
          <span className="ds-grow" />
          <nav className="clx-seo-jump" aria-label="Jump to">
            <a href="#sx-report">Report</a><a href="#sx-reviews">Reviews</a><a href="#sx-content">Content</a>
          </nav>
          <button type="button" className="btn sm" onClick={() => void load()}><Icon name="refresh" size={14} />Refresh</button>
          {canCheck && <button type="button" className="btn sm primary" aria-disabled={busy} onClick={() => void baseline()}>{busy ? "Taking the baseline…" : "Take the baseline now"}</button>}
        </div>
        {canCheck && <p className="sx-help clx-seo-help">The baseline reads the Google listing, checks the site’s name, address and phone, runs a rank check for every search term that is on, and starts the daily watch. It uses Google lookups, so it is not run on every visit.</p>}
        <Say ok={ok} error={error} />
        {failed && <p className="error small" role="alert">Couldn’t refresh just now. What you see may be out of date. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p>}
      </div>
      <div className="clx-seo-cols">
        <div className="clx-seo-col">
          <ProfileForm clientId={businessId} clientName={clientName} clientAddress={clientAddress} data={data} sites={sites} onSaved={load} />
          <Keywords clientId={businessId} keywords={data.keywords} onChanged={patch} />
          <Ranks clientId={businessId} data={data} canCheck={canCheck && data.keywords.some((k) => k.active)} onChanged={load} />
          <Snapshot snapshot={data.snapshot} />
          <NapBlock clientId={businessId} nap={data.nap} canCheck={canCheck} onChecked={patch} />
          <Citations clientId={businessId} citations={data.citations} onChanged={patch} />
        </div>
        <div className="clx-seo-col">
          <div id="sx-report"><SeoReport clientId={businessId} /></div>
          <div id="sx-reviews"><Reviews reviews={data.reviews} onChanged={(reviews) => patch({ reviews })} /></div>
          <div id="sx-content"><SeoContent content={data.content} onChanged={(content) => patch({ content })} /></div>
        </div>
      </div>
    </div>
  );
}
