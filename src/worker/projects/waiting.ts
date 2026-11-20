import type { Project } from "../db/projects";
import { getOnboarding, listItems } from "../db/onboardings";
import { stageOf } from "../onboarding/schedule";

/**
 * Whether the project is waiting on the client: its linked onboarding has gone quiet for as long as the contract's silence clause says (`waiting_on_client`).
 * Derived each time from the onboarding, never stored, so a client write clears it. A project with no onboarding is never waiting.
 */
export async function projectWaiting(db: D1Database, p: Project, now: Date): Promise<boolean> {
  if (!p.onboardingId) return false;
  const o = await getOnboarding(db, p.onboardingId);
  if (!o) return false;
  return stageOf(o, await listItems(db, o.id), now) === "waiting_on_client";
}
