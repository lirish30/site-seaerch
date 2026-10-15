# Job watch

Job watch reads the public job board of every lead that has a careers page on **Greenhouse, Lever or Ashby**, and tells you when a role in web, design, SEO, CRO or marketing appears or stays open. It runs every six hours (cron `37 */6 * * *`) and never contacts anyone: it only fills the **Jobs** page, each lead's **Open roles** card, and the **Hiring** items on **Today**.

## What it needs

A lead only gets a board if (1) it has been scanned (quick or full) and (2) its site links to a careers page that either is, or embeds, a Greenhouse, Lever or Ashby board. Most plumbers and dentists have neither, so the watcher is only as good as the companies you give it.

## Feeding it companies that hire for your field

- **Import** (the Import page): paste a website address, or paste or upload a CSV with a header row (`name`, `website`, optionally `address`, `phone`, `category`) of marketing agencies, software and SaaS companies, ecommerce brands and web studios. A quick scan starts for each; boards are found on the next six-hour tick.
- **New search** (the first page) and **Radar** (saved searches that re-run on their own): search for "marketing agency", "web design agency" or "software company" in a city you would work in.
- A lead's **Open roles → Check now** finds its board immediately instead of waiting for the tick.
- **Jobs → Check boards now** runs a full tick in the background.

## How to read it

- *Posted N days ago* comes from the board. *First seen N days ago* means the board gave no date and we noticed it after our first look. *Age unknown* means it was already there when we first looked, so we say nothing about how old it is.
- *Hiring* on Today appears for leads you have not contacted yet, when a role is 3 days old or less (reach out now) or has been open 30 days or more (they have a problem you can pitch against).
- A role counts as open (on Today, the Jobs page, a lead's Open roles card and in drafts) only if the board showed it within the last 48 hours. If a board is unreachable for more than 2 days, its roles drop off those lists until it answers again.
- A drafted email may mention a role only if the board showed it within the last 48 hours; the model is told to use the exact title and nothing else about the role. To write a draft without the role, send `{"usePosting": false}` to `POST /api/leads/:id/regenerate`.
- A one-click rewrite of a draft ("shorter", "warmer", ...) only keeps a role mention that the draft already contains; it never adds one.

## Limits

- Only three boards are read. Workable, Recruitee, BambooHR, Breezy and others are not yet.
- One empty answer from a board does not close its roles; two in a row do.
- A careers page that answers with a server error or "too many requests" is retried the next day; any other failure (for example a 403 or 404) is not retried for 30 days. Use **Check now** on a lead to force a look.
- Boards of archived leads are still polled (they count toward the 40 boards per run); archive-aware polling is not built.
- We do not know how much earlier this is than LinkedIn. `first_seen_at` is stored so you can compare it with a role's posting time on LinkedIn for a few weeks and find out.
