/** Half-circle Site Health gauge. Color bands: <40 poor, <70 fair, else good. */
export function healthBand(score: number | null): "poor" | "fair" | "good" | "none" {
  if (score === null) return "none";
  return score < 40 ? "poor" : score < 70 ? "fair" : "good";
}

export default function HealthGauge({ score, size = 180, label = "Site Health" }: { score: number | null; size?: number; label?: string }) {
  const r = 80, cx = 100, cy = 95, len = Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const band = healthBand(score);
  return (
    <figure className={`gauge band-${band}`} style={{ width: size }} aria-label={`${label}: ${score ?? "not measured"} out of 100`}>
      <svg viewBox="0 0 200 110" role="img" aria-hidden="true">
        <path d={arc} className="gauge-track" />
        {score !== null && <path d={arc} className="gauge-fill" strokeDasharray={`${len * pct} ${len}`} />}
        <text x={cx} y={cy - 12} textAnchor="middle" className="gauge-value">{score ?? "—"}</text>
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/** Tiny inline gauge for table rows. */
export function MiniGauge({ score }: { score: number | null }) {
  const r = 14, cx = 18, cy = 17, len = Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  return (
    <span className={`mini-gauge band-${healthBand(score)}`} title={score === null ? "Not measured" : `Site Health ${score}/100`}>
      <svg viewBox="0 0 36 20" aria-hidden="true">
        <path d={arc} className="gauge-track" />
        {score !== null && <path d={arc} className="gauge-fill" strokeDasharray={`${len * pct} ${len}`} />}
      </svg>
      <span>{score ?? "—"}</span>
    </span>
  );
}
