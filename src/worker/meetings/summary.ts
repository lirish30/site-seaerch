import { z } from "zod";
import type { Env } from "../env";
import type { Meeting } from "../db/meetings";

/**
 * The summary of one meeting, as the AI writes it and as it is stored. The limits keep the stored JSON and the follow-up email a sane size.
 * A possible change order is bounded exactly like the `change_order.draft` payload it becomes (hours in steps of 0.25, at most 40), so a summary that
 * passes here can always be drafted.
 */
export const MeetingSummarySchema = z.object({
  summary: z.string().max(1500),
  decisions: z.array(z.string().max(300)).max(10),
  actionItems: z.array(z.object({
    title: z.string().max(120), // the same limit a task title has (`parseTaskPatch`), so an item that passes here can always be made into a task
    owner: z.enum(["logan", "client"]),
    dueOn: z.string().nullable(),
  })).max(15),
  possibleChangeOrders: z.array(z.object({
    title: z.string().min(1).max(120),
    summary: z.string().max(1500),
    reason: z.string().max(600),
    hours: z.number().min(0.25).max(40).refine((h) => Number.isInteger(h * 4), "Hours go in steps of 0.25."),
  })).max(3),
  followUp: z.object({ subject: z.string().max(120), body: z.string().max(2500) }),
  generatedAt: z.string(),
});

export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

/**
 * What the sync stores in R2 at a meeting's `transcriptKey`: one line per thing said, in order. `speaker` and `atSec` are null when Meetily did not
 * say. The summary task reads it with `readTranscriptText`.
 */
export const TranscriptFileSchema = z.object({
  lines: z.array(z.object({ speaker: z.string().nullable(), atSec: z.number().nullable(), text: z.string() })),
});
export type TranscriptFile = z.infer<typeof TranscriptFileSchema>;

/**
 * The transcript as plain text, one line per utterance as `Speaker: text` (just the text when nobody is named). An empty string when the object is
 * missing or is not a transcript file: the summary then rests on Meetily's notes and the title.
 */
export async function readTranscriptText(env: Env, meeting: Pick<Meeting, "transcriptKey">): Promise<string> {
  const obj = await env.RAW.get(meeting.transcriptKey);
  if (!obj) return "";
  let json: unknown;
  try { json = await obj.json(); } catch { return ""; }
  const file = TranscriptFileSchema.safeParse(json);
  if (!file.success) return "";
  return file.data.lines
    .map((l) => { const text = l.text.replace(/\s+/g, " ").trim(); const who = l.speaker?.trim(); return who ? `${who}: ${text}` : text; })
    .filter(Boolean)
    .join("\n");
}

/** Most of a transcript a prompt carries, in characters; a longer one keeps its start and its end (what was agreed and who does what next is said last). */
export const TRANSCRIPT_MAX = 60_000;
const TRANSCRIPT_GAP = "\n[... the middle of the recording is left out ...]\n";
/** The transcript as it goes into a prompt: whole when it fits, otherwise its first and last parts around a marker, `TRANSCRIPT_MAX` characters in all. */
export const trimTranscript = (t: string): string => {
  if (t.length <= TRANSCRIPT_MAX) return t;
  const keep = TRANSCRIPT_MAX - TRANSCRIPT_GAP.length, head = Math.ceil(keep / 2);
  return t.slice(0, head) + TRANSCRIPT_GAP + t.slice(t.length - (keep - head));
};
