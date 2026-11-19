import { z } from "zod";
import type { Env } from "../env";
import { getAudit, latestAudit } from "../db/audits";
import { getBusiness } from "../db/businesses";
import { getSettings } from "../db/settings";
import { leadSuppression } from "../db/suppression";
import { getVideoAudit, moveVideoStatus, savePlan, setVideoStatus, type VideoAudit } from "../db/videoAudits";
import { TONES } from "../drafter/prompt";
import type { Audit, Business, Settings } from "../types";
import { DraftPlanSchema, GAP_MS, LINE_WORDS, MAX_CALLOUT_CHARS, MAX_MARKUPS, PROBLEM_COUNT, SCRIPT_MS, WORDS_PER_MINUTE, checkPlanAgainst, type Shot, type VideoPlan } from "../video/plan";
import { TaskRefused, registerTaskKind, type QueuePart, type TaskKindDef } from "./registry";
import { enqueueTask } from "./db";

/** The task kind this file handles: Claude writes the narration script and the first markups for a video audit. */
export const VIDEO_SCRIPT_KIND = "video.script";
export const VIDEO_SCRIPT_FAILED = "Claude didn't write the script. Try again.";
/** Said when a new script never came for a video that already has one: the owner keeps the script they had. */
export const VIDEO_SCRIPT_KEPT = "Claude didn't write a new script. Your current script is still here.";

export const VideoScriptPayload = z.object({ videoId: z.string().min(1), steeringNote: z.string().nullable().optional() });
export type VideoScriptPayload = z.infer<typeof VideoScriptPayload>;

/** Queues the script for a video. One open script task per video: a second request while one is open returns that task and changes nothing. */
export function requestVideoScript(db: D1Database, videoId: string, steeringNote: string | null): Promise<{ taskId: string; created: boolean }> {
  return enqueueTask(db, VIDEO_SCRIPT_KIND, { videoId, steeringNote }, { dedupeKey: videoId, targetType: "video", targetId: videoId })
    .then((r) => ({ taskId: r.id, created: r.created }));
}

/** Who speaks the lines: the cloned voice once the owner has picked an engine in the voice test, otherwise their own recordings. */
export function defaultNarration(settings: Pick<Settings, "voice_engine">): VideoPlan["narration"] {
  return settings.voice_engine ? "clone" : "recorded";
}

/** The words a script may have in all, so that it runs `SCRIPT_MS.min` to `SCRIPT_MS.max` with the pauses between its lines (and a little room either side). */
export function wordWindow(): { min: number; max: number } {
  const gaps = GAP_MS * (PROBLEM_COUNT + 2); // hook + problems + offer + cta is PROBLEM_COUNT + 3 lines, so PROBLEM_COUNT + 2 pauses
  const perMs = WORDS_PER_MINUTE / 60_000;
  return { min: Math.ceil((SCRIPT_MS.min - gaps) * perMs) + 5, max: Math.floor((SCRIPT_MS.max - gaps) * perMs) - 5 };
}

/** The fixed instructions: the app's rules and the sender's own voice settings and note. Nothing copied from a site goes in here. */
export function buildScriptInstructions(s: Settings, steeringNote: string | null | undefined): string {
  const name = s.your_name?.trim() || "the developer";
  const words = wordWindow();
  const tone = TONES[s.tone_preset ?? "friendly_local"] ?? TONES.friendly_local;
  return [
    `You write the narration for a short screen-recorded video audit of one local business's website. ${name}${s.business_name ? ` of ${s.business_name}` : ""} will send it to the business owner.`,
    `Speak as ${name} in the first person ("I"), to the owner, the way a person talks, not like a presenter. Short spoken sentences, no jargon.`,
    "",
    `About ${name}: ${s.bio?.trim() || s.services_blurb?.trim() || "a freelance web developer who builds and maintains websites for small local businesses."}`,
    s.services_blurb?.trim() && s.bio?.trim() ? `What they offer: ${s.services_blurb.trim()}` : "",
    `Tone: ${tone}`,
    s.tone_notes?.trim() ? `Their own voice notes: ${s.tone_notes.trim()}` : "",
    steeringNote?.trim() ? `Extra instruction for this script, from ${name}: ${steeringNote.trim()}` : "",
    "",
    "Structure, in this order:",
    "1. hook: one line that says who you are and the one thing you noticed on their site.",
    `2. problem: exactly ${PROBLEM_COUNT} lines. Each one is about ONE finding from the list, its code in findingCode (each finding at most once). State the problem together with its business result (a missed call, a lost booking, a visitor who leaves), in plain words. Choose the most costly findings that you can show on a screenshot.`,
    "3. offer: one line on what you would do to fix it.",
    "4. cta: one line that invites them to book a call.",
    "",
    `Length: the lines are spoken at about ${WORDS_PER_MINUTE} words a minute and the whole video must run ${SCRIPT_MS.min / 1000} to ${SCRIPT_MS.max / 1000} seconds. Write ${words.min} to ${words.max} words in all, ${LINE_WORDS.min} to ${LINE_WORDS.max} words a line. A script outside that window is sent back.`,
    "",
    "Rules:",
    "- State each problem with its business result. Promise no rankings, revenue or timelines, and never invent a number, a name or something the screenshots do not show.",
    "- Do not read out a URL, an email address or a phone number.",
    "- One call to action only: book a call. No second ask, no discount, no deadline.",
    "- Use only the findings and facts below. A problem line must cite a finding code from the list.",
    "",
    "Screenshots and markups:",
    `- Every line is shown over one screenshot: put its id from the list below in shotId. Spread the lines over the screenshots; show the evidence for a problem on a screenshot that has it.`,
    "- Every coordinate is a fraction from 0 to 1 of that screenshot's width and height, measured from its top left.",
    `- markups mark what the line is about: circle (x, y centre, r radius), arrow (from, to), blur (x, y, w, h: use it to hide a phone number, email address or other private detail), callout (x, y and a short text of at most ${MAX_CALLOUT_CHARS} characters on one line). At most ${MAX_MARKUPS} per line; give each problem line one or two.`,
    "- focus is optional: the region (x, y, w, h) to zoom into while the line plays.",
    '- id is a short unique name for each line: only letters, digits, "_" and "-", at most 40 characters, such as "s1", "s2".',
  ].filter((l, i, all) => l !== "" || all[i - 1] !== "").join("\n");
}

const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

/** The untrusted parts: the lead's facts, the audit's findings, and the screenshots with their ids. All of it comes from the site or its listing. */
function untrustedParts(business: Business, audit: Audit, shots: Shot[]): QueuePart[] {
  const facts = [
    "Business facts:",
    `Name: ${business.name}`,
    `Category: ${business.category ?? "unknown"}`,
    `Location: ${business.address ?? "unknown"}`,
    `Website: ${business.website_url ? withScheme(business.website_url.trim()) : "none"}`,
    business.rating != null ? `Google rating: ${business.rating} from ${business.review_count ?? 0} reviews` : "",
    audit.niche ? `Industry: ${audit.niche}` : "",
  ].filter(Boolean).join("\n");
  const findings = ["Findings from the audit (code, severity, evidence):", ...audit.findings.map((f) => `- ${f.code} | ${f.severity} | ${f.evidence}`)].join("\n");
  const parts: QueuePart[] = [{ type: "text", text: facts }, { type: "text", text: findings }];
  for (const s of shots) {
    parts.push({ type: "text", text: `Shot ${s.id}: ${s.viewport}, ${s.width}x${s.height} px, ${s.scrollY} px down the page` });
    parts.push({ type: "image", r2Key: s.previewKey, mimeType: "image/jpeg" });
  }
  return parts;
}

/**
 * The video and the lead's audit a script is about, or why the script no longer makes sense: the video moved on (it is no longer `scripting`), the lead
 * was deleted, was re-audited since (a newer audit exists), or was suppressed.
 */
async function loadTarget(db: D1Database, videoId: string): Promise<{ stale: string } | { video: VideoAudit; plan: VideoPlan; audit: Audit; business: Business }> {
  const video = await getVideoAudit(db, videoId);
  if (!video) return { stale: "the video no longer exists" };
  if (video.status !== "scripting") return { stale: "the video is no longer waiting for a script" };
  const business = await getBusiness(db, video.business_id);
  if (!business) return { stale: "the lead no longer exists" };
  if (await leadSuppression(db, business)) return { stale: "lead suppressed" };
  const audit = await getAudit(db, video.audit_id);
  if (!audit || audit.business_id !== business.id) return { stale: "the audit no longer exists" };
  if ((await latestAudit(db, business.id))?.id !== audit.id) return { stale: "the lead has a newer audit" };
  if (!video.plan?.shots.length) return { stale: "the video has no screenshots" };
  return { video, plan: video.plan, audit, business };
}

/**
 * Nobody wrote the script. A video that already has one (it came from "regenerate script", and the owner may have edited the plan) goes back to
 * review with that plan and a note saying so; a video that never had a script can never get one, so it fails and the user can start another.
 * Either way only while it is still `scripting`: a video that has moved on is left alone.
 */
async function failIfScripting(db: D1Database, videoId: string): Promise<void> {
  const v = await getVideoAudit(db, videoId);
  if (v?.status !== "scripting") return;
  if (v.plan?.segments.length) await moveVideoStatus(db, videoId, ["scripting"], "review", { error: VIDEO_SCRIPT_KEPT });
  else await moveVideoStatus(db, videoId, ["scripting"], "failed", { error: VIDEO_SCRIPT_FAILED });
}

const videoScript: TaskKindDef<VideoScriptPayload, z.infer<typeof DraftPlanSchema>> = {
  kind: VIDEO_SCRIPT_KIND,
  label: "Write a video script",
  suggestedModel: "sonnet",
  payload: VideoScriptPayload,
  result: DraftPlanSchema,

  /** The findings, business facts and screenshots are copied from the site and its listing, so they are the untrusted parts; the rules and what the sender typed are the instructions. */
  async build(env: Env, p) {
    const t = await loadTarget(env.DB, p.videoId);
    if ("stale" in t) return { stale: t.stale };
    const settings = await getSettings(env.DB);
    return { instructions: buildScriptInstructions(settings, p.steeringNote ?? t.video.steering_note), untrusted: untrustedParts(t.business, t.audit, t.plan.shots) };
  },

  /**
   * Checks the script against the audit (every cited finding exists, every shot exists, the length is in the window) and sends it back with the reasons
   * when it is not, then stores it and moves the video to review. A video that moved on, a newer audit or a suppressed lead make it stale: nothing is stored.
   * A crash-retry stores the same plan again.
   */
  async apply(env, p, r) {
    const t = await loadTarget(env.DB, p.videoId);
    if ("stale" in t) return { stale: t.stale };
    const problems = checkPlanAgainst({ shots: t.plan.shots, segments: r.segments }, t.audit.findings.map((f) => f.code));
    if (problems.length) throw new TaskRefused(problems.join("; "));
    const settings = await getSettings(env.DB);
    await savePlan(env.DB, t.video.id, { shots: t.plan.shots, segments: r.segments, narration: defaultNarration(settings), version: t.plan.version });
    await setVideoStatus(env.DB, t.video.id, "review", { error: null });
    return { log: { summary: `wrote the video script for ${t.business.name.slice(0, 100)}`, recordType: "lead", recordId: t.business.id } };
  },

  async onExpire(env, p) { await failIfScripting(env.DB, p.videoId); },
  async onFail(env, p) { await failIfScripting(env.DB, p.videoId); },
};
registerTaskKind(videoScript);
