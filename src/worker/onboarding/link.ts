import { guestLinkBase } from "../booking/mail";

/** The client's link to their onboarding page: the client base, `/o/` and the token. Null when the base is not an https address (never workers.dev). */
export function onboardingLink(base: string | undefined, token: string): string | null {
  const b = guestLinkBase(base);
  return b ? `${b}/o/${token}` : null;
}
