import { dollars } from "./packagesView";
import type { PublicSubscription } from "../worker/billing/checkout";

/** Pure copy and state helpers for the client's subscription page (`/s/<token>`). Plain values in, plain text out: no DOM, no fetch, no clock (the page passes today's date in). */

export type { PublicSubscription };
export interface SubscribeCopy { heading: string; lines: string[]; button: string | null; note: string }

/** "December 9, 2026" from a `YYYY-MM-DD` calendar date, or the text as it came when it does not read as one. */
export function chargeDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** The term in plain words: "For 12 months", "For 1 month", or "Month to month" when there is none. */
export function termWords(months: number | null): string {
  if (months === null) return "Month to month";
  return `For ${months} ${months === 1 ? "month" : "months"}`;
}

/**
 * What the page says for the state the server reports. Whether the card is charged today is the server's call (`chargedNow`, the same rule the Checkout request follows), never the
 * viewer's clock. Nothing here comes from anywhere but the public fields: no ids, no token, no link. A closed link shows no plan details at all.
 */
export function subscribeCopy(p: PublicSubscription): SubscribeCopy {
  if (p.state === "closed") {
    return { heading: "This link is no longer open", lines: [], button: null, note: "If you think that is a mistake, reply to the email you got and we'll sort it out." };
  }
  const plan = [p.planName, `${dollars(p.monthlyCents)} a month`];
  if (p.state === "active") {
    return { heading: "You're all set", lines: [...plan, "Your monthly payment is set up. There is nothing more to do."], button: null, note: "Your payment method will be charged each month until you cancel." };
  }
  const later = !p.chargedNow && p.firstChargeOn !== null;
  return {
    heading: "Set up your monthly payment",
    lines: [...plan, later && p.firstChargeOn ? `First charge on ${chargeDate(p.firstChargeOn)}` : "Charged today", termWords(p.termMonths), "You'll enter a card on the next page."],
    button: "Set up payment",
    note: "The next page is our payment processor's secure page. We never see your card or bank details.",
  };
}

/** Back from the payment page, the state is read again until the server says the subscription is active or closed. */
export const settled = (state: PublicSubscription["state"]): boolean => state !== "ready";

/** Wait before re-read number `attempt` (0 first), in ms, getting longer; null once the cap is reached (the webhook may land a moment after the redirect, but not forever). */
const DELAYS = [1500, 2500, 4000, 6000, 8000];
export const pollDelay = (attempt: number): number | null => (attempt >= 0 && attempt < DELAYS.length ? DELAYS[attempt] : null);

/** Shown when we are back from the payment page but the server still says `ready`. */
export const STILL_PROCESSING = "We're still confirming your payment. This can take a minute. You can leave this page open, or come back to this link later.";

/** What the page says when starting the payment page fails. Nothing the server sent is shown. */
export function checkoutError(status: number): string {
  switch (status) {
    case 404:
    case 409: return "This link isn't open any more. We've reloaded it.";
    case 429: return "Too many tries. Wait a minute and try again.";
    case 503: return "Payments aren't available just now. Please try again in a little while, or reply to the email you got.";
    case 0: return "We couldn't reach the server. Check your connection and try again.";
    default: return "Something went wrong on our side. Please try again.";
  }
}

/** Shown while the page re-reads the state after the return from the payment page. */
export const CONFIRMING = "Confirming your payment…";

/** Only an https page on stripe.com is ever navigated to, whatever the server sent. */
export function isCheckoutUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try { const u = new URL(url); return u.protocol === "https:" && (u.hostname === "stripe.com" || u.hostname.endsWith(".stripe.com")); } catch { return false; }
}
