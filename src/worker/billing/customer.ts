import { getStripeCustomer, saveStripeCustomer } from "../db/invoices";
import type { Env } from "../env";
import type { Fetch } from "../google/oauth";
import { StripeError, createCustomer } from "../stripe/client";

/**
 * The business's Stripe customer: the one already saved, or a new one made now and saved. The idempotency key is fixed per business (`customer:<businessId>`), so a retry after a
 * half-finished attempt (a customer made at Stripe but not saved here) replays what Stripe already did instead of making a second customer. Two requests at once agree on the
 * first one saved. Throws a `StripeError` when there is no secret key or Stripe fails.
 */
export async function ensureStripeCustomer(env: Env, o: { businessId: string; name: string; email: string }, f: Fetch): Promise<string> {
  const existing = await getStripeCustomer(env.DB, o.businessId);
  if (existing) return existing;
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeError("Stripe is not configured with a secret key", 0);
  return saveStripeCustomer(env.DB, o.businessId, (await createCustomer(f, key, { name: o.name, email: o.email, businessId: o.businessId }, `customer:${o.businessId}`)).id);
}
