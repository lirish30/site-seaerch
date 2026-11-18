/** A failure that will happen the same way again, so Workflows should not retry it; workflows.ts turns it into a NonRetryableError. Nothing throws it
 *  now that the Claude stages run on the queue (there is no API call to refuse), so it goes with the roadmap stage. */
export class CroFatalError extends Error {}
