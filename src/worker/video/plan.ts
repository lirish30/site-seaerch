import { z } from "zod";
import type { Settings } from "../types";

/**
 * The video plan: which screenshots (shots) the video uses and the narrated lines (segments) that play over them.
 * Every coordinate is a fraction 0-1 of the shot's full-size image, so a plan survives any render size.
 */

const frac = z.number().min(0).max(1);
const point = z.object({ x: frac, y: frac });

export const ShotSchema = z.object({
  id: z.string().min(1),
  viewport: z.enum(["desktop", "mobile"]),
  scrollY: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
  fullKey: z.string().min(1),
  previewKey: z.string().min(1),
});
export type Shot = z.infer<typeof ShotSchema>;

export const MAX_CALLOUT_CHARS = 60;

export const MarkupSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("circle"), x: frac, y: frac, r: frac }),
  z.object({ type: z.literal("arrow"), from: point, to: point }),
  z.object({ type: z.literal("blur"), x: frac, y: frac, w: frac, h: frac }),
  z.object({ type: z.literal("callout"), x: frac, y: frac, text: z.string().max(MAX_CALLOUT_CHARS).regex(/^[^\r\n]*$/, "one line") }),
]);
export type Markup = z.infer<typeof MarkupSchema>;

export const ROLES = ["hook", "problem", "offer", "cta"] as const;
export type Role = (typeof ROLES)[number];

export const AudioSchema = z.object({
  key: z.string().min(1),
  source: z.enum(["clone", "recorded"]),
  durationMs: z.number().nonnegative(),
  textHash: z.string().min(1),
});
export type SegmentAudio = z.infer<typeof AudioSchema>;

/** A line's id ends up in storage keys and URLs, so it is short and plain: letters, digits, underscore, hyphen. */
export const SEGMENT_ID = /^[A-Za-z0-9_-]{1,40}$/;

export const SegmentSchema = z.object({
  id: z.string().regex(SEGMENT_ID, "a line id is 1 to 40 letters, digits, _ or -"),
  role: z.enum(ROLES),
  findingCode: z.string().min(1).optional(),
  text: z.string(),
  shotId: z.string().min(1),
  focus: z.object({ x: frac, y: frac, w: frac, h: frac }).optional(),
  markups: z.array(MarkupSchema),
  audio: AudioSchema.optional(),
});
export type Segment = z.infer<typeof SegmentSchema>;

/** `aiVoiceNote` is not stored: it is derived (settings.ai_voice_note is on and some line has audio.source "clone"). */
export const VideoPlanSchema = z.object({
  shots: z.array(ShotSchema),
  segments: z.array(SegmentSchema),
  narration: z.enum(["clone", "recorded"]),
  version: z.number().int().nonnegative(),
});
export type VideoPlan = z.infer<typeof VideoPlanSchema>;

/** Whether the page says the voice is AI: the owner has the note on and at least one line is spoken by the cloned voice. */
export const aiVoiceNote = (settings: Pick<Settings, "ai_voice_note">, plan: Pick<VideoPlan, "segments"> | null): boolean =>
  settings.ai_voice_note === 1 && !!plan?.segments.some((s) => s.audio?.source === "clone");

export const SCRIPT_MS = { min: 80_000, max: 130_000 } as const;
export const WORDS_PER_MINUTE = 150;
export const GAP_MS = 350;
export const LINE_WORDS = { min: 5, max: 60 } as const;
export const MAX_MARKUPS = 6;
export const PROBLEM_COUNT = 3;

export const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/** What Claude returns: the segments only (the shots come from the capture, the audio from the voice step). */
export const DraftPlanSchema = z.object({ segments: z.array(SegmentSchema.omit({ audio: true })) }).superRefine((d, ctx) => {
  const issue = (message: string, path: (string | number)[] = ["segments"]) => ctx.addIssue({ code: "custom", message, path });
  const segs = d.segments;
  if (segs[0]?.role !== "hook") issue("the first segment must be the hook");
  if (segs.length > 0 && segs[segs.length - 1].role !== "cta") issue("the last segment must be the cta");
  if (segs.filter((s) => s.role === "hook").length !== 1) issue("there must be exactly one hook");
  if (segs.filter((s) => s.role === "cta").length !== 1) issue("there must be exactly one cta");
  if (segs.filter((s) => s.role === "offer").length !== 1) issue("there must be exactly one offer");
  const problems = segs.filter((s) => s.role === "problem");
  if (problems.length !== PROBLEM_COUNT) issue(`there must be exactly ${PROBLEM_COUNT} problem segments, got ${problems.length}`);
  const codes = problems.map((s) => s.findingCode);
  if (codes.some((c) => !c)) issue("every problem segment needs a findingCode");
  else if (new Set(codes).size !== codes.length) issue("problem segments must use distinct findingCodes");
  segs.forEach((s, i) => {
    const n = wordCount(s.text);
    if (n < LINE_WORDS.min || n > LINE_WORDS.max) issue(`line ${i + 1} has ${n} words; each line needs ${LINE_WORDS.min}-${LINE_WORDS.max}`, ["segments", i, "text"]);
    if (s.markups.length > MAX_MARKUPS) issue(`segment ${i + 1} has ${s.markups.length} markups; the most is ${MAX_MARKUPS}`, ["segments", i, "markups"]);
  });
});
export type DraftPlan = z.infer<typeof DraftPlanSchema>;

/** Spoken length of one line at 150 words a minute. */
export const estimateDurationMs = (text: string): number => Math.round((wordCount(text) / WORDS_PER_MINUTE) * 60_000);

/** The lines back to back with a 350 ms gap between each pair. */
export function planDurationMs(segments: Pick<Segment, "text">[]): number {
  if (segments.length === 0) return 0;
  return segments.reduce((sum, s) => sum + estimateDurationMs(s.text), 0) + GAP_MS * (segments.length - 1);
}

/** Problems with what the plan points at: a line over a screenshot or about a finding that is not there. Fine to save with; not fine to approve. */
export function checkPlanRefs(plan: Pick<VideoPlan, "shots" | "segments">, findingCodes: string[]): string[] {
  const problems: string[] = [];
  const shotIds = new Set(plan.shots.map((s) => s.id));
  const codes = new Set(findingCodes);
  plan.segments.forEach((s, i) => {
    if (!shotIds.has(s.shotId)) problems.push(`Line ${i + 1} uses a screenshot (${s.shotId}) that is not in this video.`);
    if (s.findingCode !== undefined && !codes.has(s.findingCode)) problems.push(`Line ${i + 1} points at a finding (${s.findingCode}) this audit does not have.`);
  });
  return problems;
}

/** Problems a person can read and act on; an empty list means the plan is fine. */
export function checkPlanAgainst(plan: Pick<VideoPlan, "shots" | "segments">, findingCodes: string[]): string[] {
  const problems = checkPlanRefs(plan, findingCodes);
  const ms = planDurationMs(plan.segments);
  if (ms < SCRIPT_MS.min || ms > SCRIPT_MS.max) {
    problems.push(`The script runs about ${Math.round(ms / 1000)} seconds; it should be ${SCRIPT_MS.min / 1000} to ${SCRIPT_MS.max / 1000} seconds.`);
  }
  return problems;
}

/** FNV-1a, 32 bit, as 8 hex digits: stable across runtimes, so a stored hash still matches after a deploy. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A line needs (new) audio when it has none or its text changed since the audio was made. */
export const lineStale = (seg: Segment): boolean => !seg.audio || seg.audio.textHash !== hashText(seg.text);

/**
 * Everything standing between a plan and its approval, in words the editor can show: lines with no words, callouts with no text (a draft is
 * allowed while editing), lines that must be recorded and have no current recording, then what `checkPlanAgainst` finds. Empty means go.
 */
export function approvalBlockers(plan: VideoPlan, findingCodes: string[]): string[] {
  const blockers: string[] = [];
  plan.segments.forEach((s, i) => {
    const n = i + 1;
    if (wordCount(s.text) === 0) blockers.push(`Line ${n} has no words.`);
    if (s.markups.some((m) => m.type === "callout" && m.text.trim() === "")) blockers.push(`Line ${n} has a callout with no text. Type its words or delete it.`);
    if (plan.narration === "recorded" && (lineStale(s) || s.audio?.source !== "recorded")) blockers.push(`Line ${n} needs a recording.`);
  });
  return [...blockers, ...checkPlanAgainst(plan, findingCodes)];
}
