import { getOnboarding, getOnboardingForDeal, type Onboarding } from "../db/onboardings";
import type { Project } from "../db/projects";

/**
 * The onboarding a project reads from: the one linked when the project was made, else the deal's own, looked up now. A project can be made before its onboarding exists (the
 * deposit is paid while `CLIENT_LINK_BASE` is unset, and Logan starts the onboarding later), so the link cannot be trusted to be filled in. A rehearsal and a real project never mix: a test
 * project reads only a test onboarding and a real one only a real one. Null when there is none (a hand-made project has no deal).
 */
export async function onboardingFor(db: D1Database, p: Pick<Project, "onboardingId" | "dealId" | "test">): Promise<Onboarding | null> {
  if (p.onboardingId) return getOnboarding(db, p.onboardingId);
  if (!p.dealId) return null;
  const o = await getOnboardingForDeal(db, p.dealId);
  return o && o.test === p.test ? o : null;
}
