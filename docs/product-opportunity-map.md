# Site Search: product opportunity map

**Reviewed:** 2026-10-04  
**Purpose:** Find better website-project prospects, make a credible case for the right service, win the work, and turn projects into long-term client relationships.

## What I reviewed

This is a static review of the `site-search-v2` checkout, its database migrations, routes, UI, audit and CRO pipelines, plus [LoganIrish.com](https://loganirish.com/) and its six service pages. I did not inspect production data or run the app. “Missing” below means I did not find an end-to-end feature in this checkout; it does not prove it has never existed in another deployment.

**Repository caveat:** The checkout is in an unresolved merge. There are 43 conflict blocks across 18 files under `src`, including the lead detail page, search form, worker entry point, lead pipeline, and scorer; additional test and documentation files are also unmerged. The competing sides include CRO/Google integration and radar/public-report work. Their files and routes exist, but this checkout cannot be treated as a working release until the conflicts are resolved. Address this before feature implementation. The relevant entry point is [`src/worker/index.ts`](../src/worker/index.ts), and the most important affected paths are [`src/worker/pipeline/lead.ts`](../src/worker/pipeline/lead.ts), [`src/worker/scoring/scorer.ts`](../src/worker/scoring/scorer.ts), and [`src/client/pages/LeadDetail.tsx`](../src/client/pages/LeadDetail.tsx).

## Current product, as represented in source

| Area | Already present or in progress | Evidence |
|---|---|---|
| Discovery | Bright Data Google Maps search by business type and location, deduplication by place ID/domain, a spend estimate and monthly cap. A recurring search radar is coded, but its worker wiring is in the conflict. | [`brightdata.ts`](../src/worker/listings/brightdata.ts), [`businesses.ts`](../src/worker/db/businesses.ts), [`radar.ts`](../src/worker/routes/radar.ts) |
| Initial audit | Crawls key pages, captures desktop/mobile, runs PageSpeed, applies niche rules and AI review, then generates website health and opportunity scores. The scorer and pipeline currently have conflicting versions. | [`lead.ts`](../src/worker/pipeline/lead.ts), [`rubrics.ts`](../src/worker/audit/rubrics.ts), [`scorer.ts`](../src/worker/scoring/scorer.ts) |
| Deep CRO | On-demand capture of up to seven pages, observable evidence, business-model inference, page reviews, a ranked 30/60/90-day roadmap, editable assumptions and a revenue scenario. It already records an axe accessibility summary, marketing tools, CTA paths and some listing mismatches. | [`cro/pipeline.ts`](../src/worker/cro/pipeline.ts), [`cro/evidence`](../src/worker/cro/evidence), [`CroPanel.tsx`](../src/client/components/CroPanel.tsx) |
| Outreach | AI email drafting from findings, tone and focus controls, manual editing, draft history, Gmail draft creation, and Google Drive export. It creates drafts; the app does not send mail. | [`drafter/prompt.ts`](../src/worker/drafter/prompt.ts), [`routes/leads.ts`](../src/worker/routes/leads.ts) |
| Sales records | Status, notes, follow-up date, deal value, people/point of contact, activity, archive and delete. A public report-link feature is coded, but its integration is part of the unresolved merge. | [`0003_crm.sql`](../migrations/0003_crm.sql), [`routes/leads.ts`](../src/worker/routes/leads.ts), [`routes/public.ts`](../src/worker/routes/public.ts) |
| Sales material | HTML/PDF audit deck with a proposed offer and CRO chapter. This is not yet a scoped, priced proposal or statement of work. | [`report/html.ts`](../src/worker/report/html.ts), [`report/cro.ts`](../src/worker/report/cro.ts) |

The best differentiator is an **evidence-to-service path**: a public observation becomes a verified issue, the issue maps to a service Logan offers, and that service becomes a specific sales asset and later a measured project. The portfolio already describes management, operations, CRO, SEO/AI visibility, front-end development, and design. The app's current offer enum is much narrower.

## Priority guide

- **P1 — Build soon:** Directly improves prospect quality, sales conversion or daily throughput with the current product model.
- **P2 — Expand:** Strong service fit, but needs a new data source, deeper analysis or more workflow design.
- **P3 — Later:** Valuable after usage and outcome data show demand, or when client access and a larger user base justify it.

The effort labels are directional implementation sizes, not estimates. `S` is a focused change, `M` crosses a few screens/services, and `L` introduces a new workflow or integration.

## Feature opportunities

### 1. Decide which work to sell

1. **[P1, M] Ideal-client and service rules.** Let Logan define preferred industries, geography, company size proxies, platforms, and project types. Each lead gets a transparent “fit for me” score separate from website health and opportunity. First slice: three saved service profiles, such as WordPress care, CRO, and redesign.
2. **[P1, M] Explainable score with confidence.** Show the facts behind every score and how recent/reliable each fact is. Keep “site quality,” “business fit,” and “urgency” separate; a broken crawler must not make a good prospect look bad. First slice: evidence source, timestamp and uncertainty on the top five findings.
3. **[P1, M] Turn findings into sellable work.** Map each issue to Logan's actual services, likely deliverables, prerequisites, and a sensible first engagement. For example, a slow WordPress site maps to a performance audit and care plan, while a confusing booking path maps to a CRO project. First slice: a small editable service catalog and a “best first offer” card.
4. **[P2, M] Learn from corrected scores and won/lost deals.** Record why Logan dismisses an issue, changes priority, wins, or loses. Review false positives and useful pitch angles by industry before changing weights; never auto-adjust the scoring model from a few outcomes. First slice: a reason picker on score corrections and a monthly calibration view.
5. **[P1, S] Two-stage audit spending.** Run an inexpensive listing/site precheck first; spend browser and AI budget on leads above a fit threshold or selected manually. Preserve the ability to audit any lead. First slice: a “quick scan” status and a queue of promising leads for the existing deeper scan.

### 2. Find and qualify prospects

6. **[P1, S] Add leads by URL or CSV.** Bring in referrals, networking leads, conference lists, and manually found sites without faking a Maps search. Match by place ID, domain and business name, then request review on ambiguous matches.
7. **[P1, M] Suppression and ownership lists.** Exclude current clients, past opt-outs, competitors and accounts already in an active sales process from searches and automations. Tag territories and assigned owners if the tool expands beyond one user.
8. **[P1, M] Change alerts for known leads.** Extend the recurring search radar into a lead watchlist: a site goes down, the home page changes, an offer disappears, a contact path breaks, or the business opens another location. Send one meaningful digest with before/after evidence, rather than repeat every unchanged finding.
9. **[P2, M] Comparable peer set.** For each prospect, choose 3–5 nearby businesses in the same niche and business model. Compare only objective items such as mobile speed, booking availability, service pages and visible trust cues; keep the peer selection editable.
10. **[P2, M] Growth-signal queue.** Surface businesses with a new location, fresh hiring, rising review count, a new service line, or a recently changed website. These signals can indicate an active marketing budget and a timely reason to talk. Each signal needs its source and date.
11. **[P2, L] Ads-to-site mismatch.** Find businesses paying to send traffic to a slow, broken or weak landing page, where the cost of friction is easier to discuss. Start with public ad libraries or ad-visible SERPs and validate the actual destination before making a claim.
12. **[P2, M] Multi-location account view.** Group branches under a parent brand while keeping location-specific pages, reviews and contacts distinct. Pitch a system-wide design/operations project when the same problem recurs across locations.
13. **[P3, M] Market coverage map.** Show how many businesses have been scanned by town, vertical, score band and likely service, plus unexplored markets. The point is to help Logan choose the next search, not to add a dashboard for its own sake.

### 3. Diagnose more of the website opportunity

14. **[P1, M] Technical SEO site map.** Go beyond the current sampled-page basics: sitemap and robots discovery, canonical/indexability checks, redirects, orphaned or duplicate page patterns, internal-link depth, and template-level title/H1 problems. Distinguish observed facts from Google index status, which needs owner access.
15. **[P1, M] Local search consistency.** Compare the Maps listing, site, contact page and visible structured data for name, address, phone, hours, service areas and booking URL. The CRO evidence layer has an initial listing comparison; make it a focused local SEO report with exact mismatched fields.
16. **[P2, S] Real-user performance view.** Add Chrome UX Report field data beside the existing PageSpeed lab score, including phone/desktop and page/origin labels. Mark “insufficient field data” plainly for smaller sites; never fill the gap with a guess.
17. **[P1, M] Accessibility remediation plan.** Turn the existing axe summary into a page-level worklist with screenshots, affected templates, likely fixes and a manual QA checklist. Do not call an automated scan a complete WCAG audit.
18. **[P1, M] Public WordPress opportunity scan.** Where the CMS is confidently detected, look for observable maintenance risks such as broken assets, exposed old version clues, stale content and performance-heavy plugins. Avoid claiming a specific plugin is vulnerable without verified version evidence.
19. **[P2, L] Connected WordPress care audit.** After a prospect becomes a client and grants access, inspect Site Health, core/theme/plugin updates, backup state, scheduled jobs, admin hygiene and staging. Turn the result into a recurring care plan and prioritized work list.
20. **[P2, M] Domain and hosting care checks.** Track certificate expiry, redirect/canonical behavior, DNS changes, security headers, availability and email-authentication records when they are relevant to Logan's operations offer. Public observations should not claim the whole site is secure.
21. **[P2, M] AI answer readiness.** Review crawl access, indexability, structured data, clear service descriptions, author/business identity, answerable FAQ content and citation-friendly pages. Keep “likely improvement” distinct from measured AI citations.
22. **[P2, M] Content and information architecture gap map.** Compare the prospect's services, locations, customer questions and navigation with its actual pages. Produce a proposed page map and content brief, with each new page tied to a buyer need instead of making thin location pages.
23. **[P2, M] Design-system consistency audit.** Compare a small set of templates for type scale, button hierarchy, spacing, photography, logo usage and mobile behavior. Present annotated examples of inconsistency; avoid a single subjective “design score.”
24. **[P1, M] User-task walkthroughs.** Extend the existing primary-CTA probe into named tasks such as “request a quote,” “book an appointment,” or “find emergency service.” Measure steps, dead ends, friction and handoffs across the key pages without submitting public forms.
25. **[P2, L] Lead-leakage check after permission.** With a client's test inbox and consent, submit synthetic form/booking enquiries, check receipt, spam placement, confirmation page and notification routing. This gives an unusually concrete maintenance/CRO offer but requires client-controlled access.
26. **[P2, M] Third-party burden analysis.** The CRO layer already recognizes analytics, chat and booking vendors. Attribute excess bytes, blocking requests, console errors and slow interactions to specific integrations, then suggest fixes that preserve the business function.
27. **[P2, M] Review theme research.** Summarize public, source-attributed complaints and praise to find website copy, trust and FAQ gaps. Do not treat the star rating alone as the business's budget or as proof of website failure.
28. **[P3, L] Commerce and complex booking journeys.** For ecommerce and appointment businesses, follow product/category, cart or booking steps in a non-transactional browser session. Record mobile friction, unexpected fees, guest-checkout barriers and third-party handoffs; never place an order on a prospect site.

### 4. Use client-authorized data for a more defensible audit

29. **[P2, L] Search Console connection.** When the site owner grants read access, add query/page performance, indexing and sitemap evidence. This turns a public SEO hypothesis into a real opportunity brief. Keep prospect scans public-only until authorization.
30. **[P2, L] GA4 conversion diagnosis.** With the client's permission, bring in landing-page, channel, device and key-event data. Replace generic revenue scenarios with observed funnel baselines and show unknowns when tracking is incomplete.
31. **[P2, M] Measurement readiness audit.** Compare the site's visible tracking tools with the events needed for its business model, then produce a GA4/GTM/call/booking measurement plan. The current CRO report proposes events; this would verify whether they fire and count correctly after access is granted.

### 5. Make outreach and sales material better

32. **[P1, S] One-page evidence teaser.** Produce a short, prospect-safe view with one screenshot, 2–3 verified issues, a strength, and the specific service Logan would offer. Use this before the full deck; make every claim link back to observed evidence.
33. **[P1, M] Case-study matching.** Select the closest relevant project from Logan's portfolio by business model and service need, then include one factual sentence and link in the email or report. Allow Logan to curate claims and measurable results before reuse.
34. **[P1, M] Scoped proposal builder.** Turn selected audit items into a discovery scope, deliverables, exclusions, timeline assumptions, optional care plan and price range set by Logan. The existing deck says “proposal,” but it does not produce a scoped commercial proposal.
35. **[P2, M] Outreach angle variants.** Draft a small set of distinct evidence-based angles: conversion loss, technical risk, design credibility, local visibility or ongoing care. Track which angle Logan chose and whether a reply came, without claiming causal uplift from tiny samples.
36. **[P1, M] Human-approved follow-up sequence.** Create 2–3 follow-up drafts with new value each time and a task date. Respect opt-outs and stop the sequence when a reply is logged. Keep approval at send time, consistent with the app's current draft-first posture.
37. **[P1, L] Gmail conversation sync.** Read back sent messages and replies from the connected account, match them to leads, update activity and present the next action. Start read-only; avoid silently changing lead stages when a thread match is uncertain.
38. **[P2, M] Better recipient intelligence.** Expand source-attributed people research, role relevance, and email confidence so the first pitch reaches an owner or marketing decision maker. Do not guess or invent addresses; keep manual correction prominent.
39. **[P2, L] Fast visual concept.** Generate a reviewable hero/CTA or page wireframe from the audited evidence and Logan's design style. This can make a redesign pitch tangible, but it should be opt-in and edited before a prospect sees it.
40. **[P2, M] Inbound self-audit on LoganIrish.com.** Let visitors request a limited audit of their own site and book a consultation. Route the submitted business into the same lead record, with consent and source attribution.

### 6. Make the light CRM useful every day

41. **[P1, S] Next-action queue.** Combine follow-up date, unanswered drafts, replies, recent change alerts and stalled deals into one “today” list. The existing follow-up date needs an active work surface to prevent leads from going cold.
42. **[P1, M] Batch triage.** Allow selection and bulk status/tag/archive/assign-actions after a search, plus saved filters. Keep destructive actions reversible where possible. This matters once a search yields dozens of low-fit results.
43. **[P2, M] Sales board and stage criteria.** Show a compact pipeline from researched to contacted, conversation, proposal, won/lost. Require a next step and amount only at the stages where those fields help; avoid forcing a heavy CRM on a solo operator.
44. **[P2, M] Discovery-call brief.** Assemble business facts, top evidence, likely service, open questions, relevant portfolio proof and access needed for a deeper assessment into a one-page meeting note.
45. **[P2, M] Reply and objection library.** Save the reasons prospects respond, pass, defer or dispute an audit claim. Use these to refine copy and service offers; retain the exact conversation rather than only a status label.
46. **[P2, M] Source-to-revenue view.** Trace search, niche, score, offer, email angle and service sold through to deal value and time spent. Optimize for qualified conversations and won work, not the number of weak sites found.

### 7. Turn one-off projects into ongoing relationships

47. **[P2, M] Client onboarding handoff.** After “won,” create an access checklist, baseline capture, business goals, site owners, hosting/DNS inventory and a prioritized first-month plan. Keep credentials in an appropriate vault rather than in CRM notes.
48. **[P2, L] Maintenance monitor.** For client sites, schedule uptime, TLS, backups, updates, broken links, performance and lead-path checks. Alert Logan on meaningful regressions and produce a monthly change log.
49. **[P2, M] Roadmap execution tracker.** Convert CRO recommendations into actual tasks with owner, estimate, release date and verification result. Carry the original evidence into delivery so the sales promise and shipped work remain connected.
50. **[P2, L] Before-and-after results.** Store baselines for site health, Core Web Vitals, search, calls, forms and bookings where data exists. Show what changed after a release and what cannot yet be attributed to it; use approved results for case studies.
51. **[P3, M] Renewal and expansion prompts.** Use unresolved backlog items, new business goals, performance regressions and expiring care plans to propose the next useful project or retainer conversation.
52. **[P3, M] Referral workflow.** After a measured win, prepare a client-approved case study or referral request and record introductions as leads with their original source.

### 8. Product foundations for later scale

53. **[P2, M] Evidence history and change diff.** Keep immutable snapshots of scores, screenshots and facts so a re-audit shows what changed, what is new, and what was a false positive. This powers better alerts, outreach timing and before/after reporting.
54. **[P2, M] Export and integration layer.** CSV export/import, a simple webhook or API, and connectors to the tools Logan already uses. Establish stable IDs and source timestamps before syncing to a larger CRM.
55. **[P3, L] Collaborative accounts.** If the product becomes an agency tool, add users, roles, shared leads, approval queues and per-account spend limits. The current app is intentionally a single-user personal tool, so this should wait for an actual second-user need.

## Recommended sequence

1. **Restore a trustworthy baseline.** Resolve the merge blocks, decide which radar/public-report and CRO/Google changes belong together, and confirm a clean build. Do not rank features against a source tree that cannot represent one running product.
2. **Make daily prospecting faster.** Build service-fit rules (#1), explainable evidence (#2), quick-scan spending (#5), imports (#6), batch triage (#42), and a next-action queue (#41). These improve the leads already in the database.
3. **Make the pitch distinctively Logan.** Add the service mapping (#3), one-page teaser (#32), portfolio case-study matching (#33), and a scoped proposal (#34). These translate an audit into work Logan can actually deliver.
4. **Add high-value verticals.** Start with local search (#15), task walkthroughs (#24), public WordPress opportunities (#18), and accessibility remediation (#17). Then add owner-authorized analytics/WordPress checks (#19, #29–31) when conversations justify them.
5. **Close the loop.** Add follow-up drafts (#36), conversation sync (#37), change alerts (#8), outcome calibration (#4), and source-to-revenue reporting (#46). This lets the product learn which signals produce clients.

## Design rules that protect credibility

- **Public scan vs. client-connected audit:** A public scan can observe a page, listing and published infrastructure. It cannot know real conversion rates, plugin update status, backups, form deliverability or Search Console data. Reserve those claims for connected audits.
- **Evidence before claims:** Keep URL, screenshot, date, method, and confidence with each issue. Phrase unknowns as questions or hypotheses, especially in cold outreach.
- **A score is a conversation aid:** Show both strengths and gaps. A high-quality site can still be a good CRO or management prospect; a poor-quality site can be a poor sales fit.
- **Keep an approval step on external outreach:** The current Gmail integration creates drafts. Follow-ups and personalization should preserve Logan's review before messages go to prospects.
- **Measure the business outcome:** Count qualified conversations, proposals and won projects by service. Raw lead volume and audit score are intermediate signals.

## Ideas I would defer

- **Fully automated cold-email sending.** The stronger immediate product is a reviewed outreach queue with reply tracking; sending more weak or inaccurate pitches would work against the evidence-first positioning.
- **A full general-purpose CRM.** The current status, people and activity model is enough to build a focused next-action workflow. Add broader CRM features only when a real sales process needs them.
- **One opaque “AI website score.”** The product already has health and opportunity concepts. More value comes from traceable evidence, service fit and score correction than from another blended number.
- **Claims of accessibility, security or revenue certainty from a public scan.** Public observations can prioritize follow-up work; formal assurance or ROI claims need human review and often client access.

## External implementation references

- Logan's [services](https://loganirish.com/) include website management, operations, CRO, SEO/AI visibility, development and design; the [CRO](https://loganirish.com/services/cro) and [operations](https://loganirish.com/services/operations) pages establish the strongest connected-data and recurring-care extensions.
- Google's [CrUX API](https://developer.chrome.com/docs/crux/guides/crux-api) provides origin/URL field data when the dataset has enough information; use an explicit unavailable state on small sites.
- [Search Console API authorization](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing) uses OAuth for site-owner data. The [GA4 Data API](https://developers.google.com/analytics/devguides/reporting/data/v1) can provide owner-authorized funnel metrics.
- The [Google Business Profile API](https://developers.google.com/my-business/content/location-data) lists locations associated with an authenticated account. Prospect scans should use the existing public listing source, while owner-connected updates belong in the client phase.
- [WCAG conformance guidance](https://www.w3.org/WAI/WCAG22/Understanding/conformance) calls for automated and human evaluation. WordPress provides its own [Site Health](https://wordpress.org/documentation/site-health/) checks for connected care workflows.
