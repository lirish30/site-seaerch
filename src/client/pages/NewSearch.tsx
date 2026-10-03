import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Search } from "../types";

// Suggestions only: the field accepts any text and it goes straight into the Maps query.
const TYPES = [
  // Home & trade services
  "plumber", "electrician", "roofer", "HVAC", "landscaper", "general contractor", "remodeling contractor", "painter",
  "flooring contractor", "window installer", "garage door", "fence contractor", "concrete contractor", "pest control",
  "pool service", "tree service", "cleaning service", "moving company", "solar installer", "home inspector",
  // Auto
  "auto repair", "auto body shop", "car dealership", "tire shop", "towing service", "RV dealer",
  // Health & wellness
  "dentist", "orthodontist", "chiropractor", "physical therapist", "optometrist", "veterinarian", "dermatologist",
  "med spa", "mental health counselor", "pediatrician", "urgent care", "pharmacy", "senior care", "home health care",
  // Education
  "private school", "charter school", "preschool", "daycare", "montessori school", "community college", "university",
  "trade school", "tutoring center", "test prep", "music school", "dance studio", "driving school", "language school",
  "coding bootcamp", "online school", "homeschool co-op", "school district", "college admissions consultant",
  // Corporate & professional services
  "law firm", "accounting firm", "CPA", "tax preparer", "financial advisor", "wealth management", "insurance agency",
  "mortgage broker", "bank", "credit union", "staffing agency", "recruiting firm", "executive search", "HR consulting",
  "management consulting", "IT services", "managed service provider", "cybersecurity firm", "software company",
  "marketing agency", "advertising agency", "PR firm", "architecture firm", "engineering firm", "commercial real estate",
  "property management", "commercial construction", "corporate training", "coworking space", "business coaching",
  "translation service", "market research firm", "payroll service", "corporate headquarters",
  // Industrial & B2B
  "manufacturer", "machine shop", "wholesale distributor", "logistics company", "freight broker", "trucking company",
  "warehouse", "commercial printer", "sign company", "packaging supplier", "industrial supply", "equipment rental",
  "janitorial service", "security company",
  // Real estate & finance
  "real estate agent", "real estate broker", "title company", "appraiser",
  // Food & hospitality
  "restaurant", "cafe", "bakery", "caterer", "brewery", "bar", "hotel", "bed and breakfast", "event venue", "wedding planner",
  // Beauty & personal
  "salon", "barber shop", "spa", "nail salon", "tattoo shop", "gym", "yoga studio", "martial arts studio", "personal trainer",
  // Retail
  "boutique", "furniture store", "jewelry store", "florist", "pet store", "bike shop", "hardware store", "bookstore",
  // Community & other
  "church", "nonprofit", "funeral home", "photographer", "videographer", "print shop", "art gallery", "theater",
  "daycare center", "storage facility", "self storage", "pet groomer", "dog trainer",
];

export default function NewSearch() {
  const nav = useNavigate();
  const [location, setLocation] = useState(""); const [type, setType] = useState("");
  const [maxResults, setMax] = useState(50);
  const [est, setEst] = useState<{ estUsd: number; spent: number; limit: number; ok: boolean } | null>(null);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<Search[]>([]);
  const [recentErr, setRecentErr] = useState(""); const [estErr, setEstErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.get<Search[]>("/searches")
      .then((r) => { if (!cancelled) setRecent(r); })
      .catch(() => { if (!cancelled) setRecentErr("Couldn't load recent searches."); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    api.get<typeof est>(`/searches/estimate?maxResults=${maxResults}`)
      .then((r) => { if (!cancelled) { setEst(r); setEstErr(""); } })
      .catch(() => { if (!cancelled) { setEst(null); setEstErr("Couldn't load the cost estimate."); } });
    return () => { cancelled = true; };
  }, [maxResults]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    try { const s = await api.post<Search>("/searches", { location, businessType: type, maxResults }); nav(`/searches/${s.id}`); }
    catch (x) { setErr(x instanceof ApiError ? (x.status === 402 ? "This search would go over your monthly spend limit." : x.message) : "Failed"); setBusy(false); }
  }

  return (
    <div className="grid2">
      <form className="card" onSubmit={submit}>
        <h2>New search</h2>
        <label htmlFor="loc">Location</label>
        <input id="loc" placeholder="Boise, ID" value={location} onChange={(e) => setLocation(e.target.value)} required />
        <label htmlFor="type">Business type</label>
        <input id="type" list="types" placeholder="plumber" value={type} onChange={(e) => setType(e.target.value)} required />
        <datalist id="types">{TYPES.map((t) => <option key={t} value={t} />)}</datalist>
        <label htmlFor="m">Max results</label>
        <input id="m" type="number" min={1} max={200} value={maxResults} onChange={(e) => setMax(Number(e.target.value))} />
        {est && <p className="muted">Estimated cost: up to ${est.estUsd.toFixed(2)} · spent this month ${est.spent.toFixed(2)} of ${est.limit.toFixed(2)}</p>}
        {estErr && <p className="error">{estErr}</p>}
        {err && <p className="error">{err}</p>}
        <button className="primary" disabled={busy || (est !== null && !est.ok)}>{busy ? "Starting…" : "Find businesses"}</button>
      </form>
      <div className="card">
        <h2>Recent searches</h2>
        {recentErr && <p className="error">{recentErr}</p>}
        <table><tbody>
          {recent.map((s) => (
            <tr key={s.id}>
              <td><Link to={`/searches/${s.id}`}>{s.business_type} in {s.location}</Link></td>
              <td className="muted">{s.processed_count}/{s.found_count}</td>
              <td><span className="badge">{s.status}</span></td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}
