import { Link } from "react-router-dom";
import { Card, Meter } from "../ds";
import { freedomView } from "../../todayHome";
import type { Freedom, Part } from "./useHome";

/** Freedom number (Figma 57:4189): recurring revenue against the monthly goal from Settings, how far along, and the plans that make it up. */
export default function FreedomCard({ freedom, onRetry }: { freedom: Part<Freedom>; onRetry: () => void }) {
  const f = freedom.data, v = f ? freedomView(f, f.subs, f.names) : null;
  return (
    <Card icon="trending" title="Freedom number" id="freedom" className="hox-card"
      note={v && f!.targetCents > 0 ? <Link to="/money" className="hox-note-link" title="Change the goal">Goal {v.goal}</Link> : undefined}>
      {!f && freedom.error ? (
        <div className="hox-alert inline" role="alert"><span>{freedom.error}</span><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : !v ? (
        <i className="hox-skel" style={{ width: "60%", height: 36 }} />
      ) : (
        <>
          <p className="hox-big">{v.mrr}<small>of {v.goal} / mo</small></p>
          <Meter value={v.pct} max={100} tone="signal" label={`Recurring revenue: ${Math.round(v.pct)}% of the goal`} />
          <p className="hox-caption">{v.line}</p>
          {v.rows.length > 0 ? (
            <ul className="hox-lines" aria-label="Recurring revenue by plan">
              {v.rows.map((r) => <li key={r.key}><span>{r.label}</span><b>{r.value}</b></li>)}
            </ul>
          ) : (
            <p className="hox-caption">No client is billed monthly yet. Care plans and subscriptions add up here.</p>
          )}
        </>
      )}
    </Card>
  );
}
