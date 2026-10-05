# CRO Audit — Design Spec

**Date:** 2026-10-04
**Status:** Approved in brainstorming, pending written-spec review
**Owner:** Logan Irish (single user)
**Builds on:** `2026-10-02-site-search-design.md`

## 1. Purpose

An on-demand, deeper scan for a single lead. From the lead detail page Logan clicks **Run CRO Audit**. The app works out how the business makes money, gathers evidence across the site's key pages, and produces a personalized conversion and strategy roadmap. That roadmap is a client-facing sales asset: specific changes, each backed by what was observed on *their* site, framed as work Logan can do for them.

The existing lead audit (one homepage pass, health score, AI review) is unchanged. The CRO audit is a separate, deeper layer that runs only when asked.

**Specific, not generic.** Instead of "improve your navigation", a recommendation looks like this: "Your header has 9 links and 'Financing' is buried under About. Move 'Get a Quote' into the header as a button and group the 6 service links under one Services menu."

**Success criteria:**
- One click produces a finished CRO audit in about 2–4 minutes for about $0.12–0.40.
- Every recommendation quotes or cites something real from the prospect's site. Uncited recommendations never reach the output.
- The inferred business model is shown as editable assumptions, and correcting it rebuilds the roadmap without re-crawling.
- The results appear in a CRO tab on the lead, are appended to the existing audit deck (HTML/PDF/Drive), and can be picked as focus items in the email drafter.

**Decisions made:**
| Topic | Decision |
|---|---|
| Audience | The prospect: a client-facing sales asset with "we can do this for you" framing |
| Evidence scope (v1) | Deep site capture only. No review mining, competitor benchmark, rank tracking or LLM-visibility checks (possible later layers). |
| Engine | Staged evidence pipeline (option B): deterministic evidence ledger → model inference → per-page reviews → synthesis with evidence-cited recommendations and code-computed priority |
| Models | Claude Haiku 4.5 by default for each stage; a stage moves to Claude Sonnet 5.5 where the eval shows Haiku falls short (§6) |
| Outputs | New CRO tab on lead detail; CRO chapter merged into the existing deck; CRO items selectable in the email drafter |
| Testing honesty | Most local sites lack traffic for A/B tests; default to "Just fix" / "Fix & measure", reserve "Test" for big swings |

**Out of scope for v1:**
- competitor capture
- review mining
- map-pack rank, SERP, or LLM-visibility checks
- an agent-driven persona walkthrough
- form submission of any kind
- ads-library lookups
- GA4 or Search Console data (owner-only; it's a natural paid follow-up)

## 2. Research basis

The design draws on two research passes:

**Website strategy / CRO practice.** Website strategists, CRO specialists and digital experience managers produce the same core deliverables:
- a roadmap (30/60/90 or Now/Next/Later)
- a KPI and tracking plan
- a prioritized backlog of hypotheses (fix vs. test vs. strategic)
- IA/navigation recommendations
- content gaps

The audit produces a small-business version of each.

**Frameworks applied as concrete checks:**
- **LIFT:** value proposition, relevance, clarity, urgency, anxiety, distraction
- **MECLABS:** motivation, value, incentive, friction, anxiety
- **Fogg B=MAP:** a prompt is present in every viewport; ability is not blocked
- **Cialdini:** social proof, authority, reciprocity, commitment
- **Nielsen heuristics**
- **Baymard** (e-commerce)
- **Jobs-to-be-Done**
- **StoryBrand:** customer as hero; "we/our" vs. "you/your"
- **Value Proposition Canvas:** specific, provable differentiators
- **PXL** binary prioritization

**Business model drives what "better" means.** There are six models, each with its own primary conversion, micro-conversions and high-leverage elements (§5.1).

**Evidence sources.** The most specific and persuasive evidence is free: what a real browser sees on the prospect's own site (CTA and form inventory, booking-flow click-through, martech detection, listing mismatches, accessibility, errors).

## 3. Architecture

```
LeadDetail → CRO tab ── POST /api/leads/:id/cro-audit
                              │ spend check, one running audit per lead
                              ▼
                     CroAuditWorkflow (one per run)
   1. capture     browser pass: home + up to 6 key pages, desktop & mobile → R2
   2. evidence    deterministic extractors → evidence ledger (D1)
   3. model       Claude: business model + assumptions
   4. pages       Claude vision, one call per page, in parallel
   5. synthesize  Claude: recommendations citing evidence → validator → PXL ranking → roadmap
                              │
                              ▼
          cro_audits + cro_items (D1) → CRO tab · deck chapter · drafter focus items
```

Each step stores its output, so a retry or re-run resumes from the stored result. A "Rebuild roadmap" after an assumption edit runs a workflow that starts at `model` (with overrides) or at `synthesize`. It reuses the stored capture and evidence.

### Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `cro/pages.ts` | Pick up to 6 key pages besides the homepage from the existing crawl's `site_links` and page kinds. Priority: contact/booking, services, shop/menu, about, pricing/financing, then others. | crawl results |
| `cro/capture.ts` | For each page, one Browser Rendering session at desktop (1440×900) and mobile (390×844, touch). Takes full-page JPEG screenshots, rendered HTML, in-page probe snapshot, axe-core results, console/request errors, and the network request log for martech. Runs the booking-flow probe on the primary CTA. | `BROWSER` binding, R2 |
| `cro/probe.ts` | In-page script returning a structured snapshot: CTAs, nav tree, forms, contact links, headings, hero text, trust elements, sticky header, overflow. Plus the booking-flow probe (≤4 clicks, never types, never submits). | none (runs in page) |
| `cro/evidence/*.ts` | Pure extractors, one per family (§4): `(snapshot, page, listing) → Evidence[]` | none |
| `cro/martech.ts` | Small rules table (about 40 vendors: analytics, tag managers, pixels, call tracking, chat, booking/ordering, CMS/builders) matched against scripts, globals and request URLs | none |
| `cro/models.ts` | Business-model matrix (§5.1) | none |
| `cro/catalog.ts` | Opportunity catalog (about 46 items, §5.4), tagged by model, area, impact, effort and default mode | none |
| `cro/prompts.ts` | System prompts and tool schemas for the three AI stages; checklist assembly per model and page kind | `models.ts`, `catalog.ts` |
| `cro/ai.ts` | Model caller (per-stage model from config; handles Haiku vs. Sonnet API differences, §6); zod validation; one retry | Anthropic API |
| `cro/validate.ts` | Drops issues and recommendations without valid evidence IDs or with quotes that don't appear in the captured text; enforces honest mode labels | none |
| `cro/pxl.ts` | Deterministic priority score, ranking, top-5 and 30/60/90 horizon assignment | none |
| `cro/scenario.ts` | Revenue scenario range math from editable inputs | none |
| `cro/config.ts` | Per-stage model IDs, page cap, click cap, timeouts, item cap | none |
| `CroAuditWorkflow` | Orchestrates the steps; records step and status; logs usage | all of the above |
| `routes/cro.ts` | Start, status, read, edit items, edit assumptions, rebuild, history | D1, workflow binding |
| `client/components/CroPanel.tsx` | CRO tab UI (§7) | API |

## 4. Evidence ledger

Each fact has a stable ID within the audit:

```ts
interface Evidence {
  id: string;            // "E12"
  page: string;          // URL
  family: EvidenceFamily;
  fact: string;          // plain-English line shown to Claude and in the evidence drawer
  data?: unknown;        // structured detail (counts, labels, ratios)
  device?: "desktop" | "mobile" | "both";
  crop?: { x: number; y: number; w: number; h: number; device: "desktop" | "mobile" }; // for screenshot callouts
}
```

| Family | Captures | Example |
|---|---|---|
| `cta` | Every button and link-as-button: text, position, above/below fold per device, size, contrast ratio, primary/secondary guess | `Mobile hero has 3 competing CTAs: "Learn More", "Our Services", "Contact"; none above the fold` |
| `nav` | Top-level items, depth, labels, location of high-intent pages (financing, pricing, booking, insurance), sticky header | `9 top-level nav items; "Financing" is nested under About` |
| `contact` | Phone as `tel:` link and its mobile header placement, email, hours, address | `Phone in header is plain text, not tappable` |
| `form` | Field count, required count, labels, input types, captcha, privacy note near submit | `Quote form has 11 fields incl. "Budget" and "How did you hear about us?"` |
| `flow` | Primary-CTA click-through: steps, off-domain hop, modal vs. page | `"Book Now" leaves to vagaro.com with no branding, 4 steps` |
| `trust` | Review widgets, testimonial count and attribution, badges/licenses, guarantee wording, years in business, stock-photo cues | `4 testimonials, unattributed, no dates` |
| `copy` | H1 and hero subhead verbatim, we/our vs. you/your ratio, generic phrases, service+city in H1/title | `H1 is "Welcome to Our Website"` |
| `martech` | Analytics, tag manager, pixels, call tracking, chat, booking/ordering vendor, CMS/builder | `No analytics or conversion tracking detected` |
| `listing` | Site NAP and hours vs. the stored Bright Data listing | `Site says Sat 9–5, Google says closed Sat` |
| `health` | axe critical/serious counts, console errors, failed requests, mobile overflow, small text | `Booking widget throws a JS error on mobile` |

**Rules:**
- A page that fails to load contributes no evidence and sets `partial = true`.
- Bot-block or challenge pages are detected (the existing `BLOCK_PROBE`) and never produce evidence.
- The flow probe runs only on same-site or known booking-vendor targets. It stops at the first form step, never types, never submits, and caps at 4 clicks / 15s.
- The captured visible text of each page is stored in R2. The validator checks quotes against it.

## 5. AI stages

All stages use tool-call output validated with zod. System prompts are stable and prompt-cached.

### 5.1 Stage 1 — business model inference (1 call)

**Input:** listing (name, category, address, rating, review count), evidence summary, homepage desktop and mobile screenshots, the business-model matrix.

**Output:**
```ts
interface BusinessModel {
  model: "lead_gen_phone" | "appointment" | "walk_in" | "ecommerce" | "b2b_consultative" | "membership";
  secondary_model: BusinessModel["model"] | null;
  primary_conversion: string;           // "Quote request or phone call"
  micro_conversions: string[];          // 2–4
  customer_jobs: string[];              // "Water heater failed, needs same-day fix"
  deal_value_band: { low: number; high: number; rationale: string; evidence_ids: string[] };
  sales_cycle: { label: string; rationale: string };
  traffic_tier: "low" | "medium" | "high"; // default low for local businesses
  confidence: "low" | "medium" | "high";
}
```

**Business-model matrix (`models.ts`):**

| Model | Primary conversion | Highest-leverage elements | Inference signals |
|---|---|---|---|
| `lead_gen_phone` | Call or quote request | Header phone/button, emergency signal, service area, reviews, financing | "Free estimate", service-area lists, 24/7, financing, license numbers |
| `appointment` | Booked appointment | Booking widget, insurance accepted, new-patient offer, provider bios | Zocdoc/Vagaro/Jane/Calendly etc., "Book now", insurance lists |
| `walk_in` | Reservation, order, directions | HTML menu, hours, address, reserve/order buttons, photos | OpenTable/Resy/Toast/DoorDash, menu, prominent hours |
| `ecommerce` | Purchase | Product page, shipping threshold, checkout, reviews | Cart, Shopify/Woo markup, product schema |
| `b2b_consultative` | Consultation booked | Case studies with numbers, process, fit qualifier, calendar booking | Case studies, "Schedule a consultation", industries served |
| `membership` | Enrollment or trial | Pricing transparency, trial/tour, schedule, outcomes | Tuition/membership tiers, class schedules, "Enroll", "Free trial" |

### 5.2 Stage 2 — page reviews (1 vision call per page, in parallel)

**Input:**
- the page's desktop and mobile screenshots
- that page's evidence lines
- the business model card
- a checklist assembled for the business model and page kind: LIFT, MECLABS friction/anxiety, Fogg prompt-per-viewport, Cialdini proof and authority, StoryBrand/JTBD copy checks, plus the relevant catalog items

**Output:**
```ts
interface PageReview {
  page: string;
  five_second_read: { thinks_business_does: string; would_do_next: string };
  strengths: string[];
  issues: {
    observation: string; quote: string | null; principle: string;
    evidence_ids: string[]; catalog_id: string | null; crop_evidence_id: string | null;
  }[]; // max 10
}
```

### 5.3 Stage 3 — synthesis (1 call)

**Input:** the business model (with any user overrides), all page-review issues and strengths, the evidence ledger, the catalog.

**Output:** up to 25 recommendations, plus `strengths` (max 6), `positioning` (what the site says now vs. what it should say), and `tracking_plan` (events to track for this model, each with a reason).

```ts
interface Recommendation {
  title: string;
  observation: string;      // what we saw, quoted where possible
  change: string;           // the exact change
  why: string;              // principle + business-model logic, plain English
  area: "header_nav" | "hero" | "services" | "trust" | "forms" | "booking" | "mobile" | "pricing_offer"
      | "content" | "local_seo" | "tracking" | "footer" | "technical" | "strategy";
  mode: "fix" | "fix_measure" | "test" | "strategic";
  impact: "high" | "medium" | "low";
  effort: "high" | "medium" | "low";
  evidence_ids: string[];   // at least 1, must exist
  catalog_id: string | null;
  we_can_do_it: string;     // one-line scope: "Quick fix: I'll rebuild the header with a call button and Quote button"
}
```

### 5.4 Opportunity catalog (`catalog.ts`)

Around 46 items from the research, each with `{id, title, models[], area, impact, effort, default_mode}`. Examples:
- click-to-call header phone
- header primary CTA button
- nav cut to 5–7 items
- promote buried high-intent pages
- specific hero headline (service + outcome + place)
- sticky mobile action bar
- multi-step quote form
- fewer form fields
- response-time promise
- embedded booking
- insurance near Book
- live review widget
- badges near CTAs
- risk reversal
- case studies / before–after
- one page per service
- service-area pages
- LocalBusiness/FAQ schema
- NAP consistency
- review-generation system
- pricing transparency
- financing framing
- packaged tiers
- entry offer
- positioning statement
- HTML menu instead of PDF
- direct online ordering
- guest checkout
- calendar booking for consultations
- lead magnet
- GA4/GTM event plan
- call tracking
- Core Web Vitals
- footer with hours, map and secondary CTA
- accessibility fixes

The catalog guides Claude; it is not a template. Recommendations must still cite site evidence.

### 5.5 Validation and ranking (code, not model)

1. **Evidence check:**
   - Drop any issue or recommendation whose `evidence_ids` is empty or references unknown IDs.
   - Drop any `quote` not found (case- and whitespace-insensitive) in the page's captured visible text.
   - If more than 40% of a stage's items are dropped, retry that call once with the rejection reasons, then keep the valid subset.
2. **Honest mode labels:** when `traffic_tier = "low"`, `test` becomes `fix_measure` unless `area ∈ {hero, pricing_offer, forms}` (the big swings).
3. **Tracking first:** if `martech` evidence shows no analytics and no call tracking, the tracking-plan recommendation is pinned to rank 1.
4. **PXL score:** one point per yes from these binary facts, derived from the item's evidence and fields:
   - above the fold on any device
   - on a high-intent page (home, contact, booking, services, pricing)
   - adds or removes friction (area ∈ forms/booking/header_nav/mobile)
   - backed by 2+ evidence items
   - effort = low
   - tied to the primary conversion (catalog item lists this model)
5. **Ranking:** order by `pxl_score × impact_weight` (high 3, medium 2, low 1), breaking ties by effort ascending. The top 5 become "Do this month". Of the rest, low/medium-effort items go to 60 and high-effort or strategic items go to 90. Cap at 25 items.

### 5.6 Revenue scenario (`scenario.ts`)

Code computes a range from editable inputs:
- monthly visitors (default by traffic tier: low 500, medium 2,000, high 8,000)
- current conversion rate (default 2%)
- target conversion rate (default 3%)
- close rate (default by model)
- deal value (from `deal_value_band`)

The output is added monthly leads and revenue as a low–high range. It is always labelled "Illustrative, based on the assumptions shown", and never states a promised lift percentage.

### 5.7 Prompt guardrails

- Client-facing text is in plain English with no jargon (no "CTA", "LCP", "CRO", "PXL").
- Medical, dental and legal sites get no outcome guarantees and no testimonial advice that conflicts with advertising rules.
- A bot-block, firewall or "access denied" page is never a finding.
- Strengths are required; the pitch is more credible when it acknowledges what works.
- Cookie banners, chat widgets and pop-ups are fair to judge.

## 6. Models

| Stage | Default | Config key |
|---|---|---|
| Business model | `claude-haiku-4-5` | `CRO_MODELS.model` |
| Page reviews | `claude-haiku-4-5` | `CRO_MODELS.pages` |
| Synthesis | `claude-haiku-4-5` | `CRO_MODELS.synthesize` |

**Policy:** stay on Haiku where it holds quality; move a stage to `claude-sonnet-5-5` where the eval shows Haiku falls short.

**Eval gate (`scripts/cro-eval.ts`, run before v1 is called done):**
- Run both models on 6 saved real sites covering at least 4 business models.
- Report per stage:
  - schema-failure rate
  - share of items dropped by the validator
  - share of recommendations with a verbatim quote
  - business-model agreement between the two models
- Write side-by-side outputs for Logan's blind read.
- A stage moves to Sonnet 5.5 if Haiku is worse by more than 10 points on the drop rate or the quote rate, or if Logan prefers Sonnet in the blind read on at least 4 of 6 sites.
- The chosen defaults are recorded in `config.ts` with a comment citing the eval date.

**API differences handled in `cro/ai.ts`:**
- **Haiku 4.5:**
  - no `output_config.effort` (rejected)
  - forced `tool_choice: {type: "tool"}` is allowed
  - prompt caching needs a system prompt of at least 4,096 tokens (ours, with rubrics, models and catalog, is larger)
  - 200K context
- **Sonnet 5.5:**
  - `tool_choice: auto` plus a prompt instruction (forced choice returns 400)
  - `output_config.effort: "medium"`, matching the existing reviewer

**Cost:** about $0.12–0.20 per scan if all stages stay on Haiku; up to about $0.40 if all use Sonnet. Logged to `usage` as service `claude_cro`; browser time is negligible.

## 7. Data model (migration `0006_cro.sql`)

**`cro_audits`** (history kept; latest = max `created_at` per business):
- `id`, `business_id`, `status` (`running|done|failed`), `step` (`capture|evidence|model|pages|synthesize|done`), `error`, `partial` (bool), `created_at`, `completed_at`
- `pages` (JSON `[{url, kind, r2_prefix}]`), `evidence` (JSON `Evidence[]`)
- `business_model` (JSON), `model_overrides` (JSON, user edits), `page_reviews` (JSON)
- `strengths` (JSON), `positioning` (JSON), `tracking_plan` (JSON), `scenario_inputs` (JSON)
- `models_used` (JSON), `est_cost_usd`

**`cro_items`:** `id`, `cro_audit_id`, `rank`, `horizon` (`30|60|90`), `title`, `observation`, `change`, `why`, `area`, `mode`, `impact`, `effort`, `evidence_ids` (JSON), `catalog_id`, `we_can_do_it`, `pxl_score`, `included` (bool, default true), `edited` (bool), `created_at`.

**R2:** `cro/<auditId>/<pageIndex>-{desktop,mobile}.jpg`, `cro/<auditId>/<pageIndex>.html`, `cro/<auditId>/<pageIndex>.txt` (visible text, used for quote checks).

**Rebuilding** replaces the audit's `cro_items`, but items with `edited = true` are kept and flagged "kept from your edits".

## 8. API

| Route | Purpose |
|---|---|
| `POST /api/leads/:id/cro-audit` | Start. 409 if one is running for the lead; 402 `{ error: "spend limit", ... }` via the existing `checkSpend` when the estimated cost would exceed the monthly limit. |
| `GET /api/leads/:id/cro-audit` | Latest audit with items (or `?audit=<id>`) |
| `GET /api/leads/:id/cro-audits` | History list |
| `PATCH /api/cro-items/:id` | Edit text, `included`, `rank`, `horizon`; sets `edited` |
| `PATCH /api/cro-audits/:id/assumptions` | Save `model_overrides` / `scenario_inputs` |
| `POST /api/cro-audits/:id/rebuild` | Re-run from `model` (if overrides changed the model) or `synthesize` |
| `GET /api/cro-audits/:id/shot/:page/:device` | Screenshot passthrough from R2 |

All routes use the existing session auth.

## 9. UI

**CRO Audit tab on `LeadDetail`** (`CroPanel.tsx`):
1. **Empty state:** "Run CRO Audit", with estimated cost and time.
2. **Running:** a stepper (Capture → Evidence → Business model → Page reviews → Roadmap), polled about every 3s.
3. **Done:**
   - **Business snapshot:** model, primary conversion, deal-value band, sales cycle, traffic tier as editable chips. Edits show "Rebuild roadmap".
   - **What works:** strengths.
   - **Do this month:** top-5 cards with an annotated screenshot crop (numbered marker from the evidence `crop`), observation, change, why, mode badge (Just fix / Fix & measure / Test / Strategic), impact/effort, and "we can do this" line.
   - **30/60/90 roadmap:** three columns of the remaining items.
   - **Positioning:** says now / should say.
   - **Tracking plan.**
   - **Revenue scenario:** editable inputs, live range, illustrative label.
   - **Evidence drawer:** the full ledger. Each item's evidence chips open the matching lines.
   - Each item supports inline edit, include/exclude for the deck and emails, and drag to reorder.
4. **History dropdown** for past CRO audits; ⚠ partial badge when pages failed.

## 10. Deck and drafter integration

**Deck:**
- When the lead has a completed CRO audit, `reportFor` loads it and `renderReport` appends a CRO chapter after the existing sections. The chapter contains:
  - snapshot (model + assumptions)
  - what works
  - one slide per top-5 item, with the screenshot crop and numbered callout
  - 30/60/90 roadmap
  - tracking plan
  - revenue scenario
  - "We can do this for you" scope summary
- Only `included` items are rendered. Screenshot crops are inlined as data URIs, like existing screenshots.
- The PDF and Drive export pick the chapter up with no changes to their own code.

**Email drafter:**
- The issue picker gains a "CRO opportunities" group of included items.
- `DraftInput.focus` accepts CRO items; each is passed to the prompt as `observation` → `change`.
- If more than half the focus items are CRO, the offer defaults to `conversion`.
- Existing drafter rules (no unsupported claims, plain English, word limits, verbatim compliance footer) still apply.

## 11. Error handling

- **Workflow steps:** 3 retries with exponential backoff.
  - `capture`: a single page failure skips that page and sets `partial`. If the homepage fails, the audit fails with "Couldn't load the site".
  - AI steps: on final failure the audit is `failed`, with `step` and `error` recorded. A "Retry" button resumes from the failed step using stored outputs.
- **AI output:** zod validation plus one retry. The evidence validator retries once when more than 40% of items are dropped. If synthesis yields fewer than 3 valid items, the audit completes with a warning rather than padding with generic advice.
- **Refusal:** `stop_reason: "refusal"` is treated as a failed step with a clear message.
- **Concurrency:** one running CRO audit per lead (409). Browser sessions are capped at 2 concurrent per workflow.
- **Cost guard:** the existing monthly spend check runs before start using the estimated cost. Actual token usage is logged after each AI step.
- **Safety:** the flow probe never types or submits, caps clicks, and only follows same-site or known booking-vendor links. The crawler user agent stays honest. Bot-block pages are never findings.

## 12. Testing

- **Unit (Vitest):**
  - each evidence extractor against saved HTML/snapshot fixtures (nav nesting, `tel:` detection, form field counts, generic-copy detection, NAP/hours mismatch, martech rules)
  - `pages.ts` selection
  - `validate.ts` (unknown IDs, fake quotes, mode rewriting at low traffic, tracking pin)
  - `pxl.ts` ranking and horizons
  - `scenario.ts` math
- **Prompt/tool schemas:** zod parse tests on recorded model outputs for both Haiku and Sonnet shapes.
- **Integration:** `CroAuditWorkflow` in `@cloudflare/vitest-pool-workers` with fake renderer and fake AI caller, covering:
  - the happy path
  - a page failure that sets `partial`
  - a homepage failure
  - an AI failure followed by retry from that step
  - rebuild from `synthesize`
- **Routes:** start (including 409 and spend block), item edits, assumption edits, rebuild.
- **Deck:** `renderReport` snapshot test with and without a CRO audit; only included items rendered.
- **Drafter:** CRO focus items appear in the prompt; the offer switches to `conversion`.
- **Eval gate:** `scripts/cro-eval.ts` (§6) decides the per-stage models.
- **Manual smoke test:** run on 3 real leads with different business models, then read every top-5 item and confirm it is specific and accurate.

## 13. Config and secrets

No new secrets; the existing `ANTHROPIC_API_KEY` and `BROWSER` binding are reused. New workflow binding: `CRO_AUDIT_WORKFLOW` (`class_name: "CroAuditWorkflow"`). Tunables (models, page cap 7 including home, click cap 4, item cap 25, timeouts) live in `src/worker/cro/config.ts`.

## 14. Future layers (not v1)

Each would add new evidence families feeding the same pipeline:
- review mining
- competitor benchmark (top 3 from the same search)
- local map-pack rank
- LLM-visibility check
- Wayback redesign history
- an agent-driven persona walkthrough step
