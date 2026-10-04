import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AiReview } from "../types";
import type { CrawlFacts } from "../scoring/scorer";
import { NICHES, rubricText } from "./rubrics";

export const REVIEW_MODEL = "claude-sonnet-5-5";
export interface ReviewInput {
  business: { name: string; category: string | null; address: string | null; website: string };
  facts: CrawlFacts | null;
  pagespeedScore: number | null;
  desktopJpegB64: string | null;
  mobileJpegB64: string | null;
}
export type ReviewCaller = (p: { system: string; content: Anthropic.ContentBlockParam[] }) => Promise<unknown>;

const CATS = ["design", "content", "cro", "mobile", "technical"] as const;
const SEV = ["critical", "important", "nice"] as const;
const score = z.number().min(0).max(100);

const Output = z.object({
  niche: z.string(),
  value_proposition: z.string(),
  scores: z.object({ design: score, content: score, cro: score, mobile: score }),
  summaries: z.object({ design: z.string(), content: z.string(), cro: z.string(), mobile: z.string() }),
  strengths: z.array(z.string()).max(6),
  niche_checklist: z.array(z.object({ item: z.string(), present: z.boolean() })).max(12),
  findings: z.array(z.object({
    category: z.enum(CATS), severity: z.enum(SEV), title: z.string(), evidence: z.string(), recommendation: z.string(),
  })).max(15),
});

const scoreProp = { type: "integer", minimum: 0, maximum: 100 };
const TOOL: Anthropic.Tool = {
  name: "submit_review",
  description: "Return the structured website review.",
  input_schema: {
    type: "object",
    properties: {
      niche: { type: "string", enum: Object.keys(NICHES) },
      value_proposition: { type: "string", description: "One sentence: what the site says the business does, for whom, where." },
      scores: { type: "object", properties: { design: scoreProp, content: scoreProp, cro: scoreProp, mobile: scoreProp },
        required: ["design", "content", "cro", "mobile"] },
      summaries: { type: "object", properties: { design: { type: "string" }, content: { type: "string" }, cro: { type: "string" }, mobile: { type: "string" } },
        required: ["design", "content", "cro", "mobile"] },
      strengths: { type: "array", items: { type: "string" }, maxItems: 6 },
      niche_checklist: { type: "array", maxItems: 12, items: { type: "object", properties: { item: { type: "string" }, present: { type: "boolean" } }, required: ["item", "present"] } },
      findings: { type: "array", maxItems: 15, items: { type: "object", properties: {
        category: { type: "string", enum: [...CATS] }, severity: { type: "string", enum: [...SEV] },
        title: { type: "string" }, evidence: { type: "string" }, recommendation: { type: "string" },
      }, required: ["category", "severity", "title", "evidence", "recommendation"] } },
    },
    required: ["niche", "value_proposition", "scores", "summaries", "strengths", "niche_checklist", "findings"],
  },
};

// Stable across leads so it can be prompt-cached.
const SYSTEM = `You are a senior web strategist and conversion designer auditing a small business website for a web developer who will pitch improvements to the owner.

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

Respond only by calling the submit_review tool.`;

export function buildReviewContent(i: ReviewInput): Anthropic.ContentBlockParam[] {
  const f = i.facts;
  const facts = f ? [
    `Pages linked from the site: ${f.pageKinds.join(", ") || "none detected"}`,
    `Navigation menu: ${f.hasNav ? `yes (${f.navItemCount} links)` : "not found"}; footer: ${f.hasFooter ? "yes" : "not found"}`,
    `Contact form: ${f.hasContactForm ? "yes" : "no"}; emails found: ${f.emailCount}; booking/ordering widget: ${f.hasBooking ? "yes" : "no"}; phone on homepage: ${f.phoneVisible ? "yes" : "no"}`,
    `Reviews/testimonials text found: ${f.hasSocialProof ? "yes" : "no"}`,
    `Homepage word count: ${f.homeWordCount}; newest dated content: ${f.latestContentDate ?? "none found"}; copyright year: ${f.copyrightYear ?? "none"}`,
    `HTTPS: ${f.https ? "yes" : "no"}; structured data: ${f.schemaTypes.join(", ") || "none"}`,
  ].join("\n") : "The site could not be crawled; judge from the screenshots only.";
  const content: Anthropic.ContentBlockParam[] = [];
  if (i.desktopJpegB64) content.push({ type: "text", text: "Desktop screenshot (1280px wide, top of the homepage):" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: i.desktopJpegB64 } });
  if (i.mobileJpegB64) content.push({ type: "text", text: "Phone screenshot (390px wide):" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: i.mobileJpegB64 } });
  content.push({ type: "text", text: `Business: ${i.business.name}
Google category: ${i.business.category ?? "unknown"}
Location: ${i.business.address ?? "unknown"}
Website: ${i.business.website}
Google mobile speed score: ${i.pagespeedScore ?? "not measured"}/100

Crawl facts:
${facts}` });
  return content;
}

export function anthropicReviewer(apiKey: string): ReviewCaller {
  const client = new Anthropic({ apiKey });
  return async ({ system, content }) => {
    const msg = await client.messages.create({
      // Forced tool_choice is rejected on Sonnet 5.5; the system prompt asks for the tool instead.
      model: REVIEW_MODEL, max_tokens: 8000,
      output_config: { effort: "medium" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [TOOL], tool_choice: { type: "auto" },
      messages: [{ role: "user", content }],
    });
    if (msg.stop_reason === "refusal") return null;
    const block = msg.content.find((b) => b.type === "tool_use");
    return block && "input" in block ? block.input : null;
  };
}

/** One structured review of the site; null when the model output is unusable twice. */
export async function reviewSite(i: ReviewInput, call: ReviewCaller): Promise<AiReview | null> {
  if (!i.desktopJpegB64 && !i.facts) return null;
  const content = buildReviewContent(i);
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = Output.safeParse(await call({ system: SYSTEM, content }));
    if (r.success) return { ...r.data, niche: r.data.niche in NICHES ? r.data.niche : "general" };
  }
  return null;
}
