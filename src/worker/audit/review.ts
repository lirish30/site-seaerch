import { z } from "zod";
import type { AiReview } from "../types";
import type { CrawlFacts } from "../scoring/scorer";
import type { QueuePart } from "../queue/registry";
import { NICHES, rubricText } from "./rubrics";

/** What the site review is shown. Screenshots are R2 keys: the queue delivers them to Claude as images. */
export interface ReviewInput {
  business: { name: string; category: string | null; address: string | null; website: string };
  facts: CrawlFacts | null;
  pagespeedScore: number | null;
  desktopKey: string | null;
  mobileKey: string | null;
}

const CATS = ["design", "content", "cro", "mobile", "technical"] as const;
const SEV = ["critical", "important", "nice"] as const;
const score = z.number().min(0).max(100);

/** The longest text Claude may send back in one field. Generous for real output; it only stops a runaway value from being stored and shown. */
const SHORT = 300, LONG = 1000;

/** The result schema of a `site.review` task: what Claude sends back with complete_claude_task. */
export const ReviewOutput = z.object({
  niche: z.string(),
  value_proposition: z.string().max(LONG),
  scores: z.object({ design: score, content: score, cro: score, mobile: score }),
  summaries: z.object({ design: z.string().max(LONG), content: z.string().max(LONG), cro: z.string().max(LONG), mobile: z.string().max(LONG) }),
  strengths: z.array(z.string()).max(6),
  niche_checklist: z.array(z.object({ item: z.string(), present: z.boolean() })).max(12),
  findings: z.array(z.object({
    category: z.enum(CATS), severity: z.enum(SEV), title: z.string().max(SHORT), evidence: z.string().max(LONG), recommendation: z.string().max(LONG),
  })).max(15),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

/** A niche Claude made up is "general", so the scorer and the drafter only ever see a niche they know. */
export function normalizeReview(raw: ReviewOutput): AiReview {
  return { ...raw, niche: raw.niche in NICHES ? raw.niche : "general" };
}

/** The fixed instructions of a `site.review` task. Nothing scraped ever goes in here. */
export const REVIEW_INSTRUCTIONS = `You are a senior web strategist and conversion designer auditing a small business website for a web developer who will pitch improvements to the owner.

Judge the site the way the business's customers would: does it look credible and current, is it obvious what they do, and is it easy to take the next step? Be fair: a well-designed, modern site should score high on design even if it loads slowly or lacks some content. Do not penalise design for speed; speed is measured separately.

Scoring guide (0-100): 90+ excellent, could be a template showcase; 75-89 good, modern and professional; 55-74 dated or generic but workable; 35-54 clearly outdated, cluttered or confusing; below 35 broken or amateur.
- design: visual quality from the screenshots: typography, color, imagery, whitespace, hierarchy, consistency, modernity.
- content: clarity of the value proposition, completeness for this niche, freshness, specificity.
- cro: how well the page drives the niche's main conversion: calls to action, contact paths, trust signals, friction.
- mobile: from the phone screenshot: readable text, tappable buttons, no clipped or overflowing layout, sensible order.

${rubricText()}

Rules:
- Pick the niche that best fits the business; use "general" only if none fit.
- Findings must be specific and grounded in what you can see in the screenshots or the facts provided. Quote visible text where useful. Never invent features you cannot see.
- Focus findings on design, content, conversion and mobile. The crawl facts are reported separately, so do not restate them (missing phone, no reviews text, HTTPS, titles, schema, broken links); add only what the screenshots reveal beyond them.
- Write for a business owner: plain English, no jargon (no "CTA", "LCP", "CRO", "above the fold" is fine).
- Cookie banners, chat widgets and pop-ups are fair to judge; a bot-check, firewall or "access denied" screen is our crawler being refused and is never a finding.
- Include genuine strengths: the pitch is more credible when it acknowledges what works.

Return the result with complete_claude_task.`;

/** Everything about the site that Claude is shown, in order: the screenshots it has, then the business and its crawl facts. All of it came from the site or its listing, so it is delivered as untrusted parts. */
export function buildReviewContent(i: ReviewInput): QueuePart[] {
  const f = i.facts;
  const facts = f ? [
    `Pages linked from the site: ${f.pageKinds.join(", ") || "none detected"}`,
    `Navigation menu: ${f.hasNav ? `yes (${f.navItemCount} links)` : "not found"}; footer: ${f.hasFooter ? "yes" : "not found"}`,
    `Contact form: ${f.hasContactForm ? "yes" : "no"}; emails found: ${f.emailCount}; booking/ordering widget: ${f.hasBooking ? "yes" : "no"}; phone on homepage: ${f.phoneVisible ? "yes" : "no"}`,
    `Reviews/testimonials text found: ${f.hasSocialProof ? "yes" : "no"}`,
    `Homepage word count: ${f.homeWordCount}; newest dated content: ${f.latestContentDate ?? "none found"}; copyright year: ${f.copyrightYear ?? "none"}`,
    `HTTPS: ${f.https ? "yes" : "no"}; structured data: ${f.schemaTypes.join(", ") || "none"}`,
  ].join("\n") : "The site could not be crawled; judge from the screenshots only.";
  const content: QueuePart[] = [];
  if (i.desktopKey) content.push({ type: "text", text: "Desktop screenshot (1280px wide, top of the homepage):" }, { type: "image", r2Key: i.desktopKey, mimeType: "image/jpeg" });
  if (i.mobileKey) content.push({ type: "text", text: "Phone screenshot (390px wide):" }, { type: "image", r2Key: i.mobileKey, mimeType: "image/jpeg" });
  content.push({ type: "text", text: `Business: ${i.business.name}
Google category: ${i.business.category ?? "unknown"}
Location: ${i.business.address ?? "unknown"}
Website: ${i.business.website}
Google mobile speed score: ${i.pagespeedScore ?? "not measured"}/100

Crawl facts:
${facts}` });
  return content;
}
