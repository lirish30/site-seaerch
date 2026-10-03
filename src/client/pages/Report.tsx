import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { groupFindings, isHttpsLogo, isReportToken, summaryText, type ReportData } from "../reportView";

// Public page: deliberately bypasses api.ts, whose 401 handling redirects to /login.
export default function Report() {
  const token = useParams()["*"]; // wildcard route, so truncated or extended links land here instead of the app shell
  const [r, setR] = useState<ReportData | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Website check";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    if (!meta) { meta = document.createElement("meta"); meta.name = "robots"; document.head.appendChild(meta); }
    const prevContent = meta.content;
    meta.content = "noindex, nofollow";
    return () => { document.title = prevTitle; if (created) meta.remove(); else meta.content = prevContent; };
  }, []);

  useEffect(() => {
    if (!isReportToken(token)) { setState("gone"); return; }
    let cancelled = false;
    setState("loading");
    fetch(`/api/public/report/${token}`, { credentials: "omit" })
      .then(async (res) => {
        if (res.status === 404) { if (!cancelled) setState("gone"); return; }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ReportData;
        if (!cancelled) { setR(data); setState("ok"); document.title = `Website check for ${data.businessName}`; }
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [token, attempt]);

  if (state === "loading") return <div className="report"><p className="muted">Loading…</p></div>;
  if (state === "error") return <div className="report"><p role="alert">Couldn't load this report. Please try again.</p><button onClick={() => setAttempt((n) => n + 1)}>Retry</button></div>;
  if (state === "gone" || !r) return <div className="report"><p>This report link has expired or is no longer available.</p></div>;

  const groups = groupFindings(r.findings);
  const { sender } = r;
  const date = new Date(r.auditedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return (
    <div className="report">
      <div className="card">
        <h1>Quick website check for {r.businessName}</h1>
        <p className="muted">Based on an automated check on {date}</p>
        {groups.length ? <>
          <h2>{summaryText(r.counts)}</h2>
          <p className="row">
            {r.counts.high > 0 && <span className="badge sev-high">{r.counts.high} high</span>}
            {r.counts.medium > 0 && <span className="badge sev-medium">{r.counts.medium} medium</span>}
            {r.counts.low > 0 && <span className="badge sev-low">{r.counts.low} low</span>}
          </p>
          {groups.map((g) => (
            <section key={g.severity} className={`sev-group sev-${g.severity}`}>
              <h3>{g.label}</h3>
              <ul>{g.items.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </section>
          ))}
        </> : <p>We didn't spot any major issues.</p>}
        {r.partial && <p className="muted">Some speed checks couldn't be completed.</p>}
        <p className="muted">This is an automated check of publicly visible information and may not capture everything.</p>
        {(sender.name || sender.businessName || sender.email || isHttpsLogo(sender.logoUrl)) && (
          <div className="report-sender">
            {isHttpsLogo(sender.logoUrl) && <img src={sender.logoUrl} alt="" referrerPolicy="no-referrer" />}
            <div>
              {sender.name && <strong>{sender.name}</strong>}
              {sender.businessName && <div>{sender.businessName}</div>}
              {sender.email && <div><a href={`mailto:${sender.email}`}>{sender.email}</a></div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
