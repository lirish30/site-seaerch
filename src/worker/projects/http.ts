import type { Context } from "hono";
import { z } from "zod";
import { ChangeOrderInputError, ChangeOrderStateError } from "../db/changeOrders";
import { SopInputError } from "../db/sops";
import { TaskInputError } from "../db/tasks";
import { TimeStateError } from "../db/time";
import type { Env } from "../env";
import { TaskBlockedError, TaskStateError } from "./service";
import { ProjectStartError } from "./start";

/** What the owner's project, SOP, time and change-order routes share (their four route files import it). */
export type Ctx = Context<{ Bindings: Env }>;

export const NOT_FOUND = { error: "not found" };

/** A body that failed its schema: the field names that were wrong, as the other owner routes answer. */
export const invalid = (error: z.ZodError) => ({ error: "invalid body", fields: z.flattenError(error).fieldErrors });

/** The request body parsed with `schema`, or the 400 to send back. A missing or malformed body is an empty object, so the schema says what is missing. */
export async function bodyOf<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.infer<S> | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  return parsed.success ? parsed.data : c.json(invalid(parsed.error), 400);
}

/** The service errors the routes turn into answers (everything else is a bug or a database error and becomes a plain 500). */
export const isDomainError = (e: unknown): boolean =>
  e instanceof TaskStateError || e instanceof TimeStateError || e instanceof ChangeOrderStateError || e instanceof ProjectStartError
  || e instanceof TaskInputError || e instanceof ChangeOrderInputError || e instanceof SopInputError;

/**
 * The error handler of the four owner route files. A refusal the services make is a sentence the owner can act on: a gated step answers 409 with the titles it waits on,
 * a state that does not allow the change 409, text or numbers that were refused 400 (a template's problems come as a list). Anything else is logged here, in full, and answered
 * with a fixed sentence: a database error never reaches the browser.
 */
export function ownerOnError(e: Error, c: Ctx): Response {
  if (e instanceof TaskBlockedError) return c.json({ error: e.message, blockedBy: e.blockedBy }, 409);
  if (e instanceof TaskStateError || e instanceof TimeStateError || e instanceof ChangeOrderStateError || e instanceof ProjectStartError) return c.json({ error: e.message }, 409);
  if (e instanceof TaskInputError || e instanceof ChangeOrderInputError) return c.json({ error: e.message }, 400);
  if (e instanceof SopInputError) return c.json({ error: e.message, problems: e.problems }, 400);
  console.error("owner api: unexpected error", e instanceof Error ? e.message : "unknown error");
  return c.json({ error: "Something went wrong on our side. Nothing was lost; try again." }, 500);
}
