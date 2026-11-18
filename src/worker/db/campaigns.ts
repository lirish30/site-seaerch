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
    // Says nothing about what changed on the site: the app does not know, so every line here is true regardless.
    idx: 4, kind: "checkin", offset_days: 90, offset_kind: "calendar", subject: "Checking back on {Business}'s website",
    variants: [
      "Hi {Name},\n\nI took another quick look at the site and wanted to check in. Happy to send an updated video if it's useful.\n\nLogan",
      "Hi {Name},\n\nIt's been a few months, so I took another look at {Business}'s website and thought I'd say hello. If an updated video would help, I'm glad to send one.\n\nLogan",
    ],
  },
];

const stepInsert = (db: D1Database, campaignId: string, s: StepInput) =>
  db.prepare(
    `INSERT INTO sequence_steps (id, campaign_id, idx, kind, offset_days, offset_kind, subject, variants, body_source) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (campaign_id, idx) DO UPDATE SET kind = excluded.kind, offset_days = excluded.offset_days, offset_kind = excluded.offset_kind,
       subject = excluded.subject, variants = excluded.variants, body_source = excluded.body_source`,
  ).bind(crypto.randomUUID(), campaignId, s.idx, s.kind, s.offset_days, s.offset_kind, s.subject, JSON.stringify(s.variants), s.body_source ?? "variants");

/** Creates the campaign (status 'testing') together with its default steps in one batch. */
export async function createCampaign(db: D1Database, i: { name: string; niche: string; region: string; towns: string[] }): Promise<Campaign> {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO campaigns (id, name, niche, region, towns, status, created_at) VALUES (?,?,?,?,?, 'testing', ?)`)
      .bind(id, i.name, i.niche, i.region, JSON.stringify(i.towns), new Date().toISOString()),
    ...DEFAULT_STEPS.map((s) => stepInsert(db, id, s)),
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

/** Replaces the step at `step.idx`, or adds it. */
export async function saveStep(db: D1Database, campaignId: string, step: StepInput): Promise<SequenceStep> {
  await stepInsert(db, campaignId, step).run();
  return toStep((await db.prepare(`SELECT * FROM sequence_steps WHERE campaign_id = ? AND idx = ?`).bind(campaignId, step.idx).first<StepRow>())!);
}
