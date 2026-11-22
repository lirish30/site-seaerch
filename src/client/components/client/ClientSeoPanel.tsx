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

  if (data === null) {
    if (!hasPlan) return null;
    return (
      <section className="cl-card sx" aria-label="Local SEO">
        <h2>Local SEO</h2>
        {failed ? <p className="error small" role="alert">Couldn’t load Local SEO. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p> : <p className="muted small">Loading…</p>}
      </section>
    );
  }
  if (!hasPlan && data.profile === null) return null;

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
  return (
    <section className="cl-card sx" aria-label="Local SEO">
      <div className="sx-head">
        <div>
          <h2>Local SEO</h2>
          <p className="small muted">
            {data.profile ? profileStatusLabel(data.profile.status) : "Not set up yet"}
            {waiting > 0 && ` · ${waiting} ${waiting === 1 ? "draft" : "drafts"} waiting for you`}
          </p>
        </div>
        <div className="sx-head-actions">
          {canCheck && <button type="button" className="btn" aria-disabled={busy} onClick={() => void baseline()}>{busy ? "Taking the baseline…" : "Take the baseline now"}</button>}
          <button type="button" className="btn" onClick={() => void load()}>Refresh</button>
        </div>
      </div>
      {canCheck && <p className="small muted sx-help">The baseline reads the Google listing, checks the site’s name, address and phone, runs a rank check for every search term that is on, and starts the daily watch. It uses Google lookups, so it is not run on every visit.</p>}
      <Say ok={ok} error={error} />
      {failed && <p className="error small" role="alert">Couldn’t refresh just now. What you see may be out of date. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p>}
      <nav className="sx-jump small" aria-label="Jump to">
        <a href="#sx-report">Report</a><a href="#sx-reviews">Reviews</a><a href="#sx-content">Content</a>
      </nav>
      <div className="sx-cols">
        <div className="sx-col">
          <ProfileForm clientId={businessId} clientName={clientName} clientAddress={clientAddress} data={data} sites={sites} onSaved={load} />
          <Keywords clientId={businessId} keywords={data.keywords} onChanged={patch} />
          <Ranks clientId={businessId} data={data} canCheck={canCheck && data.keywords.some((k) => k.active)} onChanged={load} />
          <Snapshot snapshot={data.snapshot} />
          <NapBlock clientId={businessId} nap={data.nap} canCheck={canCheck} onChecked={patch} />
          <Citations clientId={businessId} citations={data.citations} onChanged={patch} />
        </div>
        <div className="sx-col">
          <div id="sx-report"><SeoReport clientId={businessId} /></div>
          <div id="sx-reviews"><Reviews reviews={data.reviews} onChanged={(reviews) => patch({ reviews })} /></div>
          <div id="sx-content"><SeoContent content={data.content} onChanged={(content) => patch({ content })} /></div>
        </div>
      </div>
    </section>
  );
}
