import { MAX_MARKUPS, SCRIPT_MS, approvalBlockers, hashText, planDurationMs, wordCount, type Markup, type Segment, type VideoPlan } from "../worker/video/plan";

/** Pure helpers for the video editor and the lead's video panel. Every coordinate is a fraction 0-1 of the shot. */

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const clamp = (n: number, lo = 0, hi = 1) => round(Math.min(hi, Math.max(lo, n)));

/** The markup moved by (dx, dy), kept on the shot: a box or an arrow keeps its size and shape when it reaches an edge. */
export function moveMarkup(m: Markup, dx: number, dy: number): Markup {
  switch (m.type) {
    case "circle":
    case "callout":
      return { ...m, x: clamp(m.x + dx), y: clamp(m.y + dy) };
    case "blur":
      return { ...m, x: clamp(m.x + dx, 0, 1 - m.w), y: clamp(m.y + dy, 0, 1 - m.h) };
    case "arrow": {
      const xs = [m.from.x, m.to.x], ys = [m.from.y, m.to.y];
      const mx = Math.min(1 - Math.max(...xs), Math.max(-Math.min(...xs), dx));
      const my = Math.min(1 - Math.max(...ys), Math.max(-Math.min(...ys), dy));
      return { type: "arrow", from: { x: clamp(m.from.x + mx), y: clamp(m.from.y + my) }, to: { x: clamp(m.to.x + mx), y: clamp(m.to.y + my) } };
    }
  }
}

/** Drags a corner handle: a circle's radius grows by dx, a blur box's width and height by (dx, dy). Callouts and arrows have no size to change. */
export function resizeMarkup(m: Markup, dx: number, dy: number): Markup {
  if (m.type === "circle") return { ...m, r: clamp(m.r + dx, 0.01, 0.5) };
  if (m.type === "blur") return { ...m, w: clamp(m.w + dx, 0.02, 1 - m.x), h: clamp(m.h + dy, 0.02, 1 - m.y) };
  return m;
}

/** Drags one end of an arrow. */
export function moveArrowEnd(m: Markup, end: "from" | "to", dx: number, dy: number): Markup {
  if (m.type !== "arrow") return m;
  const p = m[end];
  return { ...m, [end]: { x: clamp(p.x + dx), y: clamp(p.y + dy) } };
}

const centred = (type: Markup["type"]): Markup => {
  switch (type) {
    case "circle": return { type, x: 0.5, y: 0.5, r: 0.08 };
    case "arrow": return { type, from: { x: 0.4, y: 0.5 }, to: { x: 0.6, y: 0.5 } };
    case "blur": return { type, x: 0.4, y: 0.45, w: 0.2, h: 0.1 };
    case "callout": return { type, x: 0.5, y: 0.5, text: "" };
  }
};

/** The segment with a new markup of that type at the centre of the shot (a callout starts with no text). A line at its most markups is returned as it was. */
export function addMarkup(seg: Segment, type: Markup["type"]): Segment {
  if (seg.markups.length >= MAX_MARKUPS) return seg;
  return { ...seg, markups: [...seg.markups, centred(type)] };
}

export function replaceMarkup(seg: Segment, index: number, m: Markup): Segment {
  if (index < 0 || index >= seg.markups.length) return seg;
  return { ...seg, markups: seg.markups.map((x, i) => (i === index ? m : x)) };
}

export function removeMarkup(seg: Segment, index: number): Segment {
  if (index < 0 || index >= seg.markups.length) return seg;
  return { ...seg, markups: seg.markups.filter((_, i) => i !== index) };
}

/** New words for a line. Its audio goes with the old words: it stays only while it still says what the line says. */
export function setSegmentText(seg: Segment, text: string): Segment {
  const { audio, ...rest } = seg;
  return audio && audio.textHash === hashText(text) ? { ...rest, text, audio } : { ...rest, text };
}

/** Puts a line over another screenshot. Its zoom region belongs to the old one, so it goes. */
export function setSegmentShot(seg: Segment, shotId: string): Segment {
  if (seg.shotId === shotId) return seg;
  const { focus: _focus, ...rest } = seg;
  return { ...rest, shotId };
}

/** How long the script is and whether it is inside the window a video may run (the same sum approval checks). */
export function scriptSummary(plan: VideoPlan): { words: number; seconds: number; inWindow: boolean } {
  const ms = planDurationMs(plan.segments);
  return {
    words: plan.segments.reduce((n, s) => n + wordCount(s.text), 0),
    seconds: Math.round(ms / 1000),
    inWindow: ms >= SCRIPT_MS.min && ms <= SCRIPT_MS.max,
  };
}

/** What stops this plan being approved, in words to show. Empty means it can go. */
export function approveBlockers(plan: VideoPlan, findingCodes: string[]): string[] {
  return approvalBlockers(plan, findingCodes);
}

export interface VideoState { status: string; jobs: { kind: string; status: string }[]; helperOnline: boolean; error?: string | null }

/** The one line that says where a video is. The editor and the lead page both show this, not the server's own wording. */
export function videoStateLine(v: VideoState): string {
  switch (v.status) {
    case "capturing": return "Taking screenshots of the site.";
    case "scripting": return "Waiting for Claude. The script will be written in your next queue session.";
    case "review": return "";
    case "producing": return v.helperOnline ? "Making the video." : "Waiting for your Mac. Voice and video are made when the helper is running.";
    case "rendered": return "Ready to approve. Watch it, then approve it in the inbox.";
    case "published": return "Live on the report page.";
    case "failed": return `Something went wrong: ${v.error || "unknown error"}`;
    case "cancelled": return "Cancelled.";
    default: return "";
  }
}

/** Statuses a video can be cancelled from: anything still open. */
export const canCancel = (status: string): boolean => !["published", "cancelled", "failed"].includes(status);
/** A video that has not been published, failed or been cancelled holds its audit's one slot; the lead page then opens it instead of starting another. */
export const isOpen = (status: string): boolean => canCancel(status);

/** What a line's voice is, for the list. Under a recorded narration, only a take of the current words counts. */
export function lineVoice(seg: Segment, narration: VideoPlan["narration"]): { label: string; needsWork: boolean } {
  const current = !!seg.audio && seg.audio.textHash === hashText(seg.text);
  if (seg.audio?.source === "recorded" && current) return { label: "Recorded", needsWork: false };
  if (narration === "recorded") return { label: seg.audio ? "Words changed: record it again" : "Not recorded yet", needsWork: true };
  return { label: current ? "Voice ready" : "Voice made when the video is", needsWork: false };
}

/** The seconds a take of the spoken line is expected to run: shown beside the recorder so a take can be checked against it. */
export const expectedSeconds = (text: string): number => Math.round(planDurationMs([{ text }]) / 1000);

/** What GET /api/video-audits/:id returns, as the editor uses it. */
export interface VideoResponse {
  video: { id: string; business_id: string; status: string; error: string | null; steering_note: string | null; updated_at: string };
  plan: VideoPlan | null;
  jobs: { kind: string; status: string }[];
  helperOnline: boolean;
  findingCodes: string[];
  business: { id: string; name: string } | null;
}

/** "Desktop 1", "Phone 2": how a shot is named in the pickers. */
export function shotLabel(shots: VideoPlan["shots"], shotId: string): string {
  const shot = shots.find((s) => s.id === shotId);
  if (!shot) return shotId;
  const n = shots.filter((s) => s.viewport === shot.viewport).findIndex((s) => s.id === shotId) + 1;
  return `${shot.viewport === "desktop" ? "Desktop" : "Phone"} ${n}`;
}

const ROLE_LABEL: Record<Segment["role"], string> = { hook: "Hook", problem: "Problem", offer: "Offer", cta: "Call to action" };
export const roleLabel = (r: Segment["role"]): string => ROLE_LABEL[r];

/** The plan with one line swapped for its edited copy. */
export const replaceSegment = (plan: VideoPlan, seg: Segment): VideoPlan => ({ ...plan, segments: plan.segments.map((s) => (s.id === seg.id ? seg : s)) });

/** A saved plan folded into what the editor holds now: the server's version number and audio, the editor's own text and markups (it may be ahead). */
export function mergeSaved(local: VideoPlan, saved: VideoPlan): VideoPlan {
  const audio = new Map(saved.segments.map((s) => [s.id, s.audio]));
  return {
    ...local, version: saved.version,
    segments: local.segments.map((s) => {
      const { audio: _drop, ...rest } = s;
      const a = audio.get(s.id);
      return a ? { ...rest, audio: a } : rest;
    }),
  };
}
