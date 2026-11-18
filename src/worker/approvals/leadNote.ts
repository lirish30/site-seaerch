import { z } from "zod";
import { registerHandler } from "./registry";
import { getBusiness } from "../db/businesses";
import { logActivity } from "../db/activity";

const Payload = z.object({ businessId: z.string().min(1), text: z.string().trim().min(1).max(2000) });

/** Same write the lead-notes route does: a `note` row on the lead's activity timeline. */
registerHandler({
  kind: "lead.note",
  label: "Lead note",
  parse: (p) => Payload.parse(p),
  async execute(env, p: z.infer<typeof Payload>) {
    if (!(await getBusiness(env.DB, p.businessId))) throw new Error("lead not found");
    await logActivity(env.DB, p.businessId, "note", p.text);
  },
});
