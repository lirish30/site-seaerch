import { Hono } from "hono";
import { z } from "zod";
import { reject } from "../approvals/decide";
import { isClient } from "../clients/record";
import { getLadderRow, listLadder, moveLadder, setLadderLink, type LadderRow, type LadderStatus } from "../db/ladder";
import type { Env } from "../env";
import { bodyOf, NOT_FOUND, ownerOnError, type Ctx } from "../projects/http";

/**
 * Mounted at /api (behind requireAuth): GET /clients/:id/ladder (the client's steps), POST /ladder/:id/done, POST /ladder/:id/skip (body `{ note }`, at most 300 characters) and PUT /ladder/:id/link
 * (body `{ link }`: an https address of at most 300 characters, or null). A step that is done or skipped already is a 409. Nothing here sends mail: a mail goes only through its approval.
 */
export const ladderRoutes = new Hono<{ Bindings: Env }>();
ladderRoutes.onError(ownerOnError);

/** The states a step can be finished from. A drafted one has a mail waiting for approval, which is turned down so it can never go out after the owner closed the step. */
const OPEN: LadderStatus[] = ["waiting", "due", "drafted"];
export const LINK_MAX = 300;
const NOTE_MAX = 300;

ladderRoutes.get("/clients/:id/ladder", async (c) => {
  const id = c.req.param("id");
  if (!(await isClient(c.env.DB, id))) return c.json(NOT_FOUND, 404);
  return c.json({ rows: await listLadder(c.env.DB, id) });
});

/** Closes a step as `to`, from any open state, and turns down the mail that was drafted for it. The updated step, a 404 for no such step, or a 409 for one that is closed already. */
async function close(c: Ctx, to: "done" | "skipped", note?: string): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const row = await getLadderRow(c.env.DB, id);
  if (!row) return c.json(NOT_FOUND, 404);
  if (!OPEN.includes(row.status)) return c.json({ error: `This step is already ${row.status}.` }, 409);
  const moved = await moveLadder(c.env.DB, id, OPEN, to, { now: new Date().toISOString(), ...(note ? { note } : {}) });
  if (!moved) return c.json({ error: "This step was changed a moment ago. Refresh and look again." }, 409);
  if (row.status === "drafted" && row.approvalId) await reject(c.env.DB, row.approvalId, to === "done" ? "Marked done by hand" : "Skipped");
  return c.json({ row: (await getLadderRow(c.env.DB, id)) as LadderRow });
}

ladderRoutes.post("/ladder/:id/done", (c) => close(c, "done"));

const SkipBody = z.object({ note: z.string().trim().max(NOTE_MAX, `The note is at most ${NOTE_MAX} characters.`).optional() });
ladderRoutes.post("/ladder/:id/skip", async (c) => {
  const body = await bodyOf(c, SkipBody);
  if (body instanceof Response) return body;
  return close(c, "skipped", body.note);
});

const LinkBody = z.object({
  link: z.string().trim().max(LINK_MAX, `The link must be at most ${LINK_MAX} characters.`).refine((s) => /^https:\/\/[^\s]+$/.test(s) && URL.canParse(s), "The link must be an https address.").nullable(),
});
ladderRoutes.put("/ladder/:id/link", async (c) => {
  const body = await bodyOf(c, LinkBody);
  if (body instanceof Response) return body;
  const id = c.req.param("id") ?? "";
  const row = await getLadderRow(c.env.DB, id);
  if (!row) return c.json(NOT_FOUND, 404);
  // A drafted step's mail was made with the link it had: changing it now would leave the card saying one thing and the mail another.
  if (row.status !== "waiting" && row.status !== "due") return c.json({ error: `This step is ${row.status}, so its link can no longer be changed.` }, 409);
  await setLadderLink(c.env.DB, id, body.link);
  // A review request that was held back only for want of a link goes back in line for the next sweep.
  if (row.status === "due" && row.step === "review_request" && body.link) await moveLadder(c.env.DB, id, ["due"], "waiting", { note: "" });
  return c.json({ row: (await getLadderRow(c.env.DB, id)) as LadderRow });
});
