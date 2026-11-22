import { Hono } from "hono";
import { z } from "zod";
import { AUTO_APPROVE_KINDS, AUTO_DAILY_CAP, type AutoApproveKind } from "../approvals/auto";
import { calendarDateIn } from "../billing/dates";
import { countAutoApprovalsOn, listAutoApprovals, listRules, setRule, type AutoApproval } from "../db/autoApprove";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { bodyOf, NOT_FOUND, ownerOnError, type Ctx } from "../projects/http";
import { zoneOf } from "../sop/cadence";

/**
 * Mounted at /api/auto-approve (behind requireAuth): GET / (the two rules, today's count against the cap, the last 50 outcomes) and PUT /:kind (body `{ enabled }`) to switch one rule. Only the two kinds listed
 * in `AUTO_APPROVE_KINDS` exist here: any other kind is a 404, so a rule row can never be made for one.
 */
export const autoApproveRoutes = new Hono<{ Bindings: Env }>();
autoApproveRoutes.onError(ownerOnError);

const RECENT = 50;

export interface RuleView { kind: AutoApproveKind; label: string; covers: string; never: string; enabled: boolean; enabledAt: string | null }
export interface OutcomeView extends AutoApproval { label: string }
export interface AutoApproveState { rules: RuleView[]; today: number; cap: number; recent: OutcomeView[] }

const WORDS: Record<AutoApproveKind, { label: string; covers: string; never: string }> = {
  "invoice.reminder": {
    label: "Invoice reminders",
    covers: "Every reminder before the last one on a real invoice the client was sent, in the fixed wording you see in each draft.",
    never: "The last reminder, the one that names the date work pauses. A test invoice. A client whose work is on hold. A reminder that was drafted before you switched this on.",
  },
  "onboarding.nudge": {
    label: "Onboarding reminders",
    covers: "The first three reminders to a client who has gone quiet on their onboarding list, in the fixed wording you see in each draft.",
    never: "The fourth reminder, the one that says the project moves back in the queue. The Friday update. A test onboarding. A client whose work is on hold. A reminder that was drafted before you switched this on.",
  },
};

async function state(c: Ctx): Promise<AutoApproveState> {
  const db = c.env.DB;
  const rules = await listRules(db);
  const today = calendarDateIn(new Date(), zoneOf(await getSettings(db)));
  return {
    rules: AUTO_APPROVE_KINDS.map((kind) => {
      const r = rules.find((x) => x.kind === kind);
      return { kind, ...WORDS[kind], enabled: !!r?.enabled, enabledAt: r?.enabled ? r.enabledAt : null };
    }),
    today: await countAutoApprovalsOn(db, today),
    cap: AUTO_DAILY_CAP,
    recent: (await listAutoApprovals(db, RECENT)).map((a) => ({ ...a, label: (WORDS as Record<string, { label: string }>)[a.kind]?.label ?? a.kind })),
  };
}

autoApproveRoutes.get("/", async (c) => c.json(await state(c)));

const Body = z.object({ enabled: z.boolean() });

autoApproveRoutes.put("/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!(AUTO_APPROVE_KINDS as readonly string[]).includes(kind)) return c.json(NOT_FOUND, 404);
  const body = await bodyOf(c, Body);
  if (body instanceof Response) return body;
  await setRule(c.env.DB, kind, body.enabled, new Date().toISOString());
  return c.json(await state(c));
});
