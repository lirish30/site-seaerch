import type { Env } from "../env";
import { moveVideoStatus } from "../db/videoAudits";

/**
 * Starts making the video from an approved plan: voice for the lines that need it, then the render. For now this only moves the video to
 * `producing`; the helper jobs that do the work are queued here once they exist.
 * Returns whether this call started it: a video that is not in review (already started, cancelled, moved on) is left alone, so a double approve starts it once.
 */
export async function startProduction(env: Env, videoId: string): Promise<boolean> {
  return moveVideoStatus(env.DB, videoId, ["review"], "producing", { error: null });
}
