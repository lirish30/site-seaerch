/** The line under the voice test: what the Mac is doing, what to do next, or that the pick is made. Pure, so it is tested without a page. */
export function voiceTestLine(t: { pending: number; chosen: string | null }): string {
  if (t.chosen) return "Picked. New videos will use this voice.";
  if (t.pending > 0) return `Waiting for your Mac: ${t.pending} of 3 clips left.`;
  return "Listen to A, B and C, then pick the one that sounds most like you.";
}

const ENGINE_NAMES: Record<string, string> = { "qwen3-tts": "Qwen3-TTS", chatterbox: "Chatterbox", "openvoice-v2": "OpenVoice v2" };
/** An engine's name for a person; one we do not know is shown as it is. */
export const engineName = (engine: string): string => ENGINE_NAMES[engine] ?? engine;

/** What to do when none of the clones sounds right: the owner narrates the lines themselves, in the video editor. */
export const RECORD_OWN_STEPS = [
  "Open a video from its lead page and choose to record the lines yourself.",
  "Press Record beside each line and read it aloud. Edit a line and you record that one again.",
  "Approve the video when every line has your recording.",
] as const;

/** The reference recording must run this long, in seconds. The same bounds the server enforces. */
export const REFERENCE_SECONDS = { min: 30, max: 120 } as const;

/** Why a recording of `ms` milliseconds cannot be the reference, or null when it can. */
export function referenceProblem(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return "Couldn't tell how long that recording is.";
  if (ms < REFERENCE_SECONDS.min * 1000) return `That recording is ${Math.round(ms / 1000)} seconds. It needs at least ${REFERENCE_SECONDS.min}.`;
  if (ms > REFERENCE_SECONDS.max * 1000) return `That recording is ${Math.round(ms / 1000)} seconds. It can be at most ${REFERENCE_SECONDS.max}.`;
  return null;
}
