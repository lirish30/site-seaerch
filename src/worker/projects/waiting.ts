import { listItems } from "../db/onboardings";
import type { Project } from "../db/projects";
import { stageOf } from "../onboarding/schedule";
import { onboardingFor } from "./onboarding";

/**
 * Whether the project is waiting on the client: its onboarding has gone quiet for as long as the contract's silence clause says (`waiting_on_client`).
 * Derived each time from the onboarding, never stored, so a client write clears it. A project with no onboarding is never waiting, and neither is a finished Care onboarding project:
 * its onboarding is over, and its recurring Care work does not depend on what the client still owes the build.
 */
export async function projectWaiting(db: D1Database, p: Project, now: Date): Promise<boolean> {
  if (p.kind === "care_onboarding" && p.status === "done") return false;
  const o = await onboardingFor(db, p);
  if (!o) return false;
  return stageOf(o, await listItems(db, o.id), now) === "waiting_on_client";
}
