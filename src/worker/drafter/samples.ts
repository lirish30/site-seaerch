import type { Finding, WorkSample } from "../types";

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

export interface SampleContext { category: string | null; niche: string | null; findings: Finding[] }

/**
 * The work samples worth citing to this company: the ones whose tags or title overlap with its category,
 * industry and findings. Picked ids win over matching; excluded ids (already used in the current draft) are skipped.
 * With no overlap at all, the earliest-added samples stand in, so a profile with samples always cites something real.
 */
export function matchSamples(samples: WorkSample[], ctx: SampleContext, opts: { max?: number; pickIds?: string[]; excludeIds?: string[] } = {}): WorkSample[] {
  const max = opts.max ?? 2;
  const pool = samples.filter((s) => !opts.excludeIds?.includes(s.id));
  if (opts.pickIds?.length) return opts.pickIds.map((id) => pool.find((s) => s.id === id)).filter((s): s is WorkSample => !!s).slice(0, max);
  const topic = new Set(words([ctx.category, ctx.niche, ...ctx.findings.flatMap((f) => [f.category, f.evidence])].filter(Boolean).join(" ")));
  const score = (s: WorkSample) => words(`${s.tags} ${s.title}`).filter((w) => topic.has(w)).length;
  return pool.map((s, i) => ({ s, i, n: score(s) })).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, max).map((x) => x.s);
}
