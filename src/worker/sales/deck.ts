import { dollars, formatPrice } from "../../client/packagesView";
import type { CallRecap } from "../queue/callRecap";
import type { Deal } from "../db/deals";
import type { Package, PackageKey, PackageSnapshot } from "../db/packages";
import type { Audit, Finding, Settings } from "../types";
import { monthlyAtStakeCents, type DiscoveryNotes, type LeadType } from "./notes";
import { optionTotals, type Option } from "./options";

/**
 * The recommendation deck, built as data (Web Kit pitch deck template, slides 1 to 18; slide 19 is the lead-type guide that picks which slides stay, so it is
 * never a slide). Every price comes from the deal's frozen `priceSnapshot`; the current catalog is used only for a deal that has no snapshot.
 */
export type DeckSlideKey =
  | "title" | "agenda" | "recap" | "found" | "scorecard" | "numbers" | "recommendation" | "quick_fix" | "care" | "local_seo" | "new_site"
  | "options" | "pay_new_site" | "about" | "work" | "timeline" | "next" | "thanks";

/** The template's slide order; the index plus one is the slide number. */
export const DECK_ORDER: readonly DeckSlideKey[] = [
  "title", "agenda", "recap", "found", "scorecard", "numbers", "recommendation", "quick_fix", "care", "local_seo", "new_site",
  "options", "pay_new_site", "about", "work", "timeline", "next", "thanks",
];
const at = (...n: number[]): DeckSlideKey[] => n.map((i) => DECK_ORDER[i - 1]);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Slide 19's table: which slides each kind of lead keeps. */
export const KEEP: Record<LeadType, DeckSlideKey[]> = {
  wp_few_broken: at(...range(1, 5), 7, 8, 9, 12, ...range(14, 18)),
  wp_behind: at(...range(1, 5), 7, 8, 9, 12, ...range(14, 18)),
  other_platform: at(...range(1, 5), 7, 8, 10, 12, ...range(14, 18)),
  more_calls: at(...range(1, 4), 6, 7, 9, 10, 12, ...range(14, 18)),
  new_site: at(...range(1, 4), 7, 11, 13, ...range(14, 18)),
};

/** A catalog package as the deck needs it: the snapshot fields, plus the inclusions and the one-line summary (neither is a price). */
export type DeckPackage = PackageSnapshot & { includes?: string[]; summary?: string };

export interface DeckInput {
  deal: Deal;
  business: { name: string; ownerName: string | null };
  notes: DiscoveryNotes;
  recap: CallRecap;
  /** The three problems from the video plan (or the first three audit flags), in the order to show them. `label` names the kind (costs calls, looks out of date, harder to find). */
  problems: { title: string; consequence: string; imageDataUri: string | null; label?: string }[];
  scorecard: { label: string; result: "pass" | "flag" | string }[];
  samples: { name: string; blurb: string; imageDataUri: string | null }[];
  settings: Pick<Settings, "your_name" | "bio" | "contact_email" | "role_title">;
  catalog: DeckPackage[];
  now: Date;
}

export interface DeckOptionItem { name: string; price: string; snapshot: PackageSnapshot }
export type DeckBlock =
  | { type: "text"; text: string; style?: "eyebrow" | "lead" | "fine" | "quote" }
  | { type: "list"; items: { title?: string; text: string }[]; heading?: string; numbered?: boolean }
  | { type: "stat"; value: string; label: string; op?: "times" | "equals" }
  | { type: "option"; id: string; label: string; tagline: string; recommended: boolean; items: DeckOptionItem[]; upfront: string | null; monthly: string | null; includes?: string[] }
  | { type: "image"; dataUri: string | null; alt: string; label?: string; title?: string; text?: string }
  | { type: "price"; text: string; snapshot: PackageSnapshot };

export interface DeckSlide { key: DeckSlideKey; title: string; blocks: DeckBlock[]; speakerNote: string }

const PROBLEM_LABELS = ["Costs calls", "Looks out of date", "Harder to find"];
const CONSEQUENCE: Record<string, string> = {
  "Costs calls": "Someone who needs help right now moves on to the next result.",
  "Looks out of date": "New customers can read that as a business that isn't keeping up.",
  "Harder to find": "It's harder to show up when someone searches your service in your town.",
};

// ---- Money ----------------------------------------------------------------------------------------------------------------------------------------------

/** A snapshot as the `Package` the money helpers take (they read only the key, kind and the amounts). */
const asPackage = (s: PackageSnapshot): Package => ({
  ...s, id: `snap_${s.key}_${s.version}`, altPriceCents: null, summary: "", includes: [], wordpressOnly: false, publicOffer: true, active: true, createdAt: "",
});
const priceText = (s: PackageSnapshot) => formatPrice(asPackage(s));
const snapshotFields = (s: PackageSnapshot): PackageSnapshot => ({
  key: s.key, version: s.version, name: s.name, kind: s.kind, priceCents: s.priceCents, setupCents: s.setupCents, termMonths: s.termMonths, fromPrice: s.fromPrice,
});

interface Ctx {
  input: DeckInput;
  price: (key: PackageKey) => PackageSnapshot | null;
  includes: (key: PackageKey) => string[];
  options: Option[];
  /** The option put forward: the middle one. */
  recommended: Option | null;
  inAnyOption: (...keys: PackageKey[]) => PackageKey | null;
  atStake: number | null;
  numbersShown: boolean;
  business: string;
}

function makeCtx(input: DeckInput): Ctx {
  const frozen = input.deal.priceSnapshot;
  const source: PackageSnapshot[] = frozen.length > 0 ? frozen : input.catalog;
  const price = (key: PackageKey) => source.find((s) => s.key === key) ?? null;
  const options = input.deal.options ?? [];
  const keep = KEEP[input.recap.leadType] ?? KEEP.wp_few_broken;
  const atStake = monthlyAtStakeCents(input.notes);
  return {
    input, price, options, recommended: options[1] ?? null, atStake,
    includes: (key) => input.catalog.find((c) => c.key === key)?.includes ?? [],
    inAnyOption: (...keys) => {
      const inRec = options[1]?.items.map((i) => i.key) ?? [];
      return keys.find((k) => inRec.includes(k)) ?? keys.find((k) => options.some((o) => o.items.some((i) => i.key === k))) ?? null;
    },
    numbersShown: keep.includes("numbers") && atStake !== null,
    business: input.business.name,
  };
}

const text = (t: string, style?: Extract<DeckBlock, { type: "text" }>["style"]): DeckBlock => (style ? { type: "text", text: t, style } : { type: "text", text: t });
const eyebrow = (t: string) => text(t, "eyebrow");
const pricedItems = (ctx: Ctx, o: Option): DeckOptionItem[] => o.items.flatMap((i) => {
  const s = ctx.price(i.key);
  if (!s) return [];
  const off = i.setupDiscountCents ? ` (less ${dollars(i.setupDiscountCents)} off setup)` : "";
  return [{ name: s.name, price: `${priceText(s)}${off}`, snapshot: snapshotFields(s) }];
});
const totalsOf = (ctx: Ctx, o: Option) => {
  const priced = o.items.flatMap((i) => (ctx.price(i.key) ? [i] : []));
  const t = optionTotals({ ...o, items: priced }, priced.map((i) => asPackage(ctx.price(i.key)!)));
  // A "from" price in the option makes the sum a "from" figure too: the line items say "from $3,997", so the total must not read as a fixed price.
  const from = priced.some((i) => ctx.price(i.key)?.fromPrice) ? "from " : "";
  return { upfront: t.upfrontCents > 0 ? `${from}${dollars(t.upfrontCents)}` : null, monthly: t.monthlyCents > 0 ? `${dollars(t.monthlyCents)}/mo` : null };
};
const optionBlock = (ctx: Ctx, o: Option, recommended: boolean, extra: { includes?: string[] } = {}): DeckBlock => ({
  type: "option", id: o.id, label: o.label, tagline: o.tagline, recommended, items: pricedItems(ctx, o), ...totalsOf(ctx, o), ...extra,
});

// ---- Slides ---------------------------------------------------------------------------------------------------------------------------------------------

const monthYear = (d: Date) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "America/Los_Angeles" }).format(d);

const BUILD: Record<DeckSlideKey, (c: Ctx) => DeckSlide | null> = {
  title: (c) => ({
    key: "title", title: c.business,
    blocks: [eyebrow("Website review"), text(`Website review and recommendation${c.input.business.ownerName ? `  ·  Prepared for ${c.input.business.ownerName}` : ""}  ·  ${monthYear(c.input.now)}`, "lead")],
    speakerNote: "Open the meeting by thanking them for the time and confirming how long you have (aim for 30 minutes).",
  }),

  agenda: (c) => {
    const items = [
      { title: "What I heard", text: "Your goals and where things stand." },
      { title: "What I found", text: "Three problems from your site review." },
      ...(c.numbersShown ? [{ title: "What it costs", text: "Your numbers, not mine." }] : []),
      { title: "What I recommend", text: "The plan and the investment." },
      { title: "Next steps", text: "How we'd get started." },
    ];
    return {
      key: "agenda", title: "What we'll cover today.", blocks: [eyebrow("Agenda"), { type: "list", items, numbered: true }],
      speakerNote: "Cards follow the sections you are showing. What it costs only appears when the owner gave you both numbers on the call.",
    };
  },

  recap: (c) => {
    const { recap, notes } = c.input;
    const goals = recap.goals.length ? recap.goals : notes.goals;
    const state = recap.currentState.length ? recap.currentState : notes.currentState;
    return {
      key: "recap", title: "Here's what I heard from you.",
      blocks: [
        eyebrow("Discovery recap"),
        ...(recap.playback ? [text(recap.playback, "lead")] : []),
        { type: "list", heading: "Your goals", items: goals.map((g) => ({ text: g })) },
        ...(state.length ? [{ type: "list", heading: "Where things are now", items: state.map((g) => ({ text: g })) } as DeckBlock] : []),
      ],
      speakerNote: "This comes from your discovery call notes, in their words. It shows you listened. Read it back and ask if anything has changed.",
    };
  },

  found: (c) => {
    const problems = c.input.problems.slice(0, 3);
    if (problems.length === 0) return null;
    return {
      key: "found", title: "Three things I found on your site.",
      blocks: [
        eyebrow("What I found"),
        ...problems.map((p, i): DeckBlock => ({
          type: "image", dataUri: p.imageDataUri, alt: p.title, label: `${String(i + 1).padStart(2, "0")}  ·  ${(p.label ?? PROBLEM_LABELS[i] ?? "A problem").toUpperCase()}`,
          title: p.title, text: p.consequence,
        })),
      ],
      speakerNote: "These are the same three problems as the video review, so the meeting picks up where the video left off. Order: the one that costs calls, the one that looks out of date, the Google one.",
    };
  },

  scorecard: (c) => {
    if (c.input.scorecard.length === 0) return null;
    return {
      key: "scorecard", title: "How your site did on my 10 minute audit.",
      blocks: [eyebrow("Audit scorecard"), { type: "list", items: c.input.scorecard.map((r) => ({ title: r.label, text: r.result === "pass" ? "Pass" : r.result === "flag" ? "Flag" : r.result })) }],
      speakerNote: "Each result comes from the audit. A flag is something to fix; a pass is fine. For mobile speed the number is the PageSpeed mobile score.\n\nOptional slide: keep it for owners who like detail, drop it for owners who just want the answer.",
    };
  },

  numbers: (c) => {
    const { notes } = c.input;
    if (!c.numbersShown || notes.avgJobValueCents === null || notes.missedJobsPerMonth === null || c.atStake === null) return null;
    return {
      key: "numbers", title: "What this could be costing you.",
      blocks: [
        eyebrow("Your numbers"),
        { type: "stat", value: String(notes.missedJobsPerMonth), label: "jobs a month that don't get through, your estimate" },
        { type: "stat", value: dollars(notes.avgJobValueCents), label: "your average job", op: "times" },
        { type: "stat", value: dollars(c.atStake), label: "a month in jobs that could go elsewhere", op: "equals" },
        text("These are your numbers from our call. I don't promise a result; this is the size of the problem worth solving.", "fine"),
      ],
      speakerNote: "Only the numbers the owner gave you are on this slide. If they didn't give both, this slide is not in the deck and the math is never filled in for them.",
    };
  },

  recommendation: (c) => ({
    key: "recommendation", title: "My recommendation.",
    blocks: [
      eyebrow("The plan"),
      text(c.input.recap.recommendation, "quote"),
      ...(c.recommended ? [{ type: "list", heading: "What that includes", items: pricedItems(c, c.recommended).map((i) => ({ text: i.name })) } as DeckBlock] : []),
    ],
    speakerNote: "Say the recommendation out loud in one sentence before showing any prices. Then show only the package slides that match it.",
  }),

  quick_fix: (c) => {
    const s = c.price("quick_fix");
    if (!s || !c.inAnyOption("quick_fix")) return null;
    const inc = c.includes("quick_fix");
    return {
      key: "quick_fix", title: `${s.name}.`,
      blocks: [
        eyebrow(s.name),
        text("I fix the problems from your video review, then send you a short before-and-after video.", "lead"),
        ...(inc.length ? [{ type: "list", heading: "What's included", items: inc.map((t) => ({ text: t })) } as DeckBlock] : []),
        { type: "price", text: priceText(s), snapshot: snapshotFields(s) },
        text("Works on WordPress, Wix, Squarespace, and GoDaddy sites.", "fine"),
      ],
      speakerNote: "Use for every lead whose site mostly works. Say how long it will take once you have access, and only a turnaround you can hit on evenings and weekends.",
    };
  },

  care: (c) => {
    const key = c.inAnyOption("care", "care_plus");
    const s = key && c.price(key);
    if (!s || !key) return null;
    const inc = c.includes(key);
    const withQuickFix = c.options.some((o) => o.items.some((i) => i.key === "quick_fix") && o.items.some((i) => i.key === key));
    return {
      key: "care", title: `${s.name}.`,
      blocks: [
        eyebrow(s.name),
        text("I keep your WordPress site updated, backed up, and working, and you have one person to call.", "lead"),
        ...(inc.length ? [{ type: "list", heading: "What's included", items: inc.map((t) => ({ text: t })) } as DeckBlock] : []),
        { type: "price", text: priceText(s), snapshot: snapshotFields(s) },
        text("WordPress sites only.", "fine"),
        ...(withQuickFix ? [text("Most owners start Care right after the Quick Fix so the problems don't come back.", "fine")] : []),
      ],
      speakerNote: "Use for WordPress leads, especially sites years behind on updates (old versions are the urgent part). Check the edit hours in the list before you quote.",
    };
  },

  local_seo: (c) => {
    const key = c.inAnyOption("local_seo", "local_seo_growth");
    const s = key && c.price(key);
    if (!s || !key) return null;
    const inc = c.includes(key);
    return {
      key: "local_seo", title: `${s.name}.`,
      blocks: [
        eyebrow(s.name),
        text("Show up when people search for your service in your town.", "lead"),
        ...(inc.length ? [{ type: "list", heading: "What's included", items: inc.map((t) => ({ text: t })) } as DeckBlock] : []),
        { type: "price", text: priceText(s), snapshot: snapshotFields(s) },
        text("Pairs with Care on WordPress.", "fine"),
        text("I won't promise a ranking. I remove what makes it harder for Google to understand what you do and where.", "fine"),
      ],
      speakerNote: "Use when the owner's goal is more calls, not just a working site. Local SEO is its own line, never folded into the Care price. Don't promise a ranking.",
    };
  },

  new_site: () => ({
    key: "new_site", title: "How a new website comes together.",
    blocks: [
      eyebrow("New website"),
      { type: "list", numbered: true, items: [
        { title: "Strategy", text: "Kickoff call, page list, and the services and towns we target." },
        { title: "Design", text: "Homepage and one inner page. One round of changes, then your approval." },
        { title: "Build", text: "Every page built mobile-first, with tap-to-call, forms, and search basics." },
        { title: "Launch", text: "Testing on every device, redirects from your old pages, and go-live." },
      ] },
      text("How long it takes depends on how quickly content and approvals come back.", "fine"),
    ],
    speakerNote: "Use for leads whose site is under construction, rented from a platform, or too old to patch. Say the payment milestones that are in the agreement.",
  }),

  options: (c) => {
    if (c.options.length === 0) return null;
    return {
      key: "options", title: "Your options.",
      blocks: [eyebrow("Investment"), ...c.options.map((o, i) => optionBlock(c, o, i === 1))],
      speakerNote: "Three options, middle one recommended. For a site that is not WordPress there is no Care: show Quick Fix alone or Quick Fix with Local SEO.\n\nAfter this slide, ask the pre-close question: 'If this gets you closer to what you told me you wanted, is there anything other than the price that would stop us from starting?'",
    };
  },

  pay_new_site: (c) => {
    const keys = (["starter_site", "growth_site", "website_subscription"] as const).filter((k) => c.price(k) && c.inAnyOption(k) === k);
    if (keys.length === 0) return null;
    const TAGLINE: Partial<Record<PackageKey, string>> = {
      starter_site: "For owners who want to pay once and own the site.", website_subscription: "For owners who'd rather spread the cost out.",
    };
    return {
      key: "pay_new_site", title: keys.length === 2 ? "Two ways to pay for a new website." : "How you'd pay for a new website.",
      blocks: [
        eyebrow("Investment"),
        ...keys.map((k): DeckBlock => {
          const s = c.price(k)!;
          const o: Option = { id: "a", label: s.name, tagline: "", items: [{ key: k }], recommended: false };
          return optionBlock(c, { ...o, tagline: TAGLINE[k] ?? c.input.catalog.find((p) => p.key === k)?.summary ?? "" }, false, { includes: c.includes(k) });
        }),
      ],
      speakerNote: "New-site leads only. Check the payment terms in the list on each card against your agreement before you show this slide.",
    };
  },

  about: (c) => {
    const { settings } = c.input;
    const who = [settings.your_name, settings.role_title].map((s) => s.trim()).filter(Boolean).join(", ");
    const intro = settings.bio.trim() || who;
    return {
      key: "about", title: "Who you'd be working with.",
      blocks: [
        eyebrow("About"),
        ...(intro ? [text(intro, "lead")] : []),
        { type: "list", items: [
          { title: "Local", text: "Down the road, not a call center." },
          { title: "One person", text: "The person you talk to does the work." },
          { title: "Flat prices", text: "Listed up front, no surprises." },
        ] },
      ],
      speakerNote: "This slide's words come from the bio in Settings. Edit it there so every fact is true and current. Don't name your employer or use its client work here.",
    };
  },

  work: (c) => {
    const samples = c.input.samples.slice(0, 3);
    if (samples.length < 2) return null;
    return {
      key: "work", title: "Recent work.",
      blocks: [eyebrow("Work samples"), ...samples.map((s): DeckBlock => ({ type: "image", dataUri: s.imageDataUri, alt: s.name, title: s.name, text: s.blurb }))],
      speakerNote: "Only your own projects, with permission. No made-up results: if you don't have a number, describe what you did. This slide appears once you have at least two samples.",
    };
  },

  timeline: (c) => {
    const rec = c.recommended?.items.map((i) => i.key) ?? [];
    const site = rec.some((k) => k === "starter_site" || k === "growth_site" || k === "website_subscription") || c.input.recap.leadType === "new_site";
    const care = rec.some((k) => k === "care" || k === "care_plus");
    const seo = rec.some((k) => k === "local_seo" || k === "local_seo_growth");
    const rows: { title: string; text: string }[] = [
      { title: "Week 1", text: "Agreement, invoice, and access through a password manager. I back up your site before touching anything." },
    ];
    if (site) {
      rows.push({ title: "Strategy and design", text: "Page list, services and towns, then the homepage and one inner page. I check every change on a real phone." });
      rows.push({ title: "Build and launch", text: "Every page built mobile-first, tested on every device, then we go live with redirects from your old pages." });
    } else if (rec.includes("quick_fix") || rec.length === 0) {
      rows.push({ title: "Week 1 to 2", text: "I fix what we talked about. I check every change on a real phone." });
      rows.push({ title: "Week 2", text: "You get a short video of what changed, and a list." });
    }
    const monthly = [
      ...(care ? ["I keep your site updated, backed up, and working."] : []),
      ...(seo ? ["I do the local search work and send a short report in plain words."] : []),
    ];
    if (monthly.length) rows.push({ title: "Every month", text: monthly.join(" ") });
    return {
      key: "timeline", title: "What the first month looks like.",
      blocks: [eyebrow("Timeline"), { type: "list", items: rows }],
      speakerNote: "The rows match the option you are recommending. For a new site, replace the middle rows with the real dates once the agreement is signed.",
    };
  },

  next: () => ({
    key: "next", title: "Next steps.",
    blocks: [
      eyebrow("Getting started"),
      text("Questions, then the agreement and invoice. I'll set up access with you and we pick a start date together.", "lead"),
      { type: "list", numbered: true, items: [{ text: "Questions" }, { text: "Agreement + invoice" }, { text: "Access, safely" }, { text: "Kickoff" }] },
    ],
    speakerNote: "Ask for the business: 'Would you like me to start on this?' Have the agreement ready to send during the meeting. If they need to think, book the follow-up call before you hang up; don't leave it open-ended.",
  }),

  thanks: (c) => {
    const { settings } = c.input;
    const line = [settings.your_name.trim(), settings.contact_email.trim()].filter(Boolean).join("  ·  ");
    return { key: "thanks", title: "Thank you.", blocks: line ? [text(line, "lead")] : [], speakerNote: "Leave this up while you answer questions." };
  },
};

/** The deck for a deal: the slides its kind of lead keeps, in template order, minus any whose inputs are missing (never filled in with a guess). */
export function buildDeck(input: DeckInput): DeckSlide[] {
  const ctx = makeCtx(input);
  const keep = KEEP[input.recap.leadType] ?? KEEP.wp_few_broken;
  return DECK_ORDER.filter((k) => keep.includes(k)).map((k) => BUILD[k](ctx)).filter((s): s is DeckSlide => s !== null);
}

// ---- Inputs from the audit and the video plan -------------------------------------------------------------------------------------------------------------

const COSTS_CALLS = new Set<string>(["no_click_to_call", "no_phone_visible", "no_contact_path", "no_cta", "no_social_proof", "not_mobile_friendly", "no_viewport", "mobile_overflow", "small_text_mobile", "slow_mobile", "meh_mobile", "slow_lcp", "layout_shift", "broken_links", "no_https", "mixed_content", "no_https_redirect", "no_nav", "no_footer"]);
const OUT_OF_DATE = new Set<string>(["old_copyright", "stale_content", "past_events", "thin_homepage", "dated_build"]);
const HARDER_TO_FIND = new Set<string>(["no_title_or_meta", "no_h1", "no_schema", "no_local_schema", "no_open_graph", "images_missing_alt", "low_seo_score", "no_sitemap", "missing_niche_page"]);
const groupOf = (code: string | undefined): number => (!code ? 3 : COSTS_CALLS.has(code) ? 0 : OUT_OF_DATE.has(code) ? 1 : HARDER_TO_FIND.has(code) ? 2 : 3);

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  const first = t.split(/(?<=[.!?])\s/)[0] ?? t;
  const out = first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
  return out ? out[0].toUpperCase() + out.slice(1) : out;
};
const consequenceFor = (group: number) => CONSEQUENCE[PROBLEM_LABELS[group]] ?? "";

export interface PlanForDeck {
  shots: { id: string; previewKey: string }[];
  segments: { role: string; text: string; shotId: string; findingCode?: string }[];
}

/** The `problem` lines of a video plan with the screenshot each one shows (`previewKey`), in the plan's order. */
export function planProblems(plan: PlanForDeck | null): { code: string | undefined; text: string; shotId: string; previewKey: string | null }[] {
  return (plan?.segments ?? []).filter((s) => s.role === "problem").map((s) => ({
    code: s.findingCode, text: s.text, shotId: s.shotId, previewKey: plan?.shots.find((x) => x.id === s.shotId)?.previewKey ?? null,
  }));
}

/**
 * The three problems for the found slide: the video plan's three `problem` lines (so the meeting picks up where the video left off), ordered the way the
 * template shows them (costs calls, looks out of date, harder to find), each with its screenshot from `images` (by shot id). With no plan problems it is the
 * first three audit flags, without pictures.
 */
export function problemsOf(plan: PlanForDeck | null, findings: Pick<Finding, "code" | "evidence">[], images: Record<string, string | null> = {}): DeckInput["problems"] {
  const lines = planProblems(plan);
  if (lines.length > 0) {
    return lines.map((l, i) => ({ l, i, g: groupOf(l.code) })).sort((a, b) => a.g - b.g || a.i - b.i).slice(0, 3).map(({ l, g }) => ({
      title: oneLine(findings.find((f) => f.code === l.code)?.evidence || l.text, 140),
      consequence: consequenceFor(g), imageDataUri: images[l.shotId] ?? null, ...(g < 3 ? { label: PROBLEM_LABELS[g] } : {}),
    }));
  }
  return findings.slice(0, 3).map((f) => {
    const g = groupOf(f.code);
    return { title: oneLine(f.evidence, 140), consequence: consequenceFor(g), imageDataUri: null, ...(g < 3 ? { label: PROBLEM_LABELS[g] } : {}) };
  });
}

/**
 * The scorecard rows the audit can answer. A row the audit could not measure is left out (never guessed): the Google Business Profile is not audited, and a
 * platform nobody detected has no "platform + updates" row. Mobile speed shows the PageSpeed mobile score itself. A partial audit, or a site that could
 * not be reached, gives no scorecard at all (the slide is dropped): a check that did not run is never a pass.
 */
export function scorecardOf(a: Pick<Audit, "findings" | "pagespeed_mobile" | "https" | "broken_link_count" | "platform" | "partial" | "site_status">): DeckInput["scorecard"] {
  // A partial audit, or one where the site could not be read, measured too little: a row with no finding would say "pass" for something nobody checked.
  if (a.partial || a.site_status !== "ok") return [];
  const has = (...codes: string[]) => a.findings.some((f) => codes.includes(f.code));
  const rows: DeckInput["scorecard"] = [];
  rows.push({ label: "Phone test", result: has("no_click_to_call", "no_phone_visible", "no_contact_path") ? "flag" : "pass" });
  if (a.pagespeed_mobile !== null) rows.push({ label: "Mobile speed", result: String(Math.round(a.pagespeed_mobile)) });
  if (a.https !== null) rows.push({ label: "Security (https)", result: a.https && !has("no_https", "mixed_content") ? "pass" : "flag" });
  rows.push({ label: "Freshness", result: has("old_copyright", "stale_content", "past_events") ? "flag" : "pass" });
  if (a.platform !== null) rows.push({ label: "Platform + updates", result: has("dated_build") ? "flag" : "pass" });
  rows.push({ label: "Search basics", result: has("no_title_or_meta", "no_h1", "low_seo_score", "no_sitemap") ? "flag" : "pass" });
  if (a.broken_link_count !== null || has("broken_links")) rows.push({ label: "Broken links", result: (a.broken_link_count ?? 0) > 0 || has("broken_links") ? "flag" : "pass" });
  return rows;
}
