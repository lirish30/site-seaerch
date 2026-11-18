export type CampaignStatus = "testing" | "active" | "archived";
export type StepKind = "email" | "call" | "checkin";
export type OffsetKind = "business" | "calendar";

export interface Campaign {
  id: string; name: string; niche: string; region: string; towns: string[];
  status: CampaignStatus; est_job_value_usd: number | null; created_at: string;
}
export interface SequenceStep {
  id: string; campaign_id: string; idx: number; kind: StepKind;
  offset_days: number; offset_kind: OffsetKind; subject: string; variants: string[];
  // 'draft': the body is written per lead from its draft (Email 1), so variants stay empty and the editor says so.
  body_source: "variants" | "draft";
}
export type StepInput = Omit<SequenceStep, "id" | "campaign_id" | "body_source"> & { body_source?: SequenceStep["body_source"] };

type CampaignRow = Omit<Campaign, "towns"> & { towns: string };
type StepRow = Omit<SequenceStep, "variants"> & { variants: string };

const toCampaign = (r: CampaignRow): Campaign => ({ ...r, towns: JSON.parse(r.towns) as string[] });
const toStep = (r: StepRow): SequenceStep => ({ ...r, variants: JSON.parse(r.variants) as string[] });

const LINK = "{link}";
const OPT_OUT = `Reply "later" and I'll check back in a few months, or "no thanks" and I won't write again.`;
const FOLLOW_UP_SUBJECT = "Re: Quick video about {Business}'s website";

/**
 * Logan's own follow-up copy (Web Kit, section 7), no prices so it never goes stale against the package ladder.
 * Merge fields: {Business}, {Name}, {link}, {problem_one}. The mailing footer is added when the email is composed.
 * {problem_one} must be a noun phrase that reads after "the" ("If the website ever becomes a priority"). The caller
 * (Task 7) supplies PROBLEM_ONE_FALLBACK ("website") when a lead has no finding, so Email 3 never throws.
 */
export const DEFAULT_STEPS: StepInput[] = [
  { idx: 0, kind: "email", offset_days: 0, offset_kind: "business", subject: "", variants: [], body_source: "draft" },
  {
    idx: 1, kind: "email", offset_days: 5, offset_kind: "business", subject: FOLLOW_UP_SUBJECT,
    variants: [
      `Hi {Name},\n\nJust making sure the video reached you: ${LINK}\n\nIf now isn't a good time, no problem. ${OPT_OUT}\n\nLogan`,
      `Hi {Name},\n\nI wanted to check that my note about {Business}'s website got to you. The video is here if you haven't had a chance to watch: ${LINK}\n\nNot a good time? ${OPT_OUT}\n\nLogan`,
    ],
  },
  { idx: 2, kind: "call", offset_days: 7, offset_kind: "calendar", subject: "", variants: [] },
  {
    idx: 3, kind: "email", offset_days: 12, offset_kind: "business", subject: FOLLOW_UP_SUBJECT,
    variants: [
      `Hi {Name},\n\nI'll leave this one here so I'm not filling your inbox. The video stays up if you want it later: ${LINK}\n\nIf the {problem_one} ever becomes a priority, feel free to reply to this email and I'll pick it up from there.\n\nLogan`,
      `Hi {Name},\n\nThis is my last note, so I won't keep filling your inbox. The video about {Business}'s website stays up whenever you want it: ${LINK}\n\nIf the {problem_one} ever moves up your list, reply here and I'll pick it up from there.\n\nLogan`,
    ],
  },
  {
    // Claims no re-visit of the site and nothing about what changed on it: the app does not know either, so these lines stay true regardless.
    idx: 4, kind: "checkin", offset_days: 90, offset_kind: "calendar", subject: "Checking back on {Business}'s website",
    variants: [
      "Hi {Name},\n\nIt's been a few months and I wanted to check in on {Business}'s website. Happy to send an updated video if it's useful.\n\nLogan",
      "Hi {Name},\n\nIt's been a while since my last note about {Business}'s website, so I wanted to check in. If a fresh video would help, I'm glad to send one.\n\nLogan",
    ],
  },
];

const stepInsert = (db: D1Database, campaignId: string, s: StepInput & { body_source: SequenceStep["body_source"] }) =>
  db.prepare(
    `INSERT INTO sequence_steps (id, campaign_id, idx, kind, offset_days, offset_kind, subject, variants, body_source) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (campaign_id, idx) DO UPDATE SET kind = excluded.kind, offset_days = excluded.offset_days, offset_kind = excluded.offset_kind,
       subject = excluded.subject, variants = excluded.variants, body_source = excluded.body_source`,
  ).bind(crypto.randomUUID(), campaignId, s.idx, s.kind, s.offset_days, s.offset_kind, s.subject, JSON.stringify(s.variants), s.body_source);

/** A step that breaks the body rules; `field` names the offending input so a route can report it. */
export class StepInvariantError extends Error {
  constructor(public readonly field: "variants" | "body_source", message: string) { super(message); this.name = "StepInvariantError"; }
}

export const MAX_VARIANTS = 5;

/**
 * Step 0 (Email 1) is always written per lead from its draft: body_source 'draft', no variants. Every other step is
 * always 'variants' with 1-5 of them; a call has no body to send, so it may have none.
 */
function checkStepBody(idx: number, kind: StepKind, bodySource: SequenceStep["body_source"], variants: string[]) {
  if (idx === 0) {
    if (bodySource !== "draft") throw new StepInvariantError("body_source", "step 0 is written per lead from the draft and cannot use variants");
    if (variants.length) throw new StepInvariantError("variants", "step 0 is written per lead from the draft and takes no variants");
    return;
  }
  if (bodySource !== "variants") throw new StepInvariantError("body_source", "only step 0 can be written from the lead's draft");
  if (variants.length > MAX_VARIANTS) throw new StepInvariantError("variants", `at most ${MAX_VARIANTS} variants`);
  if (!variants.length && kind !== "call") throw new StepInvariantError("variants", "at least one variant is required");
}

/** Creates the campaign (status 'testing') together with its default steps in one batch. */
export async function createCampaign(db: D1Database, i: { name: string; niche: string; region: string; towns: string[] }): Promise<Campaign> {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO campaigns (id, name, niche, region, towns, status, created_at) VALUES (?,?,?,?,?, 'testing', ?)`)
      .bind(id, i.name, i.niche, i.region, JSON.stringify(i.towns), new Date().toISOString()),
    ...DEFAULT_STEPS.map((s) => stepInsert(db, id, { ...s, body_source: s.body_source ?? "variants" })),
  ]);
  return (await getCampaign(db, id))!;
}

export async function getCampaign(db: D1Database, id: string): Promise<Campaign | null> {
  const r = await db.prepare(`SELECT * FROM campaigns WHERE id = ?`).bind(id).first<CampaignRow>();
  return r ? toCampaign(r) : null;
}

export async function listCampaigns(db: D1Database): Promise<Campaign[]> {
  return (await db.prepare(`SELECT * FROM campaigns ORDER BY created_at DESC, id`).all<CampaignRow>()).results.map(toCampaign);
}

export type CampaignPatch = Partial<Pick<Campaign, "name" | "niche" | "region" | "towns" | "status" | "est_job_value_usd">>;

/** Null when the campaign does not exist. */
export async function updateCampaign(db: D1Database, id: string, patch: CampaignPatch): Promise<Campaign | null> {
  const { towns, ...rest } = patch;
  // Column names come from this fixed list, never from the caller; values are bound.
  const cols = (["name", "niche", "region", "status", "est_job_value_usd"] as const).filter((k) => rest[k] !== undefined);
  const sets = cols.map((k) => `${k} = ?`);
  const vals: unknown[] = cols.map((k) => rest[k]);
  if (towns !== undefined) { sets.push("towns = ?"); vals.push(JSON.stringify(towns)); }
  if (sets.length) await db.prepare(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  return getCampaign(db, id);
}

export async function listSteps(db: D1Database, campaignId: string): Promise<SequenceStep[]> {
  return (await db.prepare(`SELECT * FROM sequence_steps WHERE campaign_id = ? ORDER BY idx`).bind(campaignId).all<StepRow>()).results.map(toStep);
}

/**
 * Replaces the step at `step.idx`, or adds it. An omitted `body_source` keeps the stored one. Throws StepInvariantError
 * for a body that breaks the step rules, so no caller can store one.
 */
export async function saveStep(db: D1Database, campaignId: string, step: StepInput): Promise<SequenceStep> {
  const existing = await db.prepare(`SELECT body_source FROM sequence_steps WHERE campaign_id = ? AND idx = ?`).bind(campaignId, step.idx).first<{ body_source: SequenceStep["body_source"] }>();
  const bodySource = step.body_source ?? existing?.body_source ?? (step.idx === 0 ? "draft" : "variants");
  checkStepBody(step.idx, step.kind, bodySource, step.variants);
  await stepInsert(db, campaignId, { ...step, body_source: bodySource }).run();
  return toStep((await db.prepare(`SELECT * FROM sequence_steps WHERE campaign_id = ? AND idx = ?`).bind(campaignId, step.idx).first<StepRow>())!);
}
