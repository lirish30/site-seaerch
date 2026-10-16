import { Hono } from "hono";
import type { Env } from "../env";
import { listAllBusinesses } from "../db/businesses";
import { latestDraftsByBusiness } from "../db/drafts";
import { suppressedLeadIds } from "../db/suppression";
import type { Business, Draft } from "../types";
import { leadRows } from "./leads";

export const outreachRoutes = new Hono<{ Bindings: Env }>();

const VIEWS = ["drafts", "followups", "contacted", "replied"] as const;
type View = (typeof VIEWS)[number];
const OPEN = new Set(["new", "reviewed"]);
const CLOSED = new Set(["won", "lost", "skip"]);
const MAX_ITEMS = 200;

/** Which outreach queues a lead is in. A lead can be in more than one (a due follow-up on a lead that has a draft). */
export function queuesOf(b: Pick<Business, "lead_status" | "follow_up_at">, draft: Pick<Draft, "id"> | null, today: string): View[] {
  const out: View[] = [];
  if (draft && OPEN.has(b.lead_status)) out.push("drafts");
  if (b.follow_up_at && b.follow_up_at <= today && !CLOSED.has(b.lead_status)) out.push("followups");
  if (draft && b.lead_status === "contacted") out.push("contacted");
  if (draft && b.lead_status === "replied") out.push("replied");
  return out;
}

/**
 * Everything the Outreach page needs in one request: the lead rows for the chosen queue (with each lead's current draft), and the
 * count of every queue so the sidebar can show them. `purpose` narrows the "drafts" queue to full-time or freelance emails.
 */
outreachRoutes.get("/", async (c) => {
  const q = c.req.query("view");
  const view: View = (VIEWS as readonly string[]).includes(q ?? "") ? (q as View) : "drafts";
  const purpose = c.req.query("purpose");
  if (purpose !== undefined && purpose !== "full_time" && purpose !== "freelance") return c.json({ error: "bad purpose" }, 400);
  const [all, drafts] = await Promise.all([listAllBusinesses(c.env.DB, {}), latestDraftsByBusiness(c.env.DB)]);
  const hidden = await suppressedLeadIds(c.env.DB, all);
  const today = new Date().toISOString().slice(0, 10);
  const counts = { drafts: 0, followups: 0, contacted: 0, replied: 0, full_time: 0, freelance: 0 };
  const picked: Business[] = [];
  for (const b of all) {
    if (hidden.has(b.id)) continue;
    const draft = drafts.get(b.id) ?? null;
    const queues = queuesOf(b, draft, today);
    for (const k of queues) counts[k]++;
    if (queues.includes("drafts") && draft) counts[draft.purpose]++;
    if (queues.includes(view) && (!purpose || view !== "drafts" || draft?.purpose === purpose)) picked.push(b);
  }
  if (c.req.query("counts") === "1") return c.json({ counts }); // the sidebar only needs the numbers
  const rows = await leadRows(c.env.DB, picked.slice(0, MAX_ITEMS));
  return c.json({ counts, items: rows.map((row) => ({ row, draft: drafts.get(row.business.id) ?? null })) });
});
