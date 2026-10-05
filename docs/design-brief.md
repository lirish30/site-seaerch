# Design brief: Site Search rebrand (for Claude Design)

## What the product is
A personal prospecting tool for a freelance web developer. It finds local businesses on Google Maps, audits each website (real-browser screenshots, AI design review, niche checklist, speed), scores it, and drafts a proposal-style cold email plus a branded PDF audit deck to send. One user, used daily at a desk; the PDF deck is what prospects see.

## Direction
Bright, colorful, fun, very visual, in the spirit of **Mixpanel, Hootsuite and Hotjar**: confident saturated brand color, playful accent colors per data category, generous rounded shapes, friendly illustration/blob accents, big readable numbers. The data still has to read instantly; color carries meaning (health bands, severity, categories), not just decoration. Light mode first; dark mode must still work.

## Name
"Site Search" is a placeholder. Explore a cooler name and wordmark. Starting candidates: **Leadlight**, **Sitescout**, **Pitchwise**, **Glowup**, **Spotlight Audit**, **Prospectra**. The name appears in the app nav, the browser title, and the PDF deck cover ("Prepared by …").

## Screens to design
1. **New search**: location, business-type multi-picker (chips + grouped grid), results-count segmented control with live cost, sticky submit bar, recent searches with progress.
2. **All leads**: dense data table (≈10 rows visible), mini half-circle health gauge per row, opportunity pill, industry, top issue (2-line clamp), contact/POC, status pill, follow-up date; search, filters, Active/Archived toggle, pagination.
3. **Lead detail**: header with link chips (website, maps, contact, careers…), actions (re-audit, score looks wrong, archive, delete); tabs: *Website audit* (large half-circle Site Health gauge, opportunity, niche, pitch, category bars, desktop+phone screenshots, strengths, niche checklist, findings grouped by category with severity filter) and *Email draft* (editor, earlier versions, tone override, issue picker). Side column: Export & share, Pipeline (status, follow-up, deal value, notes), People/POC, Contact details, Activity.
4. **Settings**: profile, email voice presets, Google connection, monthly usage.
5. **PDF audit deck** (16:9, 1280×720 per slide), the prospect-facing piece: cover, scorecard, first impressions (screenshots + strengths), one slide per category with every issue and its fix, "what a {niche} site needs" checklist, recommended package and next steps.

## Components
Half-circle gauge (large + mini), category score bar, severity pill (critical / important / nice to have), status pill (new, reviewed, contacted, replied, won, lost, skip), opportunity pill (hot / warm / cool), link chip, tag, tabs, segmented control, data table, finding row (dot + evidence + "→ fix"), checklist item (✓ / ✗), people row with POC badge, buttons (primary, default, danger, link).

## Tokens to hand back
Please return values for these CSS variables. They are already wired through the code, so a new design is a token swap plus component restyle.

**App (`src/client/styles.css`, `:root` + dark override):**
`--bg --fg --muted --line --card --hover --accent --accent-soft --link --bad --warn --ok`
`--good --fair --poor --none` (health bands: ≥70, 40–69, <40, unmeasured)
`--sev-critical --sev-important --sev-nice`
`--cat-design --cat-content --cat-cro --cat-mobile --cat-speed --cat-technical --cat-site`
`--radius --radius-sm --pill`, plus font family and type scale.

**Deck (`src/worker/report/html.ts`, `CSS` constant):**
`--ink --muted --paper --soft --line --brand --brand2 --brand3 --sun` plus the same health, severity and category tokens, and `--font`.

Also useful: logo/wordmark (SVG), favicon, and any illustration or blob shapes for the deck cover and proposal slide.
