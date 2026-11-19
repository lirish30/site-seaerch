import { z } from "zod";
import { dollars, formatPrice } from "../../client/packagesView";
import type { Deal } from "../db/deals";
import { PACKAGE_KEYS, type Package, type PackageKey, type PackageSnapshot } from "../db/packages";
import { validateOptions, type Option } from "../sales/options";
import { CLAUSE_LIBRARY_VERSION, TERMS, clausesFor, type ClauseId, type RenderedClause } from "./clauses";
import type { DocumentsConfig } from "./config";
import { BUILD_KEYS, ScheduleError, paymentSchedule, type PaymentSchedule } from "./schedule";

export interface ProposalContent {
  header: {
    reference: string; version: number; preparedOn: string; sentOn: string | null; expiresOn: string | null;
    clientName: string; contactName: string; contactEmail: string; providerName: string; providerBusiness: string; providerEmail: string;
  };
  optionId: "a" | "b" | "c";
  packages: { key: PackageKey; version: number; name: string; priceLine: string; includes: string[] }[];
  scopeNotes: string;
  assumptions: string[];
  outOfScope: string[];
  phases: { name: string; summary: string; milestoneId: string | null }[];
  schedule: PaymentSchedule;
  careDeclined: boolean;
  clauses: RenderedClause[];
  clauseLibraryVersion: number;
}

export interface ProposalEdits { scopeNotes?: string; extraAssumptions?: string[]; extraOutOfScope?: string[]; careDeclined?: boolean }

/** The proposal cannot be built from this deal and these inputs (a 400 or 409, with a message Logan can act on). */
export class ProposalError extends Error {}

/** Text from a prospect or a person is never trusted to be short. These caps hold for every field a proposal repeats. */
const SCOPE_MAX = 4000, ITEM_MAX = 300, LIST_MAX = 20, NAME_MAX = 200, EMAIL_MAX = 254;
const list = z.array(z.string().max(ITEM_MAX)).max(LIST_MAX);
const iso = z.string().datetime();

export const ProposalContentSchema = z.object({
  header: z.object({
    reference: z.string().min(1).max(20), version: z.number().int().min(1), preparedOn: iso, sentOn: iso.nullable(), expiresOn: iso.nullable(),
    clientName: z.string().min(1).max(NAME_MAX), contactName: z.string().max(NAME_MAX), contactEmail: z.string().min(1).max(EMAIL_MAX),
    providerName: z.string().max(NAME_MAX), providerBusiness: z.string().max(NAME_MAX), providerEmail: z.string().max(EMAIL_MAX),
  }),
  optionId: z.enum(["a", "b", "c"]),
  packages: z.array(z.object({ key: z.enum(PACKAGE_KEYS), version: z.number().int().min(1), name: z.string().max(NAME_MAX), priceLine: z.string().max(NAME_MAX * 2), includes: list })).max(LIST_MAX),
  scopeNotes: z.string().max(SCOPE_MAX),
  assumptions: list,
  outOfScope: list,
  phases: z.array(z.object({ name: z.string().max(ITEM_MAX), summary: z.string().max(ITEM_MAX), milestoneId: z.string().nullable() })).max(LIST_MAX),
  schedule: z.object({
    milestones: z.array(z.object({ id: z.string(), label: z.string(), dueOn: z.enum(["signing", "design_approved", "site_finished"]), amountCents: z.number().int().min(1) })),
    recurring: z.array(z.object({
      key: z.enum(PACKAGE_KEYS), name: z.string(), monthlyCents: z.number().int().min(0), startsOn: z.enum(["signing", "launch", "kickoff"]),
      termMonths: z.number().int().nullable(), firstMonthPrepaid: z.boolean(),
    })),
    depositCents: z.number().int().min(1),
  }),
  careDeclined: z.boolean(),
  clauses: z.array(z.object({ id: z.custom<ClauseId>((v) => typeof v === "string"), title: z.string(), text: z.string() })),
  clauseLibraryVersion: z.number().int().min(1),
}) satisfies z.ZodType<ProposalContent>;

const DEFAULT_ASSUMPTIONS = [
  "The client supplies the text, photos, logo and other content the site needs, and approves it on time.",
  `The project includes ${TERMS.revisionRounds} revision rounds.`,
  "The client owns, or has permission to use, everything it supplies.",
  "Search rankings, traffic and leads are not promised.",
];
const DEFAULT_OUT_OF_SCOPE = [
  "Third-party fees such as domain names, premium plugins and themes, stock photos, paid advertising and software subscriptions.",
  "Copywriting, photography and video, unless the scope names them.",
  "Pages, features and integrations that are not listed in the scope.",
  "Changes after approval beyond the included revision rounds. Those are change orders.",
];

const CARE_KEYS: PackageKey[] = ["care", "care_plus", "care_fallback"];

/** The frozen price wins over the catalog row; the row supplies only what the snapshot does not hold (the Care-client hourly rate). */
function priceLine(snap: PackageSnapshot, row: Package, discountCents: number): string {
  const line = formatPrice({ kind: snap.kind, priceCents: snap.priceCents, setupCents: snap.setupCents, termMonths: snap.termMonths, fromPrice: snap.fromPrice, altPriceCents: row.altPriceCents });
  return discountCents > 0 ? `${line} (setup discount ${dollars(discountCents)})` : line;
}

function phasesFor(keys: PackageKey[], schedule: PaymentSchedule): ProposalContent["phases"] {
  const has = (id: string) => schedule.milestones.some((m) => m.id === id);
  const link = (id: string) => (has(id) ? id : null);
  if (keys.some((k) => BUILD_KEYS.includes(k))) return [
    { name: "Discovery and sitemap", summary: "We confirm the goals and agree the pages the site will have.", milestoneId: null },
    { name: "Design", summary: "You see the design and approve it, with the included revision rounds.", milestoneId: link("design_approved") },
    { name: "Build", summary: "The site is built and your content goes in.", milestoneId: null },
    { name: "Review", summary: "You review the finished pages and we make the final changes.", milestoneId: null },
    { name: "Finished", summary: "The site is finished and ready for you to launch.", milestoneId: link("site_finished") },
  ];
  const monthly = { name: "Monthly work", summary: "The monthly services in this proposal run each month.", milestoneId: null };
  if (keys.includes("quick_fix")) {
    const fixes = [
      { name: "The fixes", summary: "We fix the problems listed in the scope.", milestoneId: null },
      { name: "Done", summary: "The fixes are finished and checked.", milestoneId: null },
    ];
    return schedule.recurring.length > 0 ? [...fixes, monthly] : fixes;
  }
  return [{ name: "Setup", summary: "We set up the accounts and tools the monthly work needs.", milestoneId: null }, monthly];
}

/**
 * The proposal for one option of a deal. Every price, name and inclusion comes from the deal's frozen `priceSnapshot` and the versioned catalog rows
 * in `packages` (the rows for the versions in the snapshot, found with `getPackage(db, key, version)`), never from the current catalog.
 * Anything the proposal cannot be built from is a ProposalError.
 */
export function buildProposal(i: {
  deal: Deal; optionId: "a" | "b" | "c"; client: { name: string; contactName: string; contactEmail: string };
  settings: { your_name: string; business_name: string; contact_email: string };
  packages: Package[]; catalogHourly: { hourlyCents: number; hourlyCareCents: number | null };
  edits: ProposalEdits; config: DocumentsConfig; platform: "wordpress" | "other"; now: Date; version: number;
}): ProposalContent {
  const { deal } = i;
  if (!deal.options) throw new ProposalError("This deal has no options yet. Finish the call recap first.");
  const option: Option | undefined = deal.options.find((o) => o.id === i.optionId);
  if (!option) throw new ProposalError(`Option ${String(i.optionId).toUpperCase()} is not one of this deal's options.`);
  if (!(deal.stage === "recommended" || deal.stage === "proposal_sent" || (deal.stage === "discovery_done" && deal.skipCall))) {
    throw new ProposalError("A proposal can be made once the options are recommended.");
  }
  if (!i.client.contactEmail.trim()) throw new ProposalError("The contact has no email address, so the proposal has nowhere to go.");

  const rows = new Map<PackageKey, { snap: PackageSnapshot; row: Package }>();
  for (const item of option.items) {
    const snap = deal.priceSnapshot.find((s) => s.key === item.key);
    if (!snap) throw new ProposalError(`${item.key} has no frozen price on this deal.`);
    const row = i.packages.find((p) => p.key === snap.key && p.version === snap.version);
    if (!row) throw new ProposalError(`${snap.name} (version ${snap.version}) is missing from the package catalog.`);
    rows.set(item.key, { snap, row });
  }

  // A package that was switched off after the sale cannot block its own proposal, so the rows are checked as active. The platform, Care and discount rules still apply.
  const catalog = [...rows.values()].map(({ row }) => ({ ...row, active: true }));
  const name = option.label.trim() || `Option ${option.id.toUpperCase()}`;
  const problems = validateOptions(deal.options, { platform: i.platform, catalog }).filter((p) => p.startsWith(`${name}:`));
  if (problems.length > 0) throw new ProposalError(problems.join(" "));

  const keys = option.items.map((it) => it.key);
  const hasCare = keys.some((k) => CARE_KEYS.includes(k));
  const careDeclined = i.edits.careDeclined === true;
  if (careDeclined && hasCare) throw new ProposalError("Care is in this option, so it cannot also be declined. Remove Care from the option or keep it.");
  if (keys.some((k) => BUILD_KEYS.includes(k)) && !hasCare && !careDeclined) {
    throw new ProposalError("Care is on by default on every new site. Add Care to this option, or record that the client declined it.");
  }

  let schedule: PaymentSchedule;
  try { schedule = paymentSchedule(option, option.items.map((it) => rows.get(it.key)!.snap)); }
  catch (e) { if (e instanceof ScheduleError) throw new ProposalError(e.message); throw e; }

  const clean = (xs: string[] | undefined) => (xs ?? []).map((x) => x.trim()).filter(Boolean);
  const providerBusiness = i.settings.business_name.trim();
  const content: ProposalContent = {
    header: {
      reference: `SL-${deal.id.slice(0, 6).toUpperCase()}`, version: i.version, preparedOn: i.now.toISOString(), sentOn: null, expiresOn: null,
      clientName: i.client.name.trim(), contactName: i.client.contactName.trim(), contactEmail: i.client.contactEmail.trim(),
      providerName: i.settings.your_name.trim(), providerBusiness, providerEmail: i.settings.contact_email.trim(),
    },
    optionId: option.id,
    packages: option.items.map((it) => {
      const { snap, row } = rows.get(it.key)!;
      return { key: snap.key, version: snap.version, name: snap.name, priceLine: priceLine(snap, row, it.setupDiscountCents ?? 0), includes: row.includes };
    }),
    scopeNotes: (i.edits.scopeNotes ?? "").trim(),
    assumptions: [...DEFAULT_ASSUMPTIONS, ...clean(i.edits.extraAssumptions)],
    outOfScope: [...DEFAULT_OUT_OF_SCOPE, ...clean(i.edits.extraOutOfScope)],
    phases: phasesFor(keys, schedule),
    schedule,
    careDeclined,
    clauses: clausesFor({
      providerName: providerBusiness || i.settings.your_name.trim(), clientName: i.client.name.trim(), keys, careDeclined,
      hourlyCents: i.catalogHourly.hourlyCents, hourlyCareCents: i.catalogHourly.hourlyCareCents, config: i.config,
    }),
    clauseLibraryVersion: CLAUSE_LIBRARY_VERSION,
  };
  const parsed = ProposalContentSchema.safeParse(content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProposalError(`${issue.path.join(".") || "proposal"}: ${issue.message}`);
  }
  return parsed.data;
}

/** The proposal as it goes out: stamped with the day it was sent and the day it lapses. */
export function freezeProposal(c: ProposalContent, now: Date, expiryDays: number): ProposalContent {
  return { ...c, header: { ...c.header, sentOn: now.toISOString(), expiresOn: new Date(now.getTime() + expiryDays * 86_400_000).toISOString() } };
}
