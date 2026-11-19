import type { Env } from "../env";

/**
 * Queues the call-prep task for a deal once its discovery call is booked. Task 8 gives this a body (a `call.prep` queue task); until then a booking
 * calls it and nothing happens.
 */
export async function queueCallPrep(_env: Env, _dealId: string): Promise<void> {}
