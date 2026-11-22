import { useEffect, useState, type FormEvent } from "react";
import { seoApi, type SeoOverview } from "../../../api";
import { safeHref } from "../../../clientView";
import { dayLabel } from "../../../careReportPageView";
import { keywordLimitLeft, MAX_ACTIVE_KEYWORDS, profileStatusLabel, starsLabel, termName } from "../../../seoView";
import type { PlaceCandidate } from "../../../../worker/seo/places";
import { Part, Say, sentence } from "./seoBits";

export interface SiteChoice { id: string; domain: string }
type Patch = (p: Partial<SeoOverview>) => void;

const MAX_TOWNS = 8;
const towns = (s: string): string[] => s.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);

/** One Google match: its name, address and rating as text, a link to see it on the map, and the button that picks it. Nothing here is chosen for the owner, even when two matches share a name. */
function Candidate({ c, picked, onPick }: { c: PlaceCandidate; picked: boolean; onPick: () => void }) {
  const href = safeHref(c.mapsUrl);
  return (
    <li className={`sx-cand${picked ? " picked" : ""}`}>
      <div className="sx-cand-text">
        <b>{c.name}</b>
        <span className="small muted">{c.address}</span>
        {c.rating !== null && <span className="small muted">{starsLabel(c.rating)}{c.reviewCount !== null ? `, ${c.reviewCount} ${c.reviewCount === 1 ? "review" : "reviews"}` : ""}</span>}
        {href && <a className="small" href={href} target="_blank" rel="noopener noreferrer">See it on Google Maps</a>}
      </div>
      <button type="button" className={`btn${picked ? " primary" : ""}`} aria-pressed={picked} onClick={onPick}>{picked ? "Picked" : "Use this one"}</button>
    </li>
  );
}

/**
 * The client's Google listing and search area: what the profile is tied to now, and the form that searches Google for the business, takes the owner's pick, and saves the trade, towns and grid spacing.
 * The listing's name, address, phone and location always come from Google; nothing typed here sets them.
 */
export function ProfileForm({ clientId, clientName, clientAddress, data, sites, onSaved }: {
  clientId: string; clientName: string; clientAddress: string; data: SeoOverview; sites: SiteChoice[]; onSaved: () => Promise<void>;
}) {
  const p = data.profile;
  const [name, setName] = useState(clientName);
  const [address, setAddress] = useState(clientAddress);
  const [found, setFound] = useState<PlaceCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [picked, setPicked] = useState<string | null>(p?.placeId ?? null);
  const [trade, setTrade] = useState(p?.trade ?? "");
  const [townText, setTownText] = useState((p?.towns ?? []).join(", "));
  const [gridKm, setGridKm] = useState(String(p?.gridKm ?? 3));
  const [siteId, setSiteId] = useState(p?.siteId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setPicked(p?.placeId ?? null); setTrade(p?.trade ?? ""); setTownText((p?.towns ?? []).join(", ")); setGridKm(String(p?.gridKm ?? 3)); setSiteId(p?.siteId ?? ""); }, [p?.placeId, p?.trade, p?.gridKm, p?.siteId, p?.towns.join("|")]);

  async function search() {
    if (searching) return;
    if (!name.trim()) { setSearchError("Type the business name first."); return; }
    setSearching(true); setSearchError("");
    try { setFound(await seoApi.placeSearch(clientId, name.trim(), address.trim())); }
    catch (e) { setSearchError(sentence(e, "Couldn’t search Google just now. Try again.")); setFound(null); }
    finally { setSearching(false); }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const list = towns(townText);
    const km = Number(gridKm);
    if (!picked) { setError("Search Google for the business and pick the right one first."); return; }
    if (list.length > MAX_TOWNS) { setError(`Use at most ${MAX_TOWNS} towns.`); return; }
    if (!Number.isFinite(km)) { setError("Give the grid spacing as a number of kilometres."); return; }
    setBusy(true); setError(""); setSaved(false);
    try { await seoApi.saveProfile(clientId, { placeId: picked, trade, towns: list, gridKm: km, ...(siteId ? { siteId } : {}) }); setSaved(true); await onSaved(); }
    catch (err) { setError(sentence(err, "Couldn’t save the profile. Try again.")); }
    finally { setBusy(false); }
  }
  const href = safeHref(p?.mapsUrl ?? null);
  return (
    <Part title="Google listing and search area" help="The name, address, phone and map location always come from Google, never from what is typed here.">
      {p && p.placeId && (
        <dl className="sx-facts">
          <dt>Listing</dt><dd>{p.napName}</dd>
          <dt>Address</dt><dd>{p.napAddress || <span className="muted">none on Google</span>}</dd>
          <dt>Phone</dt><dd>{p.napPhone || <span className="muted">none on Google</span>}</dd>
          <dt>Watch</dt><dd>{profileStatusLabel(p.status)}{p.lastWatchOn && <span className="muted small"> · last looked {dayLabel(p.lastWatchOn) ?? p.lastWatchOn}</span>}</dd>
          {href && <><dt>Map</dt><dd><a href={href} target="_blank" rel="noopener noreferrer">Open on Google Maps</a></dd></>}
        </dl>
      )}
      <details className="sx-more" open={!p?.placeId}>
        <summary>{p?.placeId ? "Change the listing or the search area" : "Set up the profile"}</summary>
        <form className="sx-form" onSubmit={(e) => void save(e)} noValidate aria-label="Google listing and search area">
          <div className="sx-find">
            <label className="deal-field" htmlFor={`sx-name-${clientId}`}><span>Business name on Google</span>
              <input id={`sx-name-${clientId}`} value={name} maxLength={200} autoComplete="off" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="deal-field" htmlFor={`sx-addr-${clientId}`}><span>Address (helps tell two with the same name apart)</span>
              <input id={`sx-addr-${clientId}`} value={address} maxLength={300} autoComplete="off" onChange={(e) => setAddress(e.target.value)} />
            </label>
            <button type="button" className="btn" aria-disabled={searching} onClick={() => void search()}>{searching ? "Searching…" : "Search Google"}</button>
          </div>
          <Say error={searchError} />
          {found !== null && found.length === 0 && <p className="small muted">Google found nothing for that. Try the name as it shows on Google, with the town.</p>}
          {found !== null && found.length > 0 && (
            <ul className="sx-cands" aria-label="Google's matches">
              {found.map((c) => <Candidate key={c.id} c={c} picked={picked === c.id} onPick={() => { setPicked(c.id); setSaved(false); }} />)}
            </ul>
          )}
          {picked && found === null && p?.placeId === picked && <p className="small muted">Tied to the listing above. Search again only to change it.</p>}
          <div className="sx-fields">
            <label className="deal-field" htmlFor={`sx-trade-${clientId}`}><span>Trade</span>
              <input id={`sx-trade-${clientId}`} value={trade} maxLength={60} placeholder="plumber" autoComplete="off" onChange={(e) => { setTrade(e.target.value); setSaved(false); }} />
            </label>
            <label className="deal-field" htmlFor={`sx-towns-${clientId}`}><span>Towns served (up to {MAX_TOWNS}, separated by commas)</span>
              <input id={`sx-towns-${clientId}`} value={townText} placeholder="Tigard, Beaverton" autoComplete="off" onChange={(e) => { setTownText(e.target.value); setSaved(false); }} />
            </label>
            <label className="deal-field" htmlFor={`sx-km-${clientId}`}><span>Grid spacing, in km (1 to 10)</span>
              <input id={`sx-km-${clientId}`} type="number" inputMode="decimal" min={1} max={10} step={0.5} value={gridKm} onChange={(e) => { setGridKm(e.target.value); setSaved(false); }} />
            </label>
            {sites.length > 0 && (
              <label className="deal-field" htmlFor={`sx-site-${clientId}`}><span>Site to check against the listing</span>
                <select id={`sx-site-${clientId}`} value={siteId} onChange={(e) => { setSiteId(e.target.value); setSaved(false); }}>
                  <option value="">Choose for me (the main site)</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="sx-actions">
            <button type="submit" className="btn primary" aria-disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
          </div>
          <Say error={error} ok={saved ? "Saved." : undefined} />
        </form>
      </details>
    </Part>
  );
}

/** The search terms to track: ten may be on at once; one switched off keeps its past checks. */
export function Keywords({ clientId, keywords, onChanged }: { clientId: string; keywords: SeoOverview["keywords"]; onChanged: Patch }) {
  const [term, setTerm] = useState("");
  const [town, setTown] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const left = keywordLimitLeft(keywords);
  const put = (k: SeoOverview["keywords"][number]) => onChanged({ keywords: keywords.some((x) => x.id === k.id) ? keywords.map((x) => (x.id === k.id ? k : x)) : [...keywords, k] });
  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy || !term.trim() || left === 0) return;
    setBusy("add"); setError("");
    try { put(await seoApi.addKeyword(clientId, term, town)); setTerm(""); setTown(""); }
    catch (err) { setError(sentence(err, "Couldn’t add the search term. Try again.")); }
    finally { setBusy(""); }
  }
  async function off(id: string) {
    if (busy) return;
    setBusy(id); setError("");
    try { put(await seoApi.switchOffKeyword(clientId, id)); }
    catch (err) { setError(sentence(err, "Couldn’t switch it off. Try again.")); }
    finally { setBusy(""); }
  }
  async function back(k: SeoOverview["keywords"][number]) {
    if (busy) return;
    setBusy(k.id); setError("");
    try { put(await seoApi.addKeyword(clientId, k.term, k.town)); }
    catch (err) { setError(sentence(err, "Couldn’t switch it back on. Try again.")); }
    finally { setBusy(""); }
  }
  return (
    <Part title="Search terms" help={`${left} of ${MAX_ACTIVE_KEYWORDS} places left. Each term that is on gets a grid at every rank check.`}>
      {keywords.length === 0 && <p className="small muted">No search terms yet. Add the ones a customer would type, like “drain cleaning” in a town.</p>}
      <ul className="sx-list">
        {keywords.map((k) => (
          <li key={k.id} className={k.active ? "" : "off"}>
            <span className="sx-list-name">{termName(k)}</span>
            {k.active
              ? <button type="button" className="btn-plain" aria-disabled={busy === k.id} onClick={() => void off(k.id)} aria-label={`Switch off ${termName(k)}`}>Switch off</button>
              : <><span className="badge2">Off</span><button type="button" className="btn-plain" aria-disabled={busy === k.id || left === 0} onClick={() => { if (left > 0) void back(k); }} aria-label={`Switch on ${termName(k)}`}>Switch on</button></>}
          </li>
        ))}
      </ul>
      <form className="sx-add" onSubmit={(e) => void add(e)} noValidate aria-label="Add a search term">
        <label className="deal-field" htmlFor={`sx-kw-${clientId}`}><span>Search term</span>
          <input id={`sx-kw-${clientId}`} value={term} maxLength={60} placeholder="drain cleaning" autoComplete="off" onChange={(e) => setTerm(e.target.value)} />
        </label>
        <label className="deal-field" htmlFor={`sx-kwt-${clientId}`}><span>Town (optional)</span>
          <input id={`sx-kwt-${clientId}`} value={town} maxLength={60} placeholder="Tigard" autoComplete="off" onChange={(e) => setTown(e.target.value)} />
        </label>
        <button type="submit" className="btn" aria-disabled={busy === "add" || !term.trim() || left === 0}>Add term</button>
      </form>
      {left === 0 && <p className="small muted">Ten terms are on. Switch one off before adding another.</p>}
      <Say error={error} />
    </Part>
  );
}
