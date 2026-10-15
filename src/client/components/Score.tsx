import type { ReactNode } from "react";
import { healthWord, leadTier, SEVERITY_BARS, SEVERITY_LABEL, TIER_LABEL, type LeadTier } from "../scoreView";
import type { Severity } from "../types";

/**
 * The lead score pill: the only score with color. Hot 60+, Warm 25-59, Cool under 25.
 * `legend` shows a threshold ("60+") in the chip instead of a score, for the table legend.
 */
export function LeadScore({ score, legend, label, tier: forced }: { score: number | null; legend?: string; label?: string; tier?: LeadTier }) {
  if (score === null && !legend) return <span className="lead-score pending" title="Still being scored">…</span>;
  const tier = forced ?? leadTier(score ?? 0);
  const word = label ?? TIER_LABEL[tier];
  return (
    <span className={`lead-score ${tier}`} title={legend ? undefined : `Lead score ${score} of 100: ${word}`} aria-label={legend ? undefined : `Lead score ${score}, ${word}`}>
      <span className="chip">{legend ?? score}</span>
      <span className="word">{word}</span>
    </span>
  );
}

/** Neutral site health: a small ink bar, the number and a Poor/Fair/Good word. `noSite` shows "— No site" for a business with no website. */
export function SiteHealth({ health, noSite = false, partial = false }: { health: number | null; noSite?: boolean; partial?: boolean }) {
  if (noSite) return <span className="site-health none"><span className="num">—</span><span className="word">No site</span></span>;
  if (health === null) return <span className="site-health none" title="Not measured yet"><span className="num">—</span></span>;
  const word = healthWord(health);
  return (
    <span className="site-health" title={`Site health ${health} of 100: ${word}`} aria-label={`Site health ${health}, ${word}`}>
      <HealthBar value={health} />
      <span className="num">{health}</span>
      <span className="word">{word}</span>
      {partial && <span className="dot-partial" title="Google's speed test didn't run">•</span>}
    </span>
  );
}

/** A thin neutral bar from 0 to 100, used for site health and each category score. */
export function HealthBar({ value, wide = false }: { value: number; wide?: boolean }) {
  return <span className={`health-bar${wide ? " wide" : ""}`} aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>;
}

/** Severity as a 3-bar signal plus the word. Only Critical is red, Important is amber, Nice to have is grey. */
export function Severity({ severity, bars = true }: { severity: Severity; bars?: boolean }) {
  const lit = SEVERITY_BARS[severity];
  return (
    <span className={`severity sev-${severity}`}>
      {bars && (
        <span className="bars" aria-hidden="true">
          <i className={lit >= 1 ? "on" : ""} /><i className={lit >= 2 ? "on" : ""} /><i className={lit >= 3 ? "on" : ""} />
        </span>
      )}
      <span className="word">{SEVERITY_LABEL[severity]}</span>
    </span>
  );
}

/** A small status chip. `dot` adds the leading dot. */
export function Badge({ tone = "neutral", dot = false, children, title }: { tone?: "neutral" | "outline" | "info" | "positive" | "warning" | "critical" | "signal"; dot?: boolean; children: ReactNode; title?: string }) {
  return <span className={`badge2 ${tone}`} title={title}>{dot && <i className="dot" />}{children}</span>;
}
