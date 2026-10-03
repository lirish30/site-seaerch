# Site Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hosted, single-user Cloudflare app that finds local businesses by location + type, audits their websites, scores how much they need a web developer, and drafts a tailored outreach email for each.

**Architecture:** One Cloudflare Worker (Hono) serves a React SPA and a JSON API, stores data in D1 and raw audit payloads in R2. A `SearchWorkflow` pulls listings from Bright Data and starts one `LeadWorkflow` per business; each lead runs crawl → PageSpeed → score → draft as independently retried steps. All decision logic (scoring, recipient ranking, HTML extraction, prompt building) is pure functions with unit tests; workflows are thin adapters over a testable `runLead` / `runSearch` function.

**Tech Stack:** TypeScript, Cloudflare Workers + Workflows + D1 + R2, Wrangler 4, Hono 4, node-html-parser, @anthropic-ai/sdk, Zod, React 19 + Vite + @cloudflare/vite-plugin, Vitest + @cloudflare/vitest-pool-workers.

**Spec:** `docs/superpowers/specs/2026-10-02-site-search-design.md`

## Global Constraints

- Single user; auth is one password (`APP_PASSWORD` secret) → HMAC-signed session cookie (`SESSION_SECRET`).
- Never send email automatically. Drafts only.
- Email drafter model: `claude-sonnet-5-5`.
- Draft body < 120 words, plain text, max 3 findings cited, no jargon ("LCP", "CLS", "meta description"), ends with signature + physical address + opt-out line verbatim from settings.
- `max_results` default 50, hard cap 200.
- Score < 20 → "low priority", no auto-draft.
- Crawler: 10 s timeout per page, max 6 pages, user-agent `SiteSearchAudit/1.0 (+contact: <settings email or business_name>)`, HTML only.
- Workflow steps: 3 retries, exponential backoff.
- Scoring weights live only in `src/worker/scoring/config.ts`.
- Secrets: `APP_PASSWORD`, `SESSION_SECRET`, `BRIGHTDATA_API_KEY`, `BRIGHTDATA_SERP_ZONE`, `PAGESPEED_API_KEY`, `ANTHROPIC_API_KEY`.
- IDs are `crypto.randomUUID()`; timestamps are `new Date().toISOString()`.
- PageSpeed throttling (spec §8 "throttled through a queue") is implemented by `SearchWorkflow` starting lead workflows in batches of 5 with a 20 s `step.sleep` between batches, plus step-level retry on HTTP 429. No separate Cloudflare Queue.

## Review Focus

1. **Sites that redirect, block bots, or return non-HTML (403, Cloudflare challenge, PDF homepage)** → audit must finish with `site_status = "unreachable"` or a partial audit, never crash the lead. Pinned in Task 6.
2. **Listings with a website URL that is actually a Facebook/Yelp/Linktree page** → treat as `no_website` (they have no real site — a top lead), not as an audit of facebook.com. Pinned in Task 6.
3. **Same business returned twice in one search or across searches** → one `businesses` row, status preserved. Pinned in Task 2.
4. **Claude returns an email address that isn't in the contacts list, or omits the opt-out/address** → recipient rejected, footer appended. Pinned in Task 9.
5. **Obfuscated or junk emails (`name [at] domain [dot] com`, `example@example.com`, `@sentry.io`, image filenames like `logo@2x.png`)** → decoded or discarded. Pinned in Task 5.

---

## File Structure

```
site-search/
  package.json
  tsconfig.json
  wrangler.jsonc
  vite.config.ts                  # SPA build + @cloudflare/vite-plugin
  vitest.config.ts                # worker tests (pool-workers)
  migrations/0001_init.sql
  index.html
  src/
    worker/
      index.ts                    # Hono app, route mounting, exports workflows
      env.ts                      # Env type
      types.ts                    # shared domain types
      db/
        searches.ts
        businesses.ts
        audits.ts
        contacts.ts
        drafts.ts
        settings.ts
        usage.ts
      auth.ts                     # password check, cookie sign/verify, middleware
      scoring/
        config.ts                 # weights + thresholds
        scorer.ts                 # pure scoring
      recipient.ts                # pure contact ranking
      crawler/
        extract.ts                # pure HTML → facts
        crawl.ts                  # fetch orchestration (injected fetch)
      pagespeed.ts
      listings/
        source.ts                 # ListingSource interface + Listing type
        brightdata.ts
        fake.ts
      drafter/
        prompt.ts                 # pure prompt builder
        draft.ts                  # Claude call + validation
      cost.ts                     # cost estimates + spend guard
      pipeline/
        lead.ts                   # runLead(deps, step, businessId)
        search.ts                 # runSearch(deps, step, searchId)
      workflows.ts                # LeadWorkflow, SearchWorkflow classes
      routes/
        auth.ts
        searches.ts
        leads.ts
        settings.ts
    client/
      main.tsx
      App.tsx
      api.ts
      styles.css
      pages/
        Login.tsx
        NewSearch.tsx
        SearchDetail.tsx
        LeadDetail.tsx
        AllLeads.tsx
        Settings.tsx
  test/
    fixtures/html/*.html
    fixtures/brightdata-maps.json
    *.test.ts
  scripts/
    prompt-check.ts
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `vite.config.ts`, `index.html`, `.gitignore`, `.dev.vars.example`, `src/worker/env.ts`, `src/worker/index.ts`, `src/client/main.tsx`, `test/health.test.ts`, `test/env.d.ts`

**Interfaces:**
- Produces: `Env` type (bindings `DB: D1Database`, `RAW: R2Bucket`, `LEAD_WORKFLOW: Workflow`, `SEARCH_WORKFLOW: Workflow`, `ASSETS: Fetcher`, plus secret strings); default export Hono `app`; `GET /api/health → {ok:true}`.

- [ ] **Step 1: Init package and install deps**

```bash
cd "/Users/loganirish/Project Sites/site-search"
npm init -y
npm i hono zod node-html-parser @anthropic-ai/sdk react react-dom react-router-dom
npm i -D typescript wrangler vite @vitejs/plugin-react @cloudflare/vite-plugin vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types @types/react @types/react-dom tsx
```

Then set scripts in `package.json`:

```json
{
  "name": "site-search",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "deploy": "npm run build && wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "db:migrate:local": "wrangler d1 migrations apply site-search --local",
    "db:migrate:remote": "wrangler d1 migrations apply site-search --remote",
    "prompt-check": "tsx scripts/prompt-check.ts"
  }
}
```

(Keep the `dependencies`/`devDependencies` npm wrote.)

- [ ] **Step 2: Write config files**

`.gitignore`:
```
node_modules
dist
.wrangler
.dev.vars
```

`.dev.vars.example`:
```
APP_PASSWORD=change-me
SESSION_SECRET=generate-32-random-bytes-hex
BRIGHTDATA_API_KEY=
BRIGHTDATA_SERP_ZONE=
PAGESPEED_API_KEY=
ANTHROPIC_API_KEY=
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "noEmit": true
  },
  "include": ["src", "test", "scripts"]
}
```

`wrangler.jsonc` (create the D1 DB first with `npx wrangler d1 create site-search` and paste the id; create the bucket with `npx wrangler r2 bucket create site-search-raw`):
```jsonc
{
  "name": "site-search",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist/client",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "site-search", "database_id": "<paste id>", "migrations_dir": "migrations" }
  ],
  "r2_buckets": [{ "binding": "RAW", "bucket_name": "site-search-raw" }],
  "workflows": [
    { "name": "lead-workflow", "binding": "LEAD_WORKFLOW", "class_name": "LeadWorkflow" },
    { "name": "search-workflow", "binding": "SEARCH_WORKFLOW", "class_name": "SearchWorkflow" }
  ],
  "observability": { "enabled": true }
}
```

`vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({ plugins: [react(), cloudflare()] });
```

`vitest.config.ts`:
```ts
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              APP_PASSWORD: "test-pass",
              SESSION_SECRET: "test-secret-test-secret-test-secret",
              BRIGHTDATA_API_KEY: "x", BRIGHTDATA_SERP_ZONE: "x",
              PAGESPEED_API_KEY: "x", ANTHROPIC_API_KEY: "x",
            },
          },
        },
      },
    },
  };
});
```

`test/env.d.ts`:
```ts
declare module "cloudflare:test" {
  interface ProvidedEnv extends import("../src/worker/env").Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

`test/apply-migrations.ts`:
```ts
import { applyD1Migrations, env } from "cloudflare:test";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`migrations/0001_init.sql` — create as an empty file now (`-- schema added in Task 2`); Task 2 fills it.

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Site Search</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/client/main.tsx"></script>
  </body>
</html>
```

`src/client/main.tsx` (placeholder app replaced in Task 15):
```tsx
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<p>Site Search</p>);
```

- [ ] **Step 3: Write Env and worker entry**

`src/worker/env.ts`:
```ts
export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  ASSETS: Fetcher;
  LEAD_WORKFLOW: Workflow;
  SEARCH_WORKFLOW: Workflow;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  BRIGHTDATA_API_KEY: string;
  BRIGHTDATA_SERP_ZONE: string;
  PAGESPEED_API_KEY: string;
  ANTHROPIC_API_KEY: string;
}
```

`src/worker/index.ts`:
```ts
import { Hono } from "hono";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();
app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
```

(Workflow class exports are added in Task 12; until then remove the `workflows` block from `wrangler.jsonc` if wrangler complains about missing classes, and restore it in Task 12.)

- [ ] **Step 4: Write the failing test**

`test/health.test.ts`:
```ts
import { SELF } from "cloudflare:test";
import { it, expect } from "vitest";

it("GET /api/health returns ok", async () => {
  const res = await SELF.fetch("https://x/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS (1 test). If it fails on the empty migrations folder or missing workflow classes, fix config per the notes above, not the test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Cloudflare worker, vite SPA, vitest pool-workers"
```

---

### Task 2: D1 schema and data-access modules

**Files:**
- Modify: `migrations/0001_init.sql`
- Create: `src/worker/types.ts`, `src/worker/db/searches.ts`, `src/worker/db/businesses.ts`, `src/worker/db/audits.ts`, `src/worker/db/contacts.ts`, `src/worker/db/drafts.ts`, `src/worker/db/settings.ts`, `src/worker/db/usage.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Produces (all take `db: D1Database` first):
  - `createSearch(db, {location, businessType, radiusKm, maxResults}) → Promise<Search>`; `getSearch(db, id)`; `listSearches(db)`; `setSearchStatus(db, id, status, error?)`; `setFoundCount(db, id, n)`; `incrementProcessed(db, id)`
  - `upsertBusiness(db, listing: Listing, searchId) → Promise<Business>` (dedupe by `place_id`, then website domain; never changes `lead_status`); `getBusiness(db, id)`; `listBusinessesForSearch(db, searchId, {hideSkipped})`; `listAllBusinesses(db, {status?})`; `updateLead(db, id, {leadStatus?, notes?})`; `setBusinessError(db, id, msg|null)`
  - `insertAudit(db, AuditInsert) → Promise<Audit>`; `latestAudit(db, businessId) → Promise<Audit|null>`
  - `replaceContacts(db, businessId, ContactInput[]) → Promise<Contact[]>`; `listContacts(db, businessId)`
  - `insertDraft(db, DraftInsert) → Promise<Draft>`; `latestDraft(db, businessId)`; `updateDraftBody(db, id, {subject, body})`
  - `getSettings(db) → Promise<Settings>`; `saveSettings(db, Partial<Settings>)`
  - `recordUsage(db, service, units, estCostUsd)`; `monthUsage(db, month) → Promise<{service, units, est_cost_usd}[]>`
  - Types in `types.ts`: `LeadStatus`, `SiteStatus`, `Offer`, `Finding`, `Search`, `Business`, `Audit`, `Contact`, `ContactInput`, `Draft`, `Settings`, `Listing`.

- [ ] **Step 1: Write schema**

`migrations/0001_init.sql`:
```sql
CREATE TABLE searches (
  id TEXT PRIMARY KEY,
  location TEXT NOT NULL,
  business_type TEXT NOT NULL,
  radius_km REAL NOT NULL DEFAULT 15,
  max_results INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  found_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  place_id TEXT UNIQUE,
  domain TEXT,
  name TEXT NOT NULL,
  category TEXT,
  address TEXT,
  phone TEXT,
  website_url TEXT,
  maps_url TEXT,
  rating REAL,
  review_count INTEGER,
  first_seen_search_id TEXT,
  lead_status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  contacted_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_businesses_domain ON businesses(domain);
CREATE INDEX idx_businesses_status ON businesses(lead_status);

CREATE TABLE search_results (
  search_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  PRIMARY KEY (search_id, business_id)
);

CREATE TABLE audits (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  site_status TEXT NOT NULL,
  partial INTEGER NOT NULL DEFAULT 0,
  pagespeed_mobile INTEGER,
  lcp_ms INTEGER,
  cls REAL,
  mobile_friendly INTEGER,
  https INTEGER,
  has_title INTEGER,
  has_meta_description INTEGER,
  has_contact_form INTEGER,
  copyright_year INTEGER,
  latest_content_date TEXT,
  broken_link_count INTEGER,
  score INTEGER NOT NULL,
  offer TEXT NOT NULL,
  findings TEXT NOT NULL,
  raw_r2_key TEXT
);
CREATE INDEX idx_audits_business ON audits(business_id, created_at);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT,
  person_name TEXT,
  role TEXT,
  confidence REAL NOT NULL DEFAULT 0.5
);
CREATE INDEX idx_contacts_business ON contacts(business_id);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  audit_id TEXT,
  to_contact_id TEXT,
  recipient_reason TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  offer TEXT NOT NULL,
  steering_note TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_drafts_business ON drafts(business_id, created_at);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  your_name TEXT NOT NULL DEFAULT '',
  business_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  services_blurb TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  physical_address TEXT NOT NULL DEFAULT '',
  opt_out_line TEXT NOT NULL DEFAULT 'If you''d rather not hear from me, just reply "no thanks" and I won''t follow up.',
  tone_notes TEXT NOT NULL DEFAULT '',
  monthly_spend_limit_usd REAL NOT NULL DEFAULT 25
);
INSERT INTO settings (id) VALUES (1);

CREATE TABLE usage (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  service TEXT NOT NULL,
  units INTEGER NOT NULL,
  est_cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_month ON usage(month);
```

Note: `contact_email` (used in the crawler user-agent) and `businesses.domain` (dedupe key) are additions implied by the spec.

- [ ] **Step 2: Write shared types**

`src/worker/types.ts`:
```ts
export type LeadStatus = "new" | "reviewed" | "contacted" | "replied" | "won" | "lost" | "skip";
export type SiteStatus = "ok" | "no_website" | "unreachable" | "parked";
export type Offer = "new_site" | "performance" | "care_plan" | "seo_basics";
export type FindingGroup = "speed" | "stale" | "basics";
export type FindingCode =
  | "slow_mobile" | "meh_mobile" | "slow_lcp" | "layout_shift" | "not_mobile_friendly"
  | "old_copyright" | "stale_content" | "past_events" | "broken_links"
  | "no_https" | "no_title_or_meta" | "no_contact_form"
  | "no_website" | "site_unreachable" | "site_parked";

export interface Finding {
  code: FindingCode;
  group: FindingGroup | "site";
  severity: "high" | "medium" | "low";
  points: number;
  evidence: string;
}

export interface Listing {
  placeId: string | null;
  name: string;
  category: string | null;
  address: string | null;
  phone: string | null;
  websiteUrl: string | null;
  mapsUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
}

export interface Search {
  id: string; location: string; business_type: string; radius_km: number; max_results: number;
  status: "running" | "done" | "failed"; error: string | null;
  found_count: number; processed_count: number; created_at: string;
}

export interface Business {
  id: string; place_id: string | null; domain: string | null; name: string; category: string | null;
  address: string | null; phone: string | null; website_url: string | null; maps_url: string | null;
  rating: number | null; review_count: number | null; first_seen_search_id: string | null;
  lead_status: LeadStatus; notes: string | null; contacted_at: string | null; last_error: string | null;
  created_at: string;
}

export interface Audit {
  id: string; business_id: string; created_at: string; site_status: SiteStatus; partial: boolean;
  pagespeed_mobile: number | null; lcp_ms: number | null; cls: number | null; mobile_friendly: boolean | null;
  https: boolean | null; has_title: boolean | null; has_meta_description: boolean | null;
  has_contact_form: boolean | null; copyright_year: number | null; latest_content_date: string | null;
  broken_link_count: number | null; score: number; offer: Offer; findings: Finding[]; raw_r2_key: string | null;
}
export type AuditInsert = Omit<Audit, "id" | "created_at">;

export type ContactType = "email" | "form" | "phone" | "social";
export interface ContactInput {
  type: ContactType; value: string; source_url: string | null;
  person_name: string | null; role: string | null; confidence: number;
}
export interface Contact extends ContactInput { id: string; business_id: string; }

export interface Draft {
  id: string; business_id: string; audit_id: string | null; to_contact_id: string | null;
  recipient_reason: string; subject: string; body: string; offer: Offer;
  steering_note: string | null; edited: boolean; created_at: string;
}
export type DraftInsert = Omit<Draft, "id" | "created_at" | "edited">;

export interface Settings {
  your_name: string; business_name: string; contact_email: string; services_blurb: string;
  signature: string; physical_address: string; opt_out_line: string; tone_notes: string;
  monthly_spend_limit_usd: number;
}
```

- [ ] **Step 3: Write the failing tests**

`test/db.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSearch, getSearch, incrementProcessed } from "../src/worker/db/searches";
import { upsertBusiness, updateLead, listBusinessesForSearch } from "../src/worker/db/businesses";
import { insertAudit, latestAudit } from "../src/worker/db/audits";
import { replaceContacts, listContacts } from "../src/worker/db/contacts";
import { getSettings, saveSettings } from "../src/worker/db/settings";
import { recordUsage, monthUsage } from "../src/worker/db/usage";
import type { Listing } from "../src/worker/types";

const listing = (o: Partial<Listing> = {}): Listing => ({
  placeId: "p1", name: "Ace Plumbing", category: "Plumber", address: "1 Main St", phone: "555",
  websiteUrl: "https://aceplumbing.com/", mapsUrl: null, rating: 4.5, reviewCount: 10, ...o,
});

describe("db", () => {
  it("creates a search and increments progress", async () => {
    const s = await createSearch(env.DB, { location: "Boise, ID", businessType: "plumber", radiusKm: 15, maxResults: 50 });
    await incrementProcessed(env.DB, s.id);
    expect((await getSearch(env.DB, s.id))!.processed_count).toBe(1);
  });

  it("dedupes businesses by place_id and links to both searches", async () => {
    const s1 = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const s2 = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const a = await upsertBusiness(env.DB, listing(), s1.id);
    const b = await upsertBusiness(env.DB, listing(), s2.id);
    expect(b.id).toBe(a.id);
    expect(await listBusinessesForSearch(env.DB, s2.id, { hideSkipped: false })).toHaveLength(1);
  });

  it("dedupes by website domain when place_id is missing, ignoring www and path", async () => {
    const s = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const a = await upsertBusiness(env.DB, listing({ placeId: null, websiteUrl: "http://www.dom-x.com/home" }), s.id);
    const b = await upsertBusiness(env.DB, listing({ placeId: null, websiteUrl: "https://dom-x.com" }), s.id);
    expect(b.id).toBe(a.id);
  });

  it("re-upsert does not reset lead status; skip hides from search list", async () => {
    const s = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const a = await upsertBusiness(env.DB, listing({ placeId: "p-skip" }), s.id);
    await updateLead(env.DB, a.id, { leadStatus: "skip" });
    const again = await upsertBusiness(env.DB, listing({ placeId: "p-skip" }), s.id);
    expect(again.lead_status).toBe("skip");
    expect(await listBusinessesForSearch(env.DB, s.id, { hideSkipped: true })).toHaveLength(0);
  });

  it("marks contacted_at when status becomes contacted", async () => {
    const s = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const a = await upsertBusiness(env.DB, listing({ placeId: "p-c" }), s.id);
    const u = await updateLead(env.DB, a.id, { leadStatus: "contacted" });
    expect(u.contacted_at).not.toBeNull();
  });

  it("stores audits with findings JSON and returns latest", async () => {
    const s = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "p-a" }), s.id);
    await insertAudit(env.DB, {
      business_id: b.id, site_status: "ok", partial: false, pagespeed_mobile: 40, lcp_ms: 5000, cls: 0.1,
      mobile_friendly: true, https: true, has_title: true, has_meta_description: false, has_contact_form: true,
      copyright_year: 2019, latest_content_date: null, broken_link_count: 0, score: 41, offer: "performance",
      findings: [{ code: "slow_mobile", group: "speed", severity: "high", points: 25, evidence: "x" }], raw_r2_key: null,
    });
    const a = await latestAudit(env.DB, b.id);
    expect(a!.findings[0].code).toBe("slow_mobile");
    expect(a!.partial).toBe(false);
  });

  it("replaces contacts", async () => {
    await replaceContacts(env.DB, "biz1", [{ type: "email", value: "a@b.com", source_url: null, person_name: null, role: null, confidence: 0.9 }]);
    await replaceContacts(env.DB, "biz1", [{ type: "phone", value: "555", source_url: null, person_name: null, role: null, confidence: 0.5 }]);
    const c = await listContacts(env.DB, "biz1");
    expect(c.map((x) => x.type)).toEqual(["phone"]);
  });

  it("saves settings and sums usage per month", async () => {
    await saveSettings(env.DB, { your_name: "Logan" });
    expect((await getSettings(env.DB)).your_name).toBe("Logan");
    await recordUsage(env.DB, "claude", 1, 0.01);
    await recordUsage(env.DB, "claude", 2, 0.02);
    const month = new Date().toISOString().slice(0, 7);
    const rows = await monthUsage(env.DB, month);
    expect(rows.find((r) => r.service === "claude")!.units).toBe(3);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npm test -- test/db.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 5: Implement data modules**

`src/worker/db/searches.ts`:
```ts
import type { Search } from "../types";

export async function createSearch(
  db: D1Database,
  i: { location: string; businessType: string; radiusKm: number; maxResults: number },
): Promise<Search> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO searches (id, location, business_type, radius_km, max_results, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
  ).bind(id, i.location, i.businessType, i.radiusKm, Math.min(i.maxResults, 200), now).run();
  return (await getSearch(db, id))!;
}

export async function getSearch(db: D1Database, id: string): Promise<Search | null> {
  return db.prepare(`SELECT * FROM searches WHERE id = ?`).bind(id).first<Search>();
}

export async function listSearches(db: D1Database): Promise<Search[]> {
  return (await db.prepare(`SELECT * FROM searches ORDER BY created_at DESC LIMIT 100`).all<Search>()).results;
}

export async function setSearchStatus(db: D1Database, id: string, status: Search["status"], error: string | null = null) {
  await db.prepare(`UPDATE searches SET status = ?, error = ? WHERE id = ?`).bind(status, error, id).run();
}

export async function setFoundCount(db: D1Database, id: string, n: number) {
  await db.prepare(`UPDATE searches SET found_count = ? WHERE id = ?`).bind(n, id).run();
}

export async function incrementProcessed(db: D1Database, id: string) {
  await db.prepare(`UPDATE searches SET processed_count = processed_count + 1 WHERE id = ?`).bind(id).run();
}
```

`src/worker/db/businesses.ts`:
```ts
import type { Business, LeadStatus, Listing } from "../types";

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function getBusiness(db: D1Database, id: string): Promise<Business | null> {
  return db.prepare(`SELECT * FROM businesses WHERE id = ?`).bind(id).first<Business>();
}

export async function upsertBusiness(db: D1Database, l: Listing, searchId: string): Promise<Business> {
  const domain = domainOf(l.websiteUrl);
  let existing: Business | null = null;
  if (l.placeId) existing = await db.prepare(`SELECT * FROM businesses WHERE place_id = ?`).bind(l.placeId).first<Business>();
  if (!existing && domain) existing = await db.prepare(`SELECT * FROM businesses WHERE domain = ?`).bind(domain).first<Business>();

  let id: string;
  if (existing) {
    id = existing.id;
    await db.prepare(
      `UPDATE businesses SET name = ?, category = COALESCE(?, category), address = COALESCE(?, address),
       phone = COALESCE(?, phone), website_url = COALESCE(?, website_url), maps_url = COALESCE(?, maps_url),
       rating = COALESCE(?, rating), review_count = COALESCE(?, review_count),
       place_id = COALESCE(place_id, ?), domain = COALESCE(domain, ?) WHERE id = ?`,
    ).bind(l.name, l.category, l.address, l.phone, l.websiteUrl, l.mapsUrl, l.rating, l.reviewCount, l.placeId, domain, id).run();
  } else {
    id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO businesses (id, place_id, domain, name, category, address, phone, website_url, maps_url,
       rating, review_count, first_seen_search_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, l.placeId, domain, l.name, l.category, l.address, l.phone, l.websiteUrl, l.mapsUrl,
      l.rating, l.reviewCount, searchId, new Date().toISOString()).run();
  }
  await db.prepare(`INSERT OR IGNORE INTO search_results (search_id, business_id) VALUES (?, ?)`).bind(searchId, id).run();
  return (await getBusiness(db, id))!;
}

export async function listBusinessesForSearch(db: D1Database, searchId: string, o: { hideSkipped: boolean }) {
  const sql = `SELECT b.* FROM businesses b JOIN search_results sr ON sr.business_id = b.id
    WHERE sr.search_id = ? ${o.hideSkipped ? "AND b.lead_status != 'skip'" : ""}`;
  return (await db.prepare(sql).bind(searchId).all<Business>()).results;
}

export async function listAllBusinesses(db: D1Database, o: { status?: LeadStatus }) {
  const stmt = o.status
    ? db.prepare(`SELECT * FROM businesses WHERE lead_status = ? ORDER BY created_at DESC`).bind(o.status)
    : db.prepare(`SELECT * FROM businesses ORDER BY created_at DESC`);
  return (await stmt.all<Business>()).results;
}

export async function updateLead(db: D1Database, id: string, u: { leadStatus?: LeadStatus; notes?: string }) {
  if (u.leadStatus) {
    const contactedAt = u.leadStatus === "contacted" ? new Date().toISOString() : null;
    await db.prepare(`UPDATE businesses SET lead_status = ?, contacted_at = COALESCE(?, contacted_at) WHERE id = ?`)
      .bind(u.leadStatus, contactedAt, id).run();
  }
  if (u.notes !== undefined) await db.prepare(`UPDATE businesses SET notes = ? WHERE id = ?`).bind(u.notes, id).run();
  return (await getBusiness(db, id))!;
}

export async function setBusinessError(db: D1Database, id: string, msg: string | null) {
  await db.prepare(`UPDATE businesses SET last_error = ? WHERE id = ?`).bind(msg, id).run();
}
```

`src/worker/db/audits.ts`:
```ts
import type { Audit, AuditInsert } from "../types";

type Row = Omit<Audit, "findings" | "partial" | "mobile_friendly" | "https" | "has_title" | "has_meta_description" | "has_contact_form"> & {
  findings: string; partial: number; mobile_friendly: number | null; https: number | null;
  has_title: number | null; has_meta_description: number | null; has_contact_form: number | null;
};
const b = (v: number | null) => (v === null ? null : v === 1);
const n = (v: boolean | null) => (v === null ? null : v ? 1 : 0);

function fromRow(r: Row): Audit {
  return {
    ...r, findings: JSON.parse(r.findings), partial: r.partial === 1, mobile_friendly: b(r.mobile_friendly),
    https: b(r.https), has_title: b(r.has_title), has_meta_description: b(r.has_meta_description),
    has_contact_form: b(r.has_contact_form),
  };
}

export async function insertAudit(db: D1Database, a: AuditInsert): Promise<Audit> {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO audits (id, business_id, created_at, site_status, partial, pagespeed_mobile, lcp_ms, cls,
     mobile_friendly, https, has_title, has_meta_description, has_contact_form, copyright_year,
     latest_content_date, broken_link_count, score, offer, findings, raw_r2_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, a.business_id, new Date().toISOString(), a.site_status, a.partial ? 1 : 0, a.pagespeed_mobile,
    a.lcp_ms, a.cls, n(a.mobile_friendly), n(a.https), n(a.has_title), n(a.has_meta_description),
    n(a.has_contact_form), a.copyright_year, a.latest_content_date, a.broken_link_count, a.score, a.offer,
    JSON.stringify(a.findings), a.raw_r2_key).run();
  return (await db.prepare(`SELECT * FROM audits WHERE id = ?`).bind(id).first<Row>().then((r) => fromRow(r!)));
}

export async function latestAudit(db: D1Database, businessId: string): Promise<Audit | null> {
  const r = await db.prepare(`SELECT * FROM audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(businessId).first<Row>();
  return r ? fromRow(r) : null;
}
```

`src/worker/db/contacts.ts`:
```ts
import type { Contact, ContactInput } from "../types";

export async function replaceContacts(db: D1Database, businessId: string, list: ContactInput[]): Promise<Contact[]> {
  const stmts = [db.prepare(`DELETE FROM contacts WHERE business_id = ?`).bind(businessId)];
  for (const c of list) {
    stmts.push(db.prepare(
      `INSERT INTO contacts (id, business_id, type, value, source_url, person_name, role, confidence)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(crypto.randomUUID(), businessId, c.type, c.value, c.source_url, c.person_name, c.role, c.confidence));
  }
  await db.batch(stmts);
  return listContacts(db, businessId);
}

export async function listContacts(db: D1Database, businessId: string): Promise<Contact[]> {
  return (await db.prepare(`SELECT * FROM contacts WHERE business_id = ?`).bind(businessId).all<Contact>()).results;
}
```

`src/worker/db/drafts.ts`:
```ts
import type { Draft, DraftInsert } from "../types";

type Row = Omit<Draft, "edited"> & { edited: number };
const fromRow = (r: Row): Draft => ({ ...r, edited: r.edited === 1 });

export async function insertDraft(db: D1Database, d: DraftInsert): Promise<Draft> {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO drafts (id, business_id, audit_id, to_contact_id, recipient_reason, subject, body, offer,
     steering_note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, d.business_id, d.audit_id, d.to_contact_id, d.recipient_reason, d.subject, d.body, d.offer,
    d.steering_note, new Date().toISOString()).run();
  return fromRow((await db.prepare(`SELECT * FROM drafts WHERE id = ?`).bind(id).first<Row>())!);
}

export async function latestDraft(db: D1Database, businessId: string): Promise<Draft | null> {
  const r = await db.prepare(`SELECT * FROM drafts WHERE business_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(businessId).first<Row>();
  return r ? fromRow(r) : null;
}

export async function updateDraftBody(db: D1Database, id: string, u: { subject: string; body: string }) {
  await db.prepare(`UPDATE drafts SET subject = ?, body = ?, edited = 1 WHERE id = ?`).bind(u.subject, u.body, id).run();
}
```

`src/worker/db/settings.ts`:
```ts
import type { Settings } from "../types";

const FIELDS: (keyof Settings)[] = [
  "your_name", "business_name", "contact_email", "services_blurb", "signature",
  "physical_address", "opt_out_line", "tone_notes", "monthly_spend_limit_usd",
];

export async function getSettings(db: D1Database): Promise<Settings> {
  return (await db.prepare(`SELECT * FROM settings WHERE id = 1`).first<Settings>())!;
}

export async function saveSettings(db: D1Database, s: Partial<Settings>): Promise<Settings> {
  const keys = FIELDS.filter((k) => s[k] !== undefined);
  if (keys.length) {
    await db.prepare(`UPDATE settings SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = 1`)
      .bind(...keys.map((k) => s[k])).run();
  }
  return getSettings(db);
}
```

`src/worker/db/usage.ts`:
```ts
export type Service = "brightdata" | "pagespeed" | "claude";

export async function recordUsage(db: D1Database, service: Service, units: number, estCostUsd: number) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO usage (id, month, service, units, est_cost_usd, created_at) VALUES (?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), now.slice(0, 7), service, units, estCostUsd, now).run();
}

export async function monthUsage(db: D1Database, month: string) {
  return (await db.prepare(
    `SELECT service, SUM(units) AS units, SUM(est_cost_usd) AS est_cost_usd FROM usage WHERE month = ? GROUP BY service`,
  ).bind(month).all<{ service: Service; units: number; est_cost_usd: number }>()).results;
}
```

- [ ] **Step 6: Run tests**

Run: `npm test -- test/db.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: D1 schema and data-access modules"
```

---

### Task 3: Scorer

**Files:**
- Create: `src/worker/scoring/config.ts`, `src/worker/scoring/scorer.ts`
- Test: `test/scorer.test.ts`

**Interfaces:**
- Consumes: `Finding`, `Offer`, `SiteStatus` from `types.ts`.
- Produces:
  - `interface CrawlFacts { https: boolean; hasTitle: boolean; hasMetaDescription: boolean; hasViewport: boolean; hasContactForm: boolean; emailCount: number; copyrightYear: number | null; latestContentDate: string | null; pastEventDates: string[]; brokenLinkCount: number; }` (exported from `scorer.ts`)
  - `interface PageSpeedFacts { performanceScore: number; lcpMs: number; cls: number; mobileFriendly: boolean; }`
  - `score(input: { siteStatus: SiteStatus; crawl: CrawlFacts | null; pagespeed: PageSpeedFacts | null; now: Date }) → { score: number; findings: Finding[]; offer: Offer; lowPriority: boolean }`

- [ ] **Step 1: Write the failing tests**

`test/scorer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { score, type CrawlFacts, type PageSpeedFacts } from "../src/worker/scoring/scorer";

const now = new Date("2026-10-02T00:00:00Z");
const goodCrawl: CrawlFacts = {
  https: true, hasTitle: true, hasMetaDescription: true, hasViewport: true, hasContactForm: true, emailCount: 1,
  copyrightYear: 2026, latestContentDate: "2026-08-01", pastEventDates: [], brokenLinkCount: 0,
};
const goodPs: PageSpeedFacts = { performanceScore: 92, lcpMs: 1800, cls: 0.02, mobileFriendly: true };
const codes = (r: ReturnType<typeof score>) => r.findings.map((f) => f.code).sort();

describe("score", () => {
  it("no website → 100, new_site", () => {
    const r = score({ siteStatus: "no_website", crawl: null, pagespeed: null, now });
    expect(r.score).toBe(100);
    expect(r.offer).toBe("new_site");
    expect(codes(r)).toEqual(["no_website"]);
  });

  it("parked and unreachable → 90, new_site", () => {
    expect(score({ siteStatus: "parked", crawl: null, pagespeed: null, now }).score).toBe(90);
    expect(score({ siteStatus: "unreachable", crawl: null, pagespeed: null, now }).offer).toBe("new_site");
  });

  it("healthy site → 0, low priority", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: goodPs, now });
    expect(r.score).toBe(0);
    expect(r.lowPriority).toBe(true);
  });

  it("slow_mobile and meh_mobile are mutually exclusive", () => {
    const slow = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 30 }, now });
    expect(codes(slow)).toEqual(["slow_mobile"]);
    const meh = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 60 }, now });
    expect(codes(meh)).toEqual(["meh_mobile"]);
    expect(score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 70 }, now }).findings).toHaveLength(0);
  });

  it("speed-heavy site → performance offer", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { performanceScore: 30, lcpMs: 6000, cls: 0.4, mobileFriendly: true }, now });
    expect(r.score).toBe(25 + 10 + 5);
    expect(r.offer).toBe("performance");
  });

  it("stale-heavy site → care_plan", () => {
    const r = score({
      siteStatus: "ok",
      crawl: { ...goodCrawl, copyrightYear: 2023, latestContentDate: "2024-01-01", pastEventDates: ["2025-05-01"], brokenLinkCount: 4 },
      pagespeed: goodPs, now,
    });
    expect(codes(r)).toEqual(["broken_links", "old_copyright", "past_events", "stale_content"]);
    expect(r.score).toBe(33);
    expect(r.offer).toBe("care_plan");
  });

  it("copyright exactly current-2 counts, current-1 does not", () => {
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, copyrightYear: 2024 }, pagespeed: goodPs, now }))).toContain("old_copyright");
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, copyrightYear: 2025 }, pagespeed: goodPs, now }))).not.toContain("old_copyright");
  });

  it("basics only → seo_basics", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, https: false, hasTitle: false }, pagespeed: goodPs, now });
    expect(codes(r)).toEqual(["no_https", "no_title_or_meta"]);
    expect(r.offer).toBe("seo_basics");
  });

  it("no_contact_form only when no form AND no email", () => {
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, hasContactForm: false, emailCount: 1 }, pagespeed: goodPs, now }))).toEqual([]);
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, hasContactForm: false, emailCount: 0 }, pagespeed: goodPs, now }))).toEqual(["no_contact_form"]);
  });

  it("not mobile friendly + stale → new_site", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, hasViewport: false, copyrightYear: 2018 }, pagespeed: goodPs, now });
    expect(r.offer).toBe("new_site");
  });

  it("missing viewport counts as not_mobile_friendly even without pagespeed; partial input works", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, hasViewport: false }, pagespeed: null, now });
    expect(codes(r)).toEqual(["not_mobile_friendly"]);
  });

  it("ties break speed > stale > basics", () => {
    // speed 10 (slow_lcp) vs stale 10 (old_copyright)
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, copyrightYear: 2020 }, pagespeed: { ...goodPs, lcpMs: 5000 }, now });
    expect(r.offer).toBe("performance");
  });

  it("caps at 100", () => {
    const r = score({
      siteStatus: "ok",
      crawl: { https: false, hasTitle: false, hasMetaDescription: false, hasViewport: false, hasContactForm: false, emailCount: 0,
        copyrightYear: 2010, latestContentDate: "2015-01-01", pastEventDates: ["2020-01-01"], brokenLinkCount: 10 },
      pagespeed: { performanceScore: 10, lcpMs: 9000, cls: 0.9, mobileFriendly: false }, now,
    });
    expect(r.score).toBe(100);
  });

  it("evidence is plain English with numbers", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 30, lcpMs: 8400 }, now });
    expect(r.findings.find((f) => f.code === "slow_lcp")!.evidence).toBe("Main content takes about 8.4 seconds to appear on a phone");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/scorer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/worker/scoring/config.ts`:
```ts
export const WEIGHTS = {
  slow_mobile: 25,
  meh_mobile: 12,
  slow_lcp: 10,
  layout_shift: 5,
  not_mobile_friendly: 20,
  old_copyright: 10,
  stale_content: 10,
  past_events: 5,
  broken_links: 8,
  no_https: 15,
  no_title_or_meta: 6,
  no_contact_form: 6,
} as const;

export const THRESHOLDS = {
  slowMobileBelow: 50,
  mehMobileBelow: 70,
  slowLcpMs: 4000,
  layoutShiftCls: 0.25,
  oldCopyrightYearsBack: 2,
  staleContentMonths: 18,
  brokenLinksMin: 3,
  lowPriorityBelow: 20,
} as const;

export const SITE_STATUS_SCORE = { no_website: 100, parked: 90, unreachable: 90 } as const;
```

`src/worker/scoring/scorer.ts`:
```ts
import type { Finding, FindingCode, FindingGroup, Offer, SiteStatus } from "../types";
import { SITE_STATUS_SCORE, THRESHOLDS as T, WEIGHTS as W } from "./config";

export interface CrawlFacts {
  https: boolean; hasTitle: boolean; hasMetaDescription: boolean; hasViewport: boolean;
  hasContactForm: boolean; emailCount: number; copyrightYear: number | null;
  latestContentDate: string | null; pastEventDates: string[]; brokenLinkCount: number;
}
export interface PageSpeedFacts { performanceScore: number; lcpMs: number; cls: number; mobileFriendly: boolean; }

const GROUP: Record<keyof typeof W, FindingGroup> = {
  slow_mobile: "speed", meh_mobile: "speed", slow_lcp: "speed", layout_shift: "speed", not_mobile_friendly: "speed",
  old_copyright: "stale", stale_content: "stale", past_events: "stale", broken_links: "stale",
  no_https: "basics", no_title_or_meta: "basics", no_contact_form: "basics",
};

function sev(points: number): Finding["severity"] {
  return points >= 15 ? "high" : points >= 8 ? "medium" : "low";
}
function f(code: keyof typeof W, evidence: string): Finding {
  return { code, group: GROUP[code], severity: sev(W[code]), points: W[code], evidence };
}
function monthsBetween(iso: string, now: Date): number {
  const d = new Date(iso);
  return (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
}
const secs = (ms: number) => (ms / 1000).toFixed(1);

export function score(input: { siteStatus: SiteStatus; crawl: CrawlFacts | null; pagespeed: PageSpeedFacts | null; now: Date }) {
  const { siteStatus, crawl, pagespeed: ps, now } = input;

  if (siteStatus !== "ok") {
    const map: Record<Exclude<SiteStatus, "ok">, [FindingCode, string]> = {
      no_website: ["no_website", "No website listed on their Google Business profile"],
      parked: ["site_parked", "Their web address shows a placeholder or for-sale page"],
      unreachable: ["site_unreachable", "Their website didn't load when we tried it"],
    };
    const [code, evidence] = map[siteStatus];
    const pts = SITE_STATUS_SCORE[siteStatus];
    return { score: pts, offer: "new_site" as Offer, lowPriority: false,
      findings: [{ code, group: "site", severity: "high", points: pts, evidence } as Finding] };
  }

  const out: Finding[] = [];
  if (ps) {
    if (ps.performanceScore < T.slowMobileBelow)
      out.push(f("slow_mobile", `Scores ${ps.performanceScore}/100 on Google's mobile speed test`));
    else if (ps.performanceScore < T.mehMobileBelow)
      out.push(f("meh_mobile", `Scores ${ps.performanceScore}/100 on Google's mobile speed test`));
    if (ps.lcpMs > T.slowLcpMs)
      out.push(f("slow_lcp", `Main content takes about ${secs(ps.lcpMs)} seconds to appear on a phone`));
    if (ps.cls > T.layoutShiftCls)
      out.push(f("layout_shift", "The page jumps around while it loads"));
  }
  if (crawl) {
    if (!crawl.hasViewport || (ps && !ps.mobileFriendly))
      out.push(f("not_mobile_friendly", "The site isn't set up for phones, so text and buttons are hard to use"));
    if (crawl.copyrightYear !== null && crawl.copyrightYear <= now.getUTCFullYear() - T.oldCopyrightYearsBack)
      out.push(f("old_copyright", `The footer still says © ${crawl.copyrightYear}`));
    if (crawl.latestContentDate && monthsBetween(crawl.latestContentDate, now) > T.staleContentMonths)
      out.push(f("stale_content", `The newest post or update is from ${crawl.latestContentDate.slice(0, 7)}`));
    if (crawl.pastEventDates.length > 0)
      out.push(f("past_events", `Lists events that already happened (e.g. ${crawl.pastEventDates[0]})`));
    if (crawl.brokenLinkCount >= T.brokenLinksMin)
      out.push(f("broken_links", `${crawl.brokenLinkCount} links on the site lead to missing pages`));
    if (!crawl.https) out.push(f("no_https", "The site isn't secure (no HTTPS), so browsers show a warning"));
    if (!crawl.hasTitle || !crawl.hasMetaDescription)
      out.push(f("no_title_or_meta", "The homepage is missing the title or summary Google shows in search results"));
    if (!crawl.hasContactForm && crawl.emailCount === 0)
      out.push(f("no_contact_form", "There's no contact form or email address on the site"));
  }

  const total = Math.min(100, out.reduce((s, x) => s + x.points, 0));
  const byGroup = (g: FindingGroup) => out.filter((x) => x.group === g).reduce((s, x) => s + x.points, 0);
  const speed = byGroup("speed"), stale = byGroup("stale"), basics = byGroup("basics");

  let offer: Offer;
  if (out.some((x) => x.code === "not_mobile_friendly") && stale > 0) offer = "new_site";
  else if (speed >= stale && speed >= basics && speed > 0) offer = "performance";
  else if (stale >= basics && stale > 0) offer = "care_plan";
  else if (basics > 0) offer = "seo_basics";
  else offer = "care_plan";

  out.sort((a, b) => b.points - a.points);
  return { score: total, findings: out, offer, lowPriority: total < T.lowPriorityBelow };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/scorer.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: pure lead scorer with configurable weights"
```

---

### Task 4: Recipient ranking

**Files:**
- Create: `src/worker/recipient.ts`
- Test: `test/recipient.test.ts`

**Interfaces:**
- Consumes: `Contact` from `types.ts`, `domainOf` from `db/businesses.ts`.
- Produces: `pickRecipient(contacts: Contact[], siteDomain: string | null) → { contact: Contact | null; emailContact: Contact | null; reason: string; ranked: Contact[] }`. `emailContact` is the best email or null; `contact` is the overall best (email, else form, else phone).

- [ ] **Step 1: Write the failing tests**

`test/recipient.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { pickRecipient } from "../src/worker/recipient";
import type { Contact } from "../src/worker/types";

let n = 0;
const c = (o: Partial<Contact>): Contact => ({
  id: `c${n++}`, business_id: "b", type: "email", value: "", source_url: null,
  person_name: null, role: null, confidence: 0.8, ...o,
});

describe("pickRecipient", () => {
  it("prefers named owner on own domain over generic inbox", () => {
    const r = pickRecipient([c({ value: "info@ace.com" }), c({ value: "jane@ace.com", person_name: "Jane", role: "Owner" })], "ace.com");
    expect(r.emailContact!.value).toBe("jane@ace.com");
    expect(r.reason).toMatch(/Jane/);
  });

  it("orders generic inboxes owner > info > contact > office > other", () => {
    const r = pickRecipient([c({ value: "office@ace.com" }), c({ value: "sales@ace.com" }), c({ value: "info@ace.com" })], "ace.com");
    expect(r.ranked.map((x) => x.value)).toEqual(["info@ace.com", "office@ace.com", "sales@ace.com"]);
  });

  it("own-domain beats gmail", () => {
    const r = pickRecipient([c({ value: "acebob@gmail.com" }), c({ value: "hello@ace.com" })], "ace.com");
    expect(r.emailContact!.value).toBe("hello@ace.com");
  });

  it("falls back to form then phone with explanatory reason", () => {
    const form = pickRecipient([c({ type: "phone", value: "555" }), c({ type: "form", value: "https://ace.com/contact" })], "ace.com");
    expect(form.emailContact).toBeNull();
    expect(form.contact!.type).toBe("form");
    expect(form.reason).toBe("No email found. Use the contact form at https://ace.com/contact");
    const phone = pickRecipient([c({ type: "phone", value: "555-1234" })], "ace.com");
    expect(phone.reason).toBe("No email or form found. Call 555-1234");
  });

  it("handles no contacts", () => {
    const r = pickRecipient([], null);
    expect(r.contact).toBeNull();
    expect(r.reason).toBe("No contact details found");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/recipient.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/worker/recipient.ts`:
```ts
import type { Contact } from "./types";

const GENERIC_ORDER = ["owner", "info", "contact", "office"];
const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn|comcast|att)\./i;
const LEADER_ROLE = /owner|founder|president|manager|principal|director|office/i;

function emailRank(e: Contact, domain: string | null): number {
  const [local, host] = e.value.toLowerCase().split("@");
  const own = domain !== null && (host === domain || host.endsWith(`.${domain}`));
  if (own && e.person_name) return e.role && LEADER_ROLE.test(e.role) ? 0 : 1;
  if (own) {
    const i = GENERIC_ORDER.indexOf(local);
    return 10 + (i === -1 ? GENERIC_ORDER.length : i);
  }
  if (FREE_MAIL.test(e.value)) return 30;
  return 40;
}

export function pickRecipient(contacts: Contact[], siteDomain: string | null) {
  const emails = contacts
    .filter((c) => c.type === "email")
    .sort((a, b) => emailRank(a, siteDomain) - emailRank(b, siteDomain) || b.confidence - a.confidence);
  const form = contacts.find((c) => c.type === "form") ?? null;
  const phone = contacts.find((c) => c.type === "phone") ?? null;

  if (emails.length) {
    const e = emails[0];
    const reason = e.person_name
      ? `${e.person_name}${e.role ? ` (${e.role})` : ""} listed on ${e.source_url ?? "their site"}`
      : `Best inbox found on ${e.source_url ?? "their site"}`;
    return { contact: e, emailContact: e, reason, ranked: emails };
  }
  if (form) return { contact: form, emailContact: null, reason: `No email found. Use the contact form at ${form.value}`, ranked: [] };
  if (phone) return { contact: phone, emailContact: null, reason: `No email or form found. Call ${phone.value}`, ranked: [] };
  return { contact: null, emailContact: null, reason: "No contact details found", ranked: [] };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/recipient.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: recipient ranking"
```

---

### Task 5: HTML extraction (pure)

**Files:**
- Create: `src/worker/crawler/extract.ts`, `test/fixtures/html/old-plumber.html`, `test/fixtures/html/modern.html`, `test/fixtures/html/parked.html`, `test/fixtures/html/team.html`
- Test: `test/extract.test.ts`

**Interfaces:**
- Produces:
  - `interface PageFacts { title: string | null; metaDescription: string | null; hasViewport: boolean; hasForm: boolean; emails: { value: string; personName: string | null; role: string | null }[]; phones: string[]; socials: string[]; copyrightYear: number | null; dates: string[]; eventDates: string[]; internalLinks: string[]; isParked: boolean; }`
  - `extractPage(html: string, pageUrl: string) → PageFacts`
  - `pickCrawlTargets(links: string[], baseUrl: string, max: number) → string[]` — chooses contact/about/team/blog/news/events pages, same host only.
  - `isSocialOnlyUrl(url: string) → boolean` — true for facebook/instagram/yelp/linktree/etc.

- [ ] **Step 1: Create fixtures**

`test/fixtures/html/old-plumber.html`:
```html
<html><head><title>Ace Plumbing</title></head>
<body>
<table><tr><td>
<h1>Welcome to Ace Plumbing</h1>
<p>Call us at (208) 555-0134 or email info [at] aceplumbing [dot] com</p>
<p><a href="mailto:Bob@AcePlumbing.com?subject=Hi">Email Bob</a></p>
<img src="/img/logo@2x.png">
<a href="/contact.html">Contact</a> <a href="/about-us">About</a> <a href="/blog/">Blog</a>
<a href="/news/2019-update">News</a> <a href="https://facebook.com/aceplumbing">Facebook</a>
<a href="https://other.com/x">Partner</a> <a href="/files/menu.pdf">Menu</a>
<h3>Upcoming Events</h3><p>Open house: March 14, 2023</p>
<p>Posted on June 3, 2019</p>
</td></tr></table>
<p>Copyright &copy; 2011 - 2019 Ace Plumbing. Contact webmaster: example@example.com</p>
<script>Sentry.init({dsn:"https://abc@o1.ingest.sentry.io/1"})</script>
</body></html>
```

`test/fixtures/html/modern.html`:
```html
<!doctype html><html><head>
<title>Bright Dental | Boise</title>
<meta name="description" content="Family dentistry in Boise.">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body>
<form action="/api/contact" method="post"><input name="email"><button>Send</button></form>
<footer>© 2026 Bright Dental · hello@brightdental.com</footer>
<time datetime="2026-09-12">Sep 12</time>
</body></html>
```

`test/fixtures/html/parked.html`:
```html
<html><head><title>aceplumbing.com is for sale!</title></head>
<body><h1>This domain may be for sale</h1><p>Buy this domain on GoDaddy. Related searches: plumbing</p></body></html>
```

`test/fixtures/html/team.html`:
```html
<html><body>
<div class="team">
  <div><h3>Jane Doe</h3><p>Owner</p><a href="mailto:jane@aceplumbing.com">jane@aceplumbing.com</a></div>
  <div><h3>Tom Lee</h3><p>Office Manager</p><p>tom@aceplumbing.com</p></div>
</div></body></html>
```

- [ ] **Step 2: Write the failing tests**

`test/extract.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { extractPage, pickCrawlTargets, isSocialOnlyUrl } from "../src/worker/crawler/extract";
import oldHtml from "./fixtures/html/old-plumber.html?raw";
import modernHtml from "./fixtures/html/modern.html?raw";
import parkedHtml from "./fixtures/html/parked.html?raw";
import teamHtml from "./fixtures/html/team.html?raw";

describe("extractPage", () => {
  const old = extractPage(oldHtml, "http://aceplumbing.com/");

  it("finds title, missing meta and viewport", () => {
    expect(old.title).toBe("Ace Plumbing");
    expect(old.metaDescription).toBeNull();
    expect(old.hasViewport).toBe(false);
  });

  it("decodes obfuscated and mailto emails, lowercased, drops junk", () => {
    const v = old.emails.map((e) => e.value).sort();
    expect(v).toEqual(["bob@aceplumbing.com", "info@aceplumbing.com"]);
  });

  it("takes the latest year in a copyright range", () => {
    expect(old.copyrightYear).toBe(2019);
  });

  it("collects dates and event dates as ISO", () => {
    expect(old.dates).toContain("2019-06-03");
    expect(old.eventDates).toContain("2023-03-14");
  });

  it("collects phones and socials", () => {
    expect(old.phones).toContain("(208) 555-0134");
    expect(old.socials).toContain("https://facebook.com/aceplumbing");
  });

  it("internal links are absolute, same host, no non-HTML files", () => {
    expect(old.internalLinks).toContain("http://aceplumbing.com/contact.html");
    expect(old.internalLinks.some((l) => l.endsWith(".pdf"))).toBe(false);
    expect(old.internalLinks.some((l) => l.includes("other.com"))).toBe(false);
  });

  it("modern page: meta, viewport, form, footer email, <time> date", () => {
    const m = extractPage(modernHtml, "https://brightdental.com/");
    expect(m.metaDescription).toBe("Family dentistry in Boise.");
    expect(m.hasViewport).toBe(true);
    expect(m.hasForm).toBe(true);
    expect(m.emails.map((e) => e.value)).toEqual(["hello@brightdental.com"]);
    expect(m.copyrightYear).toBe(2026);
    expect(m.dates).toContain("2026-09-12");
  });

  it("detects parked domains", () => {
    expect(extractPage(parkedHtml, "http://aceplumbing.com/").isParked).toBe(true);
    expect(old.isParked).toBe(false);
  });

  it("associates names and roles with team emails", () => {
    const t = extractPage(teamHtml, "https://aceplumbing.com/team");
    const jane = t.emails.find((e) => e.value === "jane@aceplumbing.com")!;
    expect(jane.personName).toBe("Jane Doe");
    expect(jane.role).toBe("Owner");
    expect(t.emails.find((e) => e.value === "tom@aceplumbing.com")!.role).toBe("Office Manager");
  });
});

describe("pickCrawlTargets", () => {
  it("prioritises contact, about/team, blog/news/events; caps count; dedupes", () => {
    const links = [
      "https://a.com/services", "https://a.com/contact", "https://a.com/contact#form", "https://a.com/about",
      "https://a.com/our-team", "https://a.com/blog", "https://a.com/events", "https://a.com/news",
    ];
    expect(pickCrawlTargets(links, "https://a.com/", 5)).toEqual([
      "https://a.com/contact", "https://a.com/about", "https://a.com/our-team", "https://a.com/blog", "https://a.com/news",
    ]);
  });
});

describe("isSocialOnlyUrl", () => {
  it("flags social/aggregator profiles as not a real website", () => {
    for (const u of ["https://www.facebook.com/ace", "https://instagram.com/ace", "https://www.yelp.com/biz/ace", "https://linktr.ee/ace", "https://ace.business.site"])
      expect(isSocialOnlyUrl(u)).toBe(true);
    expect(isSocialOnlyUrl("https://aceplumbing.com")).toBe(false);
  });
});
```

Add to `test/env.d.ts`:
```ts
declare module "*.html?raw" { const s: string; export default s; }
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- test/extract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/worker/crawler/extract.ts`:
```ts
import { parse, type HTMLElement } from "node-html-parser";

export interface PageFacts {
  title: string | null; metaDescription: string | null; hasViewport: boolean; hasForm: boolean;
  emails: { value: string; personName: string | null; role: string | null }[];
  phones: string[]; socials: string[]; copyrightYear: number | null;
  dates: string[]; eventDates: string[]; internalLinks: string[]; isParked: boolean;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const OBFUSCATED_RE = /([a-z0-9._%+-]+)\s*[\[(]\s*at\s*[\])]\s*([a-z0-9-]+(?:\s*[\[(]\s*dot\s*[\])]\s*[a-z0-9-]+)+)/gi;
const JUNK_EMAIL = /(example\.(com|org)|sentry|wixpress|\.(png|jpe?g|gif|svg|webp)$|^[0-9a-f]{20,}@|domain\.com|email\.com|yourname)/i;
const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;
const SOCIAL_HOSTS = /(^|\.)(facebook|instagram|twitter|x|linkedin|youtube|tiktok|yelp|nextdoor)\.com$/i;
const SOCIAL_ONLY = /(^|\.)(facebook\.com|fb\.com|instagram\.com|yelp\.com|linktr\.ee|business\.site|nextdoor\.com|twitter\.com|x\.com|tiktok\.com|square\.site|google\.com)$/i;
const NON_HTML = /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4|mp3)(\?|$)/i;
const PARKED = /(domain (may be|is) for sale|buy this domain|this domain is parked|parked free|related searches|godaddy\.com\/domainsearch|sedo\.com|hugedomains|dan\.com)/i;
const ROLE_RE = /^(owner|co-owner|founder|co-founder|president|ceo|manager|office manager|general manager|principal|director|partner|administrator|marketing( manager| director)?)$/i;
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const MONTH_DATE_RE = new RegExp(`\\b(${MONTHS.join("|")}|${MONTHS.map((m) => m.slice(0, 3)).join("|")})\\.?\\s+(\\d{1,2}),?\\s+(20\\d{2}|19\\d{2})\\b`, "gi");
const ISO_DATE_RE = /\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/g;
const SLASH_DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g;

const pad = (n: number) => String(n).padStart(2, "0");

function isoFromMonthName(m: string, d: string, y: string): string | null {
  const idx = MONTHS.findIndex((x) => x.startsWith(m.toLowerCase().slice(0, 3)));
  if (idx < 0) return null;
  return `${y}-${pad(idx + 1)}-${pad(Number(d))}`;
}

function findDates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MONTH_DATE_RE)) { const iso = isoFromMonthName(m[1], m[2], m[3]); if (iso) out.add(iso); }
  for (const m of text.matchAll(ISO_DATE_RE)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(SLASH_DATE_RE)) out.add(`${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`);
  return [...out];
}

function cleanEmail(e: string): string | null {
  const v = e.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  if (JUNK_EMAIL.test(v)) return null;
  return v;
}

function personFor(el: HTMLElement | null): { personName: string | null; role: string | null } {
  // Walk up to 3 ancestors looking for a heading (name) and a short role line.
  let node: HTMLElement | null = el;
  for (let i = 0; i < 3 && node; i++) {
    node = node.parentNode as HTMLElement | null;
    if (!node) break;
    const heading = node.querySelector("h2, h3, h4, strong");
    const role = node.querySelectorAll("p, span, em").map((x) => x.text.trim()).find((t) => ROLE_RE.test(t));
    if (heading && /^[A-Z][a-z]+(\s[A-Z][a-z'.-]+){1,2}$/.test(heading.text.trim()))
      return { personName: heading.text.trim(), role: role ?? null };
  }
  return { personName: null, role: null };
}

export function isSocialOnlyUrl(url: string): boolean {
  try { return SOCIAL_ONLY.test(new URL(url).hostname.toLowerCase().replace(/^www\./, "")); } catch { return false; }
}

export function extractPage(html: string, pageUrl: string): PageFacts {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false } });
  const base = new URL(pageUrl);
  const text = root.text.replace(/\s+/g, " ");

  const emails = new Map<string, { value: string; personName: string | null; role: string | null }>();
  for (const a of root.querySelectorAll('a[href^="mailto:"]')) {
    const v = cleanEmail(a.getAttribute("href")!);
    if (v && !emails.has(v)) emails.set(v, { value: v, ...personFor(a) });
  }
  for (const p of root.querySelectorAll("p, li, td, footer, span, div")) {
    if (p.childNodes.some((c) => (c as HTMLElement).tagName && ["DIV", "P", "TD"].includes((c as HTMLElement).tagName))) continue;
    for (const m of p.text.matchAll(EMAIL_RE)) {
      const v = cleanEmail(m[0]);
      if (v && !emails.has(v)) emails.set(v, { value: v, ...personFor(p) });
    }
  }
  for (const m of text.matchAll(OBFUSCATED_RE)) {
    const v = cleanEmail(`${m[1]}@${m[2].replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".")}`);
    if (v && !emails.has(v)) emails.set(v, { value: v, personName: null, role: null });
  }

  const years = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1]));
  const copyrightYear = years.length ? Math.max(...years) : null;

  const dates = new Set(findDates(text));
  for (const t of root.querySelectorAll("time[datetime]")) {
    const v = t.getAttribute("datetime")!.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) dates.add(v);
  }

  const eventDates = new Set<string>();
  for (const h of root.querySelectorAll("h1, h2, h3, h4")) {
    if (!/event|calendar|upcoming|schedule/i.test(h.text)) continue;
    let sib = h.nextElementSibling; let hops = 0;
    while (sib && hops < 6 && !/^H[1-4]$/.test(sib.tagName)) { findDates(sib.text).forEach((d) => eventDates.add(d)); sib = sib.nextElementSibling; hops++; }
  }

  const internal = new Set<string>(); const socials = new Set<string>();
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")!.trim();
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let u: URL; try { u = new URL(href, base); } catch { continue; }
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (SOCIAL_HOSTS.test(host)) { socials.add(u.toString()); continue; }
    if (host !== base.hostname.toLowerCase().replace(/^www\./, "")) continue;
    if (NON_HTML.test(u.pathname)) continue;
    internal.add(u.toString());
  }

  const title = root.querySelector("title")?.text.trim() || null;
  return {
    title,
    metaDescription: root.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || null,
    hasViewport: !!root.querySelector('meta[name="viewport"]'),
    hasForm: root.querySelectorAll("form").some((f) => f.querySelector("textarea, input[type=email], input[name*=email i], input[name*=message i]") !== null || f.querySelectorAll("input").length >= 2),
    emails: [...emails.values()],
    phones: [...new Set([...text.matchAll(PHONE_RE)].map((m) => m[0].trim()))],
    socials: [...socials],
    copyrightYear,
    dates: [...dates],
    eventDates: [...eventDates],
    internalLinks: [...internal],
    isParked: PARKED.test(`${title ?? ""} ${text.slice(0, 3000)}`),
  };
}

const TARGET_PATTERNS = [/contact/i, /about/i, /team|staff|people/i, /blog/i, /news|updates/i, /event|calendar/i];

export function pickCrawlTargets(links: string[], baseUrl: string, max: number): string[] {
  const base = new URL(baseUrl).toString();
  const seen = new Set<string>([base]);
  const out: string[] = [];
  for (const pat of TARGET_PATTERNS) {
    for (const l of links) {
      const u = new URL(l); u.hash = "";
      const s = u.toString();
      if (seen.has(s) || !pat.test(u.pathname)) continue;
      seen.add(s); out.push(s);
      break;
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
```

Note: the modern fixture's form has only 1 named input but `input[name*=email i]` matches. If `node-html-parser` doesn't support the `i` attribute flag, replace those selectors with a manual check over `f.querySelectorAll("input, textarea")` testing `getAttribute("name")` / `getAttribute("type")` with a case-insensitive regex.

- [ ] **Step 5: Run tests and fix until green**

Run: `npm test -- test/extract.test.ts`
Expected: PASS (11 tests). If a regex mismatch fails a case, fix the extractor, not the fixture.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: pure HTML extraction for contacts, dates, basics, parked detection"
```

---

### Task 6: Site crawler orchestration

**Files:**
- Create: `src/worker/crawler/crawl.ts`
- Test: `test/crawl.test.ts`

**Interfaces:**
- Consumes: `extractPage`, `pickCrawlTargets`, `isSocialOnlyUrl` (Task 5); `CrawlFacts` (Task 3); `ContactInput`, `SiteStatus` (Task 2).
- Produces:
  - `type Fetcher = (url: string, init?: RequestInit) => Promise<Response>`
  - `crawlSite(websiteUrl: string | null, o: { fetch: Fetcher; userAgent: string; now: Date; timeoutMs?: number; maxPages?: number }) → Promise<CrawlResult>`
  - `interface CrawlResult { siteStatus: SiteStatus; finalUrl: string | null; facts: CrawlFacts | null; contacts: ContactInput[]; pages: { url: string; status: number; html: string }[]; error: string | null; }`

- [ ] **Step 1: Write the failing tests**

`test/crawl.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { crawlSite, type Fetcher } from "../src/worker/crawler/crawl";

const now = new Date("2026-10-02T00:00:00Z");
const html = (body: string, head = "") => `<html><head>${head}</head><body>${body}</body></html>`;

function fakeFetch(routes: Record<string, { status?: number; body?: string; type?: string; throws?: boolean; redirect?: string }>): Fetcher {
  return async (url) => {
    const r = routes[url];
    if (!r) return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
    if (r.throws) throw new Error("connect timeout");
    const res = new Response(r.body ?? "", { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html" } });
    if (r.redirect) Object.defineProperty(res, "url", { value: r.redirect });
    return res;
  };
}
const opts = (f: Fetcher) => ({ fetch: f, userAgent: "test", now, timeoutMs: 1000, maxPages: 6 });

describe("crawlSite", () => {
  it("null website → no_website", async () => {
    const r = await crawlSite(null, opts(fakeFetch({})));
    expect(r.siteStatus).toBe("no_website");
  });

  it("facebook/yelp listing URL → no_website without fetching", async () => {
    let called = false;
    const r = await crawlSite("https://www.facebook.com/aceplumbing", opts(async () => { called = true; return new Response(""); }));
    expect(r.siteStatus).toBe("no_website");
    expect(called).toBe(false);
  });

  it("network error → unreachable with error message", async () => {
    const r = await crawlSite("https://dead.com", opts(fakeFetch({ "https://dead.com/": { throws: true } })));
    expect(r.siteStatus).toBe("unreachable");
    expect(r.error).toMatch(/timeout/);
  });

  it("403 bot block → unreachable", async () => {
    const r = await crawlSite("https://blocked.com", opts(fakeFetch({ "https://blocked.com/": { status: 403, body: "Just a moment..." } })));
    expect(r.siteStatus).toBe("unreachable");
  });

  it("non-HTML homepage → unreachable", async () => {
    const r = await crawlSite("https://pdf.com", opts(fakeFetch({ "https://pdf.com/": { type: "application/pdf", body: "%PDF" } })));
    expect(r.siteStatus).toBe("unreachable");
  });

  it("parked page → parked", async () => {
    const r = await crawlSite("https://p.com", opts(fakeFetch({ "https://p.com/": { body: html("<h1>Buy this domain</h1>") } })));
    expect(r.siteStatus).toBe("parked");
  });

  it("bare domain gets https:// and crawls linked contact page; merges facts and contacts", async () => {
    const r = await crawlSite("ace.com", opts(fakeFetch({
      "https://ace.com/": { body: html(`<a href="/contact">Contact</a><a href="/gone">x</a><a href="/gone2">x</a><a href="/gone3">x</a><p>© 2020 Ace</p><p>Call (208) 555-0134</p>`, "<title>Ace</title>") },
      "https://ace.com/contact": { body: html(`<form><input name="email"><textarea></textarea></form><a href="mailto:info@ace.com">mail</a>`) },
    })));
    expect(r.siteStatus).toBe("ok");
    expect(r.facts!.https).toBe(true);
    expect(r.facts!.copyrightYear).toBe(2020);
    expect(r.facts!.hasContactForm).toBe(true);
    expect(r.facts!.emailCount).toBe(1);
    expect(r.facts!.hasViewport).toBe(false);
    expect(r.contacts.find((c) => c.type === "email")!.value).toBe("info@ace.com");
    expect(r.contacts.find((c) => c.type === "form")!.value).toBe("https://ace.com/contact");
    expect(r.contacts.some((c) => c.type === "phone")).toBe(true);
  });

  it("counts broken internal links from homepage via HEAD/GET status", async () => {
    const r = await crawlSite("https://ace.com", opts(fakeFetch({
      "https://ace.com/": { body: html(`<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>`) },
    })));
    expect(r.facts!.brokenLinkCount).toBe(3);
  });

  it("http-only site → https false", async () => {
    const r = await crawlSite("http://old.com", opts(fakeFetch({
      "https://old.com/": { throws: true },
      "http://old.com/": { body: html("<p>hi</p>") },
    })));
    expect(r.siteStatus).toBe("ok");
    expect(r.facts!.https).toBe(false);
  });

  it("latestContentDate ignores future dates; pastEventDates only past", async () => {
    const r = await crawlSite("https://ev.com", opts(fakeFetch({
      "https://ev.com/": { body: html(`<p>Posted January 5, 2024</p><p>Posted December 1, 2030</p><h3>Events</h3><p>May 1, 2025</p><p>Dec 1, 2026</p>`) },
    })));
    expect(r.facts!.latestContentDate).toBe("2025-05-01");
    expect(r.facts!.pastEventDates).toEqual(["2025-05-01"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/crawl.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/worker/crawler/crawl.ts`:
```ts
import type { ContactInput, SiteStatus } from "../types";
import type { CrawlFacts } from "../scoring/scorer";
import { extractPage, isSocialOnlyUrl, pickCrawlTargets, type PageFacts } from "./extract";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface CrawlResult {
  siteStatus: SiteStatus; finalUrl: string | null; facts: CrawlFacts | null; contacts: ContactInput[];
  pages: { url: string; status: number; html: string }[]; error: string | null;
}
interface Opts { fetch: Fetcher; userAgent: string; now: Date; timeoutMs?: number; maxPages?: number; }

const MAX_BROKEN_CHECKS = 15;

async function get(url: string, o: Opts, method = "GET") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 10_000);
  try {
    return await o.fetch(url, { method, redirect: "follow", signal: ctrl.signal, headers: { "user-agent": o.userAgent, accept: "text/html" } });
  } finally { clearTimeout(t); }
}

const isHtml = (r: Response) => (r.headers.get("content-type") ?? "").includes("text/html");
const empty = (status: SiteStatus, error: string | null = null): CrawlResult =>
  ({ siteStatus: status, finalUrl: null, facts: null, contacts: [], pages: [], error });

function normalize(url: string): string {
  const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  u.hash = ""; if (!u.pathname) u.pathname = "/";
  return u.toString();
}

export async function crawlSite(websiteUrl: string | null, o: Opts): Promise<CrawlResult> {
  if (!websiteUrl || !websiteUrl.trim()) return empty("no_website");
  let start: string;
  try { start = normalize(websiteUrl.trim()); } catch { return empty("no_website"); }
  if (isSocialOnlyUrl(start)) return empty("no_website");

  const candidates = start.startsWith("http://") ? [start.replace("http://", "https://"), start] : [start, start.replace("https://", "http://")];
  let home: Response | null = null; let homeUrl = ""; let lastErr: string | null = null;
  for (const c of candidates) {
    try {
      const r = await get(c, o);
      home = r; homeUrl = r.url || c;
      break;
    } catch (e) { lastErr = (e as Error).message; }
  }
  if (!home) return empty("unreachable", lastErr ?? "fetch failed");
  if (home.status >= 400) return empty("unreachable", `HTTP ${home.status}`);
  if (!isHtml(home)) return empty("unreachable", `Homepage is ${home.headers.get("content-type")}`);

  const homeHtml = await home.text();
  const homeFacts = extractPage(homeHtml, homeUrl);
  if (homeFacts.isParked) return { ...empty("parked"), finalUrl: homeUrl };

  const pages: CrawlResult["pages"] = [{ url: homeUrl, status: home.status, html: homeHtml }];
  const facts: { url: string; f: PageFacts }[] = [{ url: homeUrl, f: homeFacts }];

  const targets = pickCrawlTargets(homeFacts.internalLinks, homeUrl, (o.maxPages ?? 6) - 1);
  for (const t of targets) {
    try {
      const r = await get(t, o);
      if (r.status >= 400 || !isHtml(r)) continue;
      const h = await r.text();
      pages.push({ url: t, status: r.status, html: h });
      facts.push({ url: t, f: extractPage(h, t) });
    } catch { /* skip page */ }
  }

  const crawled = new Set(pages.map((p) => p.url));
  const toCheck = homeFacts.internalLinks.filter((l) => !crawled.has(l)).slice(0, MAX_BROKEN_CHECKS);
  let broken = 0;
  await Promise.all(toCheck.map(async (l) => {
    try { const r = await get(l, o, "HEAD"); if (r.status === 404 || r.status === 410) broken++; } catch { /* ignore */ }
  }));

  const today = o.now.toISOString().slice(0, 10);
  const allDates = [...new Set(facts.flatMap((x) => x.f.dates))].filter((d) => d <= today).sort();
  const pastEvents = [...new Set(facts.flatMap((x) => x.f.eventDates))].filter((d) => d < today).sort();
  const years = facts.map((x) => x.f.copyrightYear).filter((y): y is number => y !== null);

  const contacts: ContactInput[] = [];
  const seenEmail = new Set<string>();
  for (const { url, f } of facts) {
    for (const e of f.emails) {
      if (seenEmail.has(e.value)) continue; seenEmail.add(e.value);
      contacts.push({ type: "email", value: e.value, source_url: url, person_name: e.personName, role: e.role, confidence: e.personName ? 0.9 : 0.7 });
    }
  }
  const formPage = facts.find((x) => x.f.hasForm && /contact/i.test(x.url)) ?? facts.find((x) => x.f.hasForm);
  if (formPage) contacts.push({ type: "form", value: formPage.url, source_url: formPage.url, person_name: null, role: null, confidence: 0.6 });
  const phone = facts.flatMap((x) => x.f.phones)[0];
  if (phone) contacts.push({ type: "phone", value: phone, source_url: homeUrl, person_name: null, role: null, confidence: 0.5 });
  for (const s of [...new Set(facts.flatMap((x) => x.f.socials))].slice(0, 5))
    contacts.push({ type: "social", value: s, source_url: homeUrl, person_name: null, role: null, confidence: 0.4 });

  return {
    siteStatus: "ok", finalUrl: homeUrl, pages, error: null, contacts,
    facts: {
      https: homeUrl.startsWith("https://"),
      hasTitle: !!homeFacts.title,
      hasMetaDescription: !!homeFacts.metaDescription,
      hasViewport: homeFacts.hasViewport,
      hasContactForm: !!formPage,
      emailCount: seenEmail.size,
      copyrightYear: years.length ? Math.max(...years) : null,
      latestContentDate: allDates.at(-1) ?? null,
      pastEventDates: pastEvents,
      brokenLinkCount: broken,
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/crawl.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: site crawler with status detection, contacts, broken links"
```

---

### Task 7: PageSpeed client

**Files:**
- Create: `src/worker/pagespeed.ts`, `test/fixtures/psi.json`
- Test: `test/pagespeed.test.ts`

**Interfaces:**
- Consumes: `PageSpeedFacts` (Task 3), `Fetcher` (Task 6).
- Produces:
  - `class RateLimitedError extends Error`
  - `runPageSpeed(url: string, o: { apiKey: string; fetch: Fetcher }) → Promise<{ facts: PageSpeedFacts; raw: unknown }>` — throws `RateLimitedError` on 429, `Error` on other failures.

- [ ] **Step 1: Create a trimmed fixture**

`test/fixtures/psi.json`:
```json
{
  "lighthouseResult": {
    "categories": { "performance": { "score": 0.34 } },
    "audits": {
      "largest-contentful-paint": { "numericValue": 8412.6 },
      "cumulative-layout-shift": { "numericValue": 0.31 },
      "viewport": { "score": 1 },
      "font-size": { "score": 0 },
      "tap-targets": { "score": 1 }
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

`test/pagespeed.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { runPageSpeed, RateLimitedError } from "../src/worker/pagespeed";
import psi from "./fixtures/psi.json";

describe("runPageSpeed", () => {
  it("maps lighthouse JSON to facts and calls mobile strategy", async () => {
    let called = "";
    const r = await runPageSpeed("https://ace.com/", {
      apiKey: "K", fetch: async (u) => { called = u; return Response.json(psi); },
    });
    expect(called).toContain("strategy=mobile");
    expect(called).toContain("key=K");
    expect(called).toContain(encodeURIComponent("https://ace.com/"));
    expect(r.facts).toEqual({ performanceScore: 34, lcpMs: 8413, cls: 0.31, mobileFriendly: false });
  });

  it("missing font-size/tap-targets audits → mobileFriendly true when viewport passes", async () => {
    const r = await runPageSpeed("https://a.com/", { apiKey: "K", fetch: async () => Response.json({
      lighthouseResult: { categories: { performance: { score: 0.9 } }, audits: {
        "largest-contentful-paint": { numericValue: 1000 }, "cumulative-layout-shift": { numericValue: 0 }, viewport: { score: 1 } } } }) });
    expect(r.facts.mobileFriendly).toBe(true);
  });

  it("429 → RateLimitedError", async () => {
    await expect(runPageSpeed("https://a.com/", { apiKey: "K", fetch: async () => new Response("", { status: 429 }) }))
      .rejects.toBeInstanceOf(RateLimitedError);
  });

  it("500 → Error with status", async () => {
    await expect(runPageSpeed("https://a.com/", { apiKey: "K", fetch: async () => new Response("boom", { status: 500 }) }))
      .rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- test/pagespeed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/worker/pagespeed.ts`:
```ts
import type { PageSpeedFacts } from "./scoring/scorer";
import type { Fetcher } from "./crawler/crawl";

export class RateLimitedError extends Error {}

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export async function runPageSpeed(url: string, o: { apiKey: string; fetch: Fetcher }) {
  const q = `${ENDPOINT}?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${o.apiKey}`;
  const res = await o.fetch(q);
  if (res.status === 429) throw new RateLimitedError("PageSpeed rate limited");
  if (!res.ok) throw new Error(`PageSpeed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = (await res.json()) as any;
  const lh = raw.lighthouseResult;
  const a = lh.audits ?? {};
  const passes = (k: string) => a[k] === undefined || a[k].score === null || a[k].score >= 0.9;
  const facts: PageSpeedFacts = {
    performanceScore: Math.round((lh.categories.performance.score ?? 0) * 100),
    lcpMs: Math.round(a["largest-contentful-paint"]?.numericValue ?? 0),
    cls: Math.round((a["cumulative-layout-shift"]?.numericValue ?? 0) * 100) / 100,
    mobileFriendly: passes("viewport") && passes("font-size") && passes("tap-targets"),
  };
  return { facts, raw };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- test/pagespeed.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: PageSpeed Insights client"
```

---

### Task 8: Listing source (Bright Data) + fake

**Files:**
- Create: `src/worker/listings/source.ts`, `src/worker/listings/brightdata.ts`, `src/worker/listings/fake.ts`, `test/fixtures/brightdata-maps.json`
- Test: `test/brightdata.test.ts`

**Interfaces:**
- Consumes: `Listing` (Task 2), `Fetcher` (Task 6).
- Produces:
  - `interface ListingQuery { location: string; businessType: string; radiusKm: number; maxResults: number }`
  - `interface ListingSource { search(q: ListingQuery): Promise<{ listings: Listing[]; requests: number }> }`
  - `class BrightDataListingSource implements ListingSource` — `constructor(o: { apiKey: string; zone: string; fetch: Fetcher })`
  - `mapBrightDataItem(item: Record<string, unknown>) → Listing | null`
  - `class FakeListingSource implements ListingSource` — `constructor(listings: Listing[] | Error)`
  - `BRIGHTDATA_PAGE_SIZE = 20`

Bright Data's SERP API accepts `POST https://api.brightdata.com/request` with `{ zone, url, format: "raw" }`; adding `brd_json=1` to a `https://www.google.com/maps/search/...` URL returns parsed JSON. The exact field names for Maps results aren't documented in our reference, so Step 1 captures a real response and the mapper reads several known aliases.

- [ ] **Step 1: Capture a real fixture (needs Logan's key + SERP zone)**

```bash
curl -s https://api.brightdata.com/request \
  -H "Authorization: Bearer $BRIGHTDATA_API_KEY" -H "Content-Type: application/json" \
  -d "{\"zone\":\"$BRIGHTDATA_SERP_ZONE\",\"url\":\"https://www.google.com/maps/search/plumber+in+Boise,+ID/?brd_json=1&gl=us&hl=en\",\"format\":\"raw\"}" \
  | tee test/fixtures/brightdata-maps.json | head -c 2000
```

Inspect the JSON: find the array of places (likely top-level `organic`, or `maps`/`local_results`) and note the field names for name, address, phone, website, rating, review count, place/feature id, and maps link. **Update `PLACE_ARRAYS` and the alias lists in Step 4 to include the real names.** If no key is available yet, hand-write a 2-item fixture using the aliases below and leave a note in the commit message to re-capture.

- [ ] **Step 2: Write the failing tests**

`test/brightdata.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { BrightDataListingSource, mapBrightDataItem } from "../src/worker/listings/brightdata";
import fixture from "./fixtures/brightdata-maps.json";

describe("mapBrightDataItem", () => {
  it("maps common alias fields", () => {
    expect(mapBrightDataItem({
      title: "Ace Plumbing", category: "Plumber", address: "1 Main St, Boise, ID", phone: "(208) 555-0134",
      link: "https://aceplumbing.com/", rating: "4.6", reviews_cnt: 132, fid: "0x123:0x456",
      map_link: "https://maps.google.com/?cid=1",
    })).toEqual({
      placeId: "0x123:0x456", name: "Ace Plumbing", category: "Plumber", address: "1 Main St, Boise, ID",
      phone: "(208) 555-0134", websiteUrl: "https://aceplumbing.com/", mapsUrl: "https://maps.google.com/?cid=1",
      rating: 4.6, reviewCount: 132,
    });
  });

  it("returns null when no name", () => {
    expect(mapBrightDataItem({ address: "x" })).toBeNull();
  });

  it("ignores google.com links as websites", () => {
    expect(mapBrightDataItem({ title: "A", link: "https://www.google.com/maps/place/x" })!.websiteUrl).toBeNull();
  });
});

describe("BrightDataListingSource", () => {
  it("every listing parsed from the captured fixture has a name", async () => {
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async () => Response.json(fixture) });
    const { listings } = await src.search({ location: "Boise, ID", businessType: "plumber", radiusKm: 15, maxResults: 20 });
    expect(listings.length).toBeGreaterThan(0);
    for (const l of listings) expect(l.name.length).toBeGreaterThan(0);
  });

  it("pages until maxResults, dedupes, stops on empty page, counts requests", async () => {
    const calls: string[] = [];
    const page = (ids: string[]) => ({ organic: ids.map((id) => ({ title: `B${id}`, fid: id })) });
    const pages = [page(["1", "2"]), page(["2", "3"]), page([])];
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async (_u, init) => {
      calls.push(JSON.parse(init!.body as string).url); return Response.json(pages[calls.length - 1]);
    } });
    const r = await src.search({ location: "Boise, ID", businessType: "plumber", radiusKm: 15, maxResults: 50 });
    expect(r.listings.map((l) => l.placeId)).toEqual(["1", "2", "3"]);
    expect(r.requests).toBe(3);
    expect(calls[0]).toContain("/maps/search/plumber%20in%20Boise%2C%20ID");
    expect(calls[0]).toContain("brd_json=1");
    expect(calls[1]).toContain("start=20");
  });

  it("throws with status on HTTP error", async () => {
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async () => new Response("bad zone", { status: 401 }) });
    await expect(src.search({ location: "x", businessType: "y", radiusKm: 1, maxResults: 5 })).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- test/brightdata.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/worker/listings/source.ts`:
```ts
import type { Listing } from "../types";

export interface ListingQuery { location: string; businessType: string; radiusKm: number; maxResults: number; }
export interface ListingSource { search(q: ListingQuery): Promise<{ listings: Listing[]; requests: number }>; }
```

`src/worker/listings/brightdata.ts`:
```ts
import type { Listing } from "../types";
import type { Fetcher } from "../crawler/crawl";
import type { ListingQuery, ListingSource } from "./source";

export const BRIGHTDATA_PAGE_SIZE = 20;
const MAX_PAGES = 10;
const PLACE_ARRAYS = ["organic", "maps", "local_results", "places", "results"];

const pick = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return null;
};
const str = (v: unknown) => (v === null ? null : String(v).trim() || null);
const num = (v: unknown) => { if (v === null) return null; const n = Number(String(v).replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : null; };

export function mapBrightDataItem(o: Record<string, unknown>): Listing | null {
  const name = str(pick(o, ["title", "name", "business_name"]));
  if (!name) return null;
  let website = str(pick(o, ["website", "site", "link", "url", "domain"]));
  if (website && /(^|\.)google\.[a-z.]+\//i.test(website)) website = null;
  return {
    placeId: str(pick(o, ["place_id", "fid", "cid", "data_id", "feature_id"])),
    name,
    category: str(pick(o, ["category", "type", "main_category"])),
    address: str(pick(o, ["address", "full_address"])),
    phone: str(pick(o, ["phone", "phone_number"])),
    websiteUrl: website,
    mapsUrl: str(pick(o, ["map_link", "maps_url", "map_url", "google_maps_url"])),
    rating: num(pick(o, ["rating", "stars"])),
    reviewCount: num(pick(o, ["reviews_cnt", "reviews_count", "review_count", "reviews"])),
  };
}

function itemsOf(json: any): Record<string, unknown>[] {
  for (const k of PLACE_ARRAYS) if (Array.isArray(json?.[k])) return json[k];
  return [];
}

export class BrightDataListingSource implements ListingSource {
  constructor(private o: { apiKey: string; zone: string; fetch: Fetcher }) {}

  async search(q: ListingQuery) {
    const seen = new Set<string>();
    const listings: Listing[] = [];
    let requests = 0;
    const term = encodeURIComponent(`${q.businessType} in ${q.location}`);
    for (let p = 0; p < MAX_PAGES && listings.length < q.maxResults; p++) {
      const url = `https://www.google.com/maps/search/${term}/?brd_json=1&gl=us&hl=en${p ? `&start=${p * BRIGHTDATA_PAGE_SIZE}` : ""}`;
      const res = await this.o.fetch("https://api.brightdata.com/request", {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ zone: this.o.zone, url, format: "raw" }),
      });
      requests++;
      if (!res.ok) throw new Error(`Bright Data HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const items = itemsOf(await res.json());
      if (!items.length) break;
      let added = 0;
      for (const it of items) {
        const l = mapBrightDataItem(it);
        if (!l) continue;
        const key = l.placeId ?? `${l.name}|${l.address}`;
        if (seen.has(key)) continue;
        seen.add(key); listings.push(l); added++;
        if (listings.length >= q.maxResults) break;
      }
      if (!added) break;
    }
    return { listings, requests };
  }
}
```

`src/worker/listings/fake.ts`:
```ts
import type { Listing } from "../types";
import type { ListingQuery, ListingSource } from "./source";

export class FakeListingSource implements ListingSource {
  constructor(private result: Listing[] | Error) {}
  async search(q: ListingQuery) {
    if (this.result instanceof Error) throw this.result;
    return { listings: this.result.slice(0, q.maxResults), requests: 1 };
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- test/brightdata.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Bright Data Google Maps listing source"
```

---

### Task 9: Email drafter

**Files:**
- Create: `src/worker/drafter/prompt.ts`, `src/worker/drafter/draft.ts`
- Test: `test/drafter.test.ts`

**Interfaces:**
- Consumes: `Settings`, `Business`, `Finding`, `Offer`, `Contact` (Task 2); `pickRecipient` (Task 4).
- Produces:
  - `interface DraftInput { settings: Settings; business: Business; findings: Finding[]; offer: Offer; contacts: Contact[]; steeringNote: string | null }`
  - `buildPrompt(i: DraftInput) → { system: string; user: string }`
  - `type ClaudeCaller = (p: { system: string; user: string }) => Promise<unknown>` — returns the `input` object of the forced tool call.
  - `anthropicCaller(apiKey: string) → ClaudeCaller`
  - `generateDraft(i: DraftInput, call: ClaudeCaller) → Promise<{ subject: string; body: string; to_contact_id: string | null; recipient_reason: string }>`
  - `DRAFT_MODEL = "claude-sonnet-5-5"`
  - `wordCount(s: string) → number`

- [ ] **Step 1: Write the failing tests**

`test/drafter.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildPrompt, generateDraft, wordCount, type DraftInput } from "../src/worker/drafter/draft";
import type { Business, Contact, Settings } from "../src/worker/types";

const settings: Settings = {
  your_name: "Logan Irish", business_name: "Irish Web", contact_email: "l@x.com", services_blurb: "I build and care for small-business sites.",
  signature: "Logan Irish\nIrish Web", physical_address: "123 Main St, Boise, ID 83702",
  opt_out_line: "Reply 'no thanks' and I won't follow up.", tone_notes: "Plain, friendly, no hype.", monthly_spend_limit_usd: 25,
};
const business = { id: "b1", name: "Ace Plumbing", category: "Plumber", address: "Boise, ID", website_url: "https://ace.com" } as Business;
const contacts: Contact[] = [
  { id: "c1", business_id: "b1", type: "email", value: "info@ace.com", source_url: "https://ace.com/contact", person_name: null, role: null, confidence: 0.7 },
];
const input: DraftInput = {
  settings, business, contacts, offer: "performance", steeringNote: null,
  findings: [
    { code: "slow_mobile", group: "speed", severity: "high", points: 25, evidence: "Scores 34/100 on Google's mobile speed test" },
    { code: "slow_lcp", group: "speed", severity: "medium", points: 10, evidence: "Main content takes about 8.4 seconds to appear on a phone" },
    { code: "old_copyright", group: "stale", severity: "medium", points: 10, evidence: "The footer still says © 2019" },
    { code: "layout_shift", group: "speed", severity: "low", points: 5, evidence: "The page jumps around while it loads" },
  ],
};
const body = (extra = "") => `Hi Ace team,\n\nYour site takes about 8 seconds to load on a phone.${extra}\n\nLogan Irish\nIrish Web\n123 Main St, Boise, ID 83702\nReply 'no thanks' and I won't follow up.`;

describe("buildPrompt", () => {
  it("includes only top 3 findings, offer, contacts, tone, footer, and banned jargon rule", () => {
    const p = buildPrompt(input);
    expect(p.user).toContain("Scores 34/100");
    expect(p.user).not.toContain("jumps around");
    expect(p.user).toContain("performance");
    expect(p.user).toContain("c1: info@ace.com");
    expect(p.system).toContain("Plain, friendly, no hype.");
    expect(p.system).toContain("123 Main St, Boise, ID 83702");
    expect(p.system).toMatch(/120 words/);
    expect(p.system).toMatch(/LCP/);
  });
  it("includes steering note when given", () => {
    expect(buildPrompt({ ...input, steeringNote: "mention I'm local" }).user).toContain("mention I'm local");
  });
});

describe("generateDraft", () => {
  it("returns validated draft", async () => {
    const d = await generateDraft(input, async () => ({ subject: "Quick note about ace.com", body: body(), to_contact_id: "c1", recipient_reason: "info inbox" }));
    expect(d.to_contact_id).toBe("c1");
    expect(d.subject).toBe("Quick note about ace.com");
  });

  it("rejects hallucinated contact id and falls back to recipient ranking", async () => {
    const d = await generateDraft(input, async () => ({ subject: "s", body: body(), to_contact_id: "made-up", recipient_reason: "x" }));
    expect(d.to_contact_id).toBe("c1");
  });

  it("null contact when no email contacts exist, reason from ranking", async () => {
    const form: Contact = { ...contacts[0], id: "f1", type: "form", value: "https://ace.com/contact" };
    const d = await generateDraft({ ...input, contacts: [form] }, async () => ({ subject: "s", body: body(), to_contact_id: "f1", recipient_reason: "x" }));
    expect(d.to_contact_id).toBeNull();
    expect(d.recipient_reason).toMatch(/contact form/);
  });

  it("appends missing address and opt-out verbatim", async () => {
    const d = await generateDraft(input, async () => ({ subject: "s", body: "Hi,\n\nShort note.\n\nLogan", to_contact_id: "c1", recipient_reason: "x" }));
    expect(d.body).toContain("123 Main St, Boise, ID 83702");
    expect(d.body).toContain("Reply 'no thanks' and I won't follow up.");
  });

  it("retries once on malformed output, then succeeds", async () => {
    let n = 0;
    const d = await generateDraft(input, async () => (n++ === 0 ? { nope: true } : { subject: "s", body: body(), to_contact_id: "c1", recipient_reason: "x" }));
    expect(n).toBe(2);
    expect(d.subject).toBe("s");
  });

  it("throws after two malformed outputs", async () => {
    await expect(generateDraft(input, async () => ({ nope: true }))).rejects.toThrow(/malformed/i);
  });

  it("wordCount counts words", () => {
    expect(wordCount("a b  c\n d")).toBe(4);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/drafter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/worker/drafter/prompt.ts`:
```ts
import type { Business, Contact, Finding, Offer, Settings } from "../types";

export interface DraftInput {
  settings: Settings; business: Business; findings: Finding[]; offer: Offer; contacts: Contact[]; steeringNote: string | null;
}

const OFFER_TEXT: Record<Offer, string> = {
  new_site: "a new, simple, mobile-friendly website",
  performance: "a speed and mobile fix for their existing site",
  care_plan: "ongoing website care: keeping content, links and updates current",
  seo_basics: "fixing the basics so Google and visitors trust the site (security, titles, contact options)",
};

export function buildPrompt(i: DraftInput) {
  const s = i.settings;
  const system = `You write short cold emails for ${s.your_name || "a freelance web developer"}${s.business_name ? ` of ${s.business_name}` : ""}, a local web developer.
About them: ${s.services_blurb || "Builds and maintains websites for small local businesses."}
Voice: ${s.tone_notes || "Plain, friendly, direct. No hype."}

Rules:
- Body under 120 words, plain text, no markdown, no bullet symbols.
- Open with something specific to this business (their name, trade, or town), never a generic pleasantry like "I hope this finds you well".
- Mention at most 3 problems, in plain English, using the evidence given. Never use jargon such as LCP, CLS, Core Web Vitals, meta description, viewport, or SEO acronyms.
- Do not claim anything that is not in the findings provided.
- One call to action only: offer a free 5-minute mini-audit or a short call.
- End the body with exactly these lines, copied verbatim:
${s.signature}
${s.physical_address}
${s.opt_out_line}
- Choose to_contact_id only from the contact ids listed. Use null if no email contact is suitable.
Return your answer by calling the write_email tool.`;

  const top = [...i.findings].sort((a, b) => b.points - a.points).slice(0, 3);
  const contactLines = i.contacts.length
    ? i.contacts.map((c) => `${c.id}: ${c.value} (${c.type}${c.person_name ? `, ${c.person_name}` : ""}${c.role ? `, ${c.role}` : ""})`).join("\n")
    : "none";
  const user = `Business: ${i.business.name}
Category: ${i.business.category ?? "unknown"}
Location: ${i.business.address ?? "unknown"}
Website: ${i.business.website_url ?? "none"}

Findings (most important first):
${top.map((f) => `- ${f.evidence}`).join("\n") || "- none"}

Offer to lead with: ${i.offer} — ${OFFER_TEXT[i.offer]}

Contacts:
${contactLines}${i.steeringNote ? `\n\nExtra instruction for this draft: ${i.steeringNote}` : ""}`;

  return { system, user };
}
```

`src/worker/drafter/draft.ts`:
```ts
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { pickRecipient } from "../recipient";
import { domainOf } from "../db/businesses";
import { buildPrompt, type DraftInput } from "./prompt";

export { buildPrompt, type DraftInput };
export const DRAFT_MODEL = "claude-sonnet-5-5";
export type ClaudeCaller = (p: { system: string; user: string }) => Promise<unknown>;

const Output = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  to_contact_id: z.string().nullable(),
  recipient_reason: z.string(),
});

const TOOL = {
  name: "write_email",
  description: "Return the drafted outreach email.",
  input_schema: {
    type: "object" as const,
    properties: {
      subject: { type: "string" },
      body: { type: "string" },
      to_contact_id: { type: ["string", "null"] },
      recipient_reason: { type: "string" },
    },
    required: ["subject", "body", "to_contact_id", "recipient_reason"],
  },
};

export function anthropicCaller(apiKey: string): ClaudeCaller {
  const client = new Anthropic({ apiKey });
  return async ({ system, user }) => {
    const msg = await client.messages.create({
      model: DRAFT_MODEL, max_tokens: 800, system,
      tools: [TOOL], tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: user }],
    });
    const block = msg.content.find((b) => b.type === "tool_use");
    return block && "input" in block ? block.input : null;
  };
}

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export async function generateDraft(i: DraftInput, call: ClaudeCaller) {
  const prompt = buildPrompt(i);
  let parsed: z.infer<typeof Output> | null = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const r = Output.safeParse(await call(prompt));
    if (r.success) parsed = r.data;
  }
  if (!parsed) throw new Error("Claude returned malformed draft output twice");

  const ranked = pickRecipient(i.contacts, domainOf(i.business.website_url));
  const emailIds = new Set(i.contacts.filter((c) => c.type === "email").map((c) => c.id));
  let toId = parsed.to_contact_id && emailIds.has(parsed.to_contact_id) ? parsed.to_contact_id : null;
  let reason = parsed.recipient_reason;
  if (!toId) { toId = ranked.emailContact?.id ?? null; reason = ranked.reason; }

  let body = parsed.body.trimEnd();
  for (const line of [i.settings.physical_address, i.settings.opt_out_line]) {
    if (line && !body.includes(line)) body += `\n${line}`;
  }
  return { subject: parsed.subject.trim(), body, to_contact_id: toId, recipient_reason: reason };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/drafter.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Claude email drafter with validation and footer enforcement"
```

---

### Task 10: Cost estimates and spend guard

**Files:**
- Create: `src/worker/cost.ts`
- Test: `test/cost.test.ts`

**Interfaces:**
- Consumes: `monthUsage`, `recordUsage` (Task 2); `getSettings` (Task 2); `BRIGHTDATA_PAGE_SIZE` (Task 8).
- Produces:
  - `PRICES = { brightdataPerRequest: 0.0015, pagespeedPerCall: 0, claudePerDraft: 0.01 }`
  - `estimateSearchCost(maxResults: number) → number` (USD; Bright Data requests + Claude drafts upper bound)
  - `checkSpend(db, extraUsd: number) → Promise<{ ok: boolean; spent: number; limit: number }>`

- [ ] **Step 1: Write the failing tests**

`test/cost.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { estimateSearchCost, checkSpend, PRICES } from "../src/worker/cost";
import { recordUsage } from "../src/worker/db/usage";
import { saveSettings } from "../src/worker/db/settings";

describe("cost", () => {
  it("estimates pages + drafts", () => {
    expect(estimateSearchCost(50)).toBeCloseTo(3 * PRICES.brightdataPerRequest + 50 * PRICES.claudePerDraft);
  });

  it("blocks when this month's spend + estimate exceeds limit", async () => {
    await saveSettings(env.DB, { monthly_spend_limit_usd: 1 });
    await recordUsage(env.DB, "claude", 90, 0.9);
    expect((await checkSpend(env.DB, 0.05)).ok).toBe(true);
    expect((await checkSpend(env.DB, 0.2)).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/cost.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/worker/cost.ts`:
```ts
import { monthUsage } from "./db/usage";
import { getSettings } from "./db/settings";
import { BRIGHTDATA_PAGE_SIZE } from "./listings/brightdata";

// Rough list prices; update when invoices disagree.
export const PRICES = { brightdataPerRequest: 0.0015, pagespeedPerCall: 0, claudePerDraft: 0.01 };

export function estimateSearchCost(maxResults: number): number {
  const pages = Math.ceil(maxResults / BRIGHTDATA_PAGE_SIZE);
  return pages * PRICES.brightdataPerRequest + maxResults * PRICES.claudePerDraft;
}

export async function checkSpend(db: D1Database, extraUsd: number) {
  const month = new Date().toISOString().slice(0, 7);
  const spent = (await monthUsage(db, month)).reduce((s, r) => s + r.est_cost_usd, 0);
  const limit = (await getSettings(db)).monthly_spend_limit_usd;
  return { ok: spent + extraUsd <= limit, spent, limit };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/cost.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: cost estimate and monthly spend guard"
```

---

### Task 11: Auth

**Files:**
- Create: `src/worker/auth.ts`, `src/worker/routes/auth.ts`
- Modify: `src/worker/index.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: `Env` (Task 1).
- Produces:
  - `signSession(secret: string, expiresAt: number) → Promise<string>`; `verifySession(secret: string, token: string, now: number) → Promise<boolean>`
  - `requireAuth` Hono middleware (401 JSON `{error:"unauthorized"}` when cookie missing/invalid) applied to `/api/*` except `/api/health`, `/api/login`.
  - Routes: `POST /api/login {password}` → 200 + `Set-Cookie: session=...; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` or 401; `POST /api/logout`; `GET /api/me` → `{ok:true}` when authed.

- [ ] **Step 1: Write the failing tests**

`test/auth.test.ts`:
```ts
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "../src/worker/auth";

describe("session tokens", () => {
  it("verifies own token, rejects tampered or expired", async () => {
    const t = await signSession("s", 2000);
    expect(await verifySession("s", t, 1000)).toBe(true);
    expect(await verifySession("s", t, 3000)).toBe(false);
    expect(await verifySession("other", t, 1000)).toBe(false);
    expect(await verifySession("s", t.replace(/^\d+/, "9999"), 1000)).toBe(false);
  });
});

describe("auth routes", () => {
  it("blocks /api/me without cookie", async () => {
    expect((await SELF.fetch("https://x/api/me")).status).toBe(401);
  });

  it("wrong password 401, right password sets cookie that unlocks /api/me", async () => {
    const bad = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(401);
    const ok = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    const me = await SELF.fetch("https://x/api/me", { headers: { cookie: cookie.split(";")[0] } });
    expect(me.status).toBe(200);
  });

  it("health stays public", async () => {
    expect((await SELF.fetch("https://x/api/health")).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/worker/auth.ts`:
```ts
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "./env";

const enc = new TextEncoder();
async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "");
}

export async function signSession(secret: string, expiresAt: number) {
  return `${expiresAt}.${await hmac(secret, String(expiresAt))}`;
}

export async function verifySession(secret: string, token: string, now: number) {
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < now) return false;
  const expected = await hmac(secret, exp);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export async function passwordMatches(given: string, actual: string) {
  const [a, b] = await Promise.all([hmac("pw", given), hmac("pw", actual)]);
  return a === b;
}

const PUBLIC = new Set(["/api/health", "/api/login"]);

export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (PUBLIC.has(c.req.path)) return next();
  const token = getCookie(c, "session");
  if (!token || !(await verifySession(c.env.SESSION_SECRET, token, Date.now()))) return c.json({ error: "unauthorized" }, 401);
  return next();
};
```

`src/worker/routes/auth.ts`:
```ts
import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../env";
import { passwordMatches, signSession } from "../auth";

const THIRTY_DAYS = 30 * 24 * 3600;
export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.post("/login", async (c) => {
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: "" }));
  if (!password || !(await passwordMatches(password, c.env.APP_PASSWORD))) return c.json({ error: "wrong password" }, 401);
  const token = await signSession(c.env.SESSION_SECRET, Date.now() + THIRTY_DAYS * 1000);
  setCookie(c, "session", token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: THIRTY_DAYS });
  return c.json({ ok: true });
});

authRoutes.post("/logout", (c) => { deleteCookie(c, "session", { path: "/" }); return c.json({ ok: true }); });
authRoutes.get("/me", (c) => c.json({ ok: true }));
```

`src/worker/index.ts`:
```ts
import { Hono } from "hono";
import type { Env } from "./env";
import { requireAuth } from "./auth";
import { authRoutes } from "./routes/auth";

const app = new Hono<{ Bindings: Env }>();
app.use("/api/*", requireAuth);
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", authRoutes);

export default app;
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: single-password auth with signed session cookie"
```

---

### Task 12: Lead pipeline + LeadWorkflow

**Files:**
- Create: `src/worker/pipeline/lead.ts`, `src/worker/workflows.ts`
- Modify: `src/worker/index.ts` (export workflow classes), `wrangler.jsonc` (ensure `workflows` block present)
- Test: `test/pipeline-lead.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces:
  - `interface StepLike { do<T>(name: string, fn: () => Promise<T>): Promise<T>; sleep(name: string, ms: number): Promise<void> }` (exported from `pipeline/lead.ts`)
  - `interface LeadDeps { db: D1Database; raw: R2Bucket; fetch: Fetcher; pagespeedKey: string; claude: ClaudeCaller; now: () => Date }`
  - `runLead(deps: LeadDeps, step: StepLike, p: { businessId: string; searchId: string | null; forceDraft?: boolean; steeringNote?: string | null }) → Promise<{ auditId: string; draftId: string | null }>`
  - `regenerateDraft(deps, businessId, steeringNote) → Promise<Draft>` — draft step only, using latest audit.
  - `LeadWorkflow` (params `{ businessId, searchId, forceDraft? }`) and `SearchWorkflow` classes in `workflows.ts` (SearchWorkflow body added in Task 13).
  - `depsFromEnv(env: Env) → LeadDeps`.

Behaviour of `runLead`:
1. `step.do("crawl")` → `crawlSite`; store `pages` HTML to R2 key `audits/<businessId>/<timestamp>.json`; `replaceContacts`.
2. `step.do("pagespeed")` → only if `siteStatus === "ok"`; on any error return `null` (partial). `RateLimitedError` is re-thrown so Workflows retries the step.
3. `step.do("score")` → `score(...)`, `insertAudit` with `partial = siteStatus === "ok" && pagespeed === null`.
4. `step.do("draft")` → skip if `lowPriority && !forceDraft`; else `generateDraft` → `insertDraft`, `recordUsage("claude", 1, PRICES.claudePerDraft)`.
5. Always `incrementProcessed(searchId)` at the end (if searchId); on thrown error the workflow wrapper calls `setBusinessError` and still increments.

- [ ] **Step 1: Write the failing tests**

`test/pipeline-lead.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runLead, regenerateDraft, type LeadDeps, type StepLike } from "../src/worker/pipeline/lead";
import { createSearch, getSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { latestAudit } from "../src/worker/db/audits";
import { latestDraft } from "../src/worker/db/drafts";
import { listContacts } from "../src/worker/db/contacts";
import type { Listing } from "../src/worker/types";

const step: StepLike = { do: (_n, fn) => fn(), sleep: async () => {} };
const page = (b: string, h = "") => new Response(`<html><head>${h}</head><body>${b}</body></html>`, { headers: { "content-type": "text/html" } });
const psiSlow = { lighthouseResult: { categories: { performance: { score: 0.3 } }, audits: {
  "largest-contentful-paint": { numericValue: 7000 }, "cumulative-layout-shift": { numericValue: 0 }, viewport: { score: 1 } } } };

function deps(over: Partial<LeadDeps> = {}): LeadDeps & { claudeCalls: number } {
  const d: any = {
    db: env.DB, raw: env.RAW, pagespeedKey: "K", now: () => new Date("2026-10-02T00:00:00Z"), claudeCalls: 0,
    fetch: async (u: string) => {
      if (u.startsWith("https://www.googleapis.com/pagespeedonline")) return Response.json(psiSlow);
      if (u === "https://ace.com/") return page(`<a href="mailto:info@ace.com">m</a><p>© 2019</p>`, `<title>Ace</title><meta name="viewport" content="x">`);
      return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
    },
    ...over,
  };
  d.claude = over.claude ?? (async () => { d.claudeCalls++; return { subject: "Hi", body: "Body", to_contact_id: null, recipient_reason: "r" }; });
  return d;
}
const listing = (o: Partial<Listing>): Listing => ({ placeId: null, name: "Ace", category: "Plumber", address: "Boise", phone: null,
  websiteUrl: "https://ace.com", mapsUrl: null, rating: null, reviewCount: null, ...o });

describe("runLead", () => {
  it("crawls, scores, drafts, stores contacts and raw, increments progress", async () => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L1" }), s.id);
    const d = deps();
    const r = await runLead(d, step, { businessId: b.id, searchId: s.id });
    const a = (await latestAudit(env.DB, b.id))!;
    expect(a.site_status).toBe("ok");
    expect(a.findings.map((f) => f.code)).toContain("slow_mobile");
    expect(a.offer).toBe("performance");
    expect(a.raw_r2_key).toMatch(/^audits\//);
    expect(await env.RAW.get(a.raw_r2_key!)).not.toBeNull();
    expect((await listContacts(env.DB, b.id))[0].value).toBe("info@ace.com");
    expect(r.draftId).not.toBeNull();
    expect((await latestDraft(env.DB, b.id))!.to_contact_id).toBe((await listContacts(env.DB, b.id))[0].id);
    expect((await getSearch(env.DB, s.id))!.processed_count).toBe(1);
  });

  it("pagespeed failure → partial audit, still drafts", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L2" }), s.id);
    const base = deps();
    const d = deps({ fetch: async (u, i) => u.includes("pagespeedonline") ? new Response("x", { status: 500 }) : base.fetch(u, i) });
    await runLead(d, step, { businessId: b.id, searchId: s.id });
    expect((await latestAudit(env.DB, b.id))!.partial).toBe(true);
  });

  it("low-priority lead is not drafted unless forced", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L3", websiteUrl: "https://good.com" }), s.id);
    const good = async (u: string) => u.includes("pagespeedonline")
      ? Response.json({ lighthouseResult: { categories: { performance: { score: 0.95 } }, audits: { "largest-contentful-paint": { numericValue: 1000 }, "cumulative-layout-shift": { numericValue: 0 } } } })
      : u === "https://good.com/" ? page(`<form><input name="email"><textarea></textarea></form><p>© 2026</p>`, `<title>G</title><meta name="description" content="d"><meta name="viewport" content="x">`)
      : new Response("", { status: 404, headers: { "content-type": "text/html" } });
    const d = deps({ fetch: good });
    const r = await runLead(d, step, { businessId: b.id, searchId: s.id });
    expect(r.draftId).toBeNull();
    expect(d.claudeCalls).toBe(0);
    const forced = await runLead(d, step, { businessId: b.id, searchId: null, forceDraft: true });
    expect(forced.draftId).not.toBeNull();
  });

  it("no website → score 100, new_site, no pagespeed call", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L4", websiteUrl: null }), s.id);
    let psiCalled = false;
    const d = deps({ fetch: async (u) => { if (u.includes("pagespeed")) psiCalled = true; return new Response(""); } });
    await runLead(d, step, { businessId: b.id, searchId: s.id });
    const a = (await latestAudit(env.DB, b.id))!;
    expect(a.score).toBe(100);
    expect(a.offer).toBe("new_site");
    expect(psiCalled).toBe(false);
  });

  it("regenerateDraft passes steering note and keeps history", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L5" }), s.id);
    let lastUser = "";
    const d = deps({ claude: async (p) => { lastUser = p.user; return { subject: "S2", body: "B2", to_contact_id: null, recipient_reason: "r" }; } });
    await runLead(d, step, { businessId: b.id, searchId: s.id });
    const dr = await regenerateDraft(d, b.id, "shorter");
    expect(lastUser).toContain("shorter");
    expect(dr.steering_note).toBe("shorter");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/pipeline-lead.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement pipeline**

`src/worker/pipeline/lead.ts`:
```ts
import type { Fetcher } from "../crawler/crawl";
import { crawlSite } from "../crawler/crawl";
import { runPageSpeed, RateLimitedError } from "../pagespeed";
import { score } from "../scoring/scorer";
import { generateDraft, type ClaudeCaller } from "../drafter/draft";
import { getBusiness } from "../db/businesses";
import { replaceContacts, listContacts } from "../db/contacts";
import { insertAudit, latestAudit } from "../db/audits";
import { insertDraft } from "../db/drafts";
import { getSettings } from "../db/settings";
import { incrementProcessed } from "../db/searches";
import { recordUsage } from "../db/usage";
import { PRICES } from "../cost";
import type { Draft } from "../types";

export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}
export interface LeadDeps {
  db: D1Database; raw: R2Bucket; fetch: Fetcher; pagespeedKey: string; claude: ClaudeCaller; now: () => Date;
}

async function draftFor(deps: LeadDeps, businessId: string, steeringNote: string | null): Promise<Draft> {
  const [business, audit, contacts, settings] = await Promise.all([
    getBusiness(deps.db, businessId), latestAudit(deps.db, businessId), listContacts(deps.db, businessId), getSettings(deps.db),
  ]);
  if (!business || !audit) throw new Error("Cannot draft: business or audit missing");
  const d = await generateDraft({ settings, business, findings: audit.findings, offer: audit.offer, contacts, steeringNote }, deps.claude);
  await recordUsage(deps.db, "claude", 1, PRICES.claudePerDraft);
  return insertDraft(deps.db, { business_id: businessId, audit_id: audit.id, offer: audit.offer, steering_note: steeringNote, ...d });
}

export function regenerateDraft(deps: LeadDeps, businessId: string, steeringNote: string | null) {
  return draftFor(deps, businessId, steeringNote);
}

export async function runLead(
  deps: LeadDeps, step: StepLike,
  p: { businessId: string; searchId: string | null; forceDraft?: boolean; steeringNote?: string | null },
) {
  const business = await getBusiness(deps.db, p.businessId);
  if (!business) throw new Error(`Business ${p.businessId} not found`);

  const crawl = await step.do("crawl", async () => {
    const settings = await getSettings(deps.db);
    const ua = `SiteSearchAudit/1.0 (+contact: ${settings.contact_email || settings.business_name || "owner"})`;
    const r = await crawlSite(business.website_url, { fetch: deps.fetch, userAgent: ua, now: deps.now() });
    let rawKey: string | null = null;
    if (r.pages.length) {
      rawKey = `audits/${p.businessId}/${deps.now().toISOString()}.json`;
      await deps.raw.put(rawKey, JSON.stringify({ pages: r.pages }));
    }
    await replaceContacts(deps.db, p.businessId, r.contacts);
    return { siteStatus: r.siteStatus, finalUrl: r.finalUrl, facts: r.facts, rawKey };
  });

  const ps = await step.do("pagespeed", async () => {
    if (crawl.siteStatus !== "ok" || !crawl.finalUrl) return null;
    try {
      const r = await runPageSpeed(crawl.finalUrl, { apiKey: deps.pagespeedKey, fetch: deps.fetch });
      await recordUsage(deps.db, "pagespeed", 1, PRICES.pagespeedPerCall);
      if (crawl.rawKey) {
        const prev = await deps.raw.get(crawl.rawKey).then((o) => o?.json<Record<string, unknown>>());
        await deps.raw.put(crawl.rawKey, JSON.stringify({ ...prev, pagespeed: r.raw }));
      }
      return r.facts;
    } catch (e) {
      if (e instanceof RateLimitedError) throw e;
      return null;
    }
  });

  const audit = await step.do("score", async () => {
    const s = score({ siteStatus: crawl.siteStatus, crawl: crawl.facts, pagespeed: ps, now: deps.now() });
    const f = crawl.facts;
    const a = await insertAudit(deps.db, {
      business_id: p.businessId, site_status: crawl.siteStatus, partial: crawl.siteStatus === "ok" && ps === null,
      pagespeed_mobile: ps?.performanceScore ?? null, lcp_ms: ps?.lcpMs ?? null, cls: ps?.cls ?? null,
      mobile_friendly: ps ? ps.mobileFriendly : f ? f.hasViewport : null,
      https: f?.https ?? null, has_title: f?.hasTitle ?? null, has_meta_description: f?.hasMetaDescription ?? null,
      has_contact_form: f?.hasContactForm ?? null, copyright_year: f?.copyrightYear ?? null,
      latest_content_date: f?.latestContentDate ?? null, broken_link_count: f?.brokenLinkCount ?? null,
      score: s.score, offer: s.offer, findings: s.findings, raw_r2_key: crawl.rawKey,
    });
    return { id: a.id, lowPriority: s.lowPriority };
  });

  const draftId = await step.do("draft", async () => {
    if (audit.lowPriority && !p.forceDraft) return null;
    return (await draftFor(deps, p.businessId, p.steeringNote ?? null)).id;
  });

  if (p.searchId) await step.do("progress", () => incrementProcessed(deps.db, p.searchId!).then(() => true));
  return { auditId: audit.id, draftId };
}
```

- [ ] **Step 4: Implement workflow adapters**

`src/worker/workflows.ts`:
```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { runLead, type LeadDeps, type StepLike } from "./pipeline/lead";
import { anthropicCaller } from "./drafter/draft";
import { setBusinessError } from "./db/businesses";
import { incrementProcessed } from "./db/searches";

const RETRY = { retries: { limit: 3, delay: "10 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };

export function depsFromEnv(env: Env): LeadDeps {
  return {
    db: env.DB, raw: env.RAW, fetch: (u, i) => fetch(u, i), pagespeedKey: env.PAGESPEED_API_KEY,
    claude: anthropicCaller(env.ANTHROPIC_API_KEY), now: () => new Date(),
  };
}

export function adaptStep(step: WorkflowStep): StepLike {
  return {
    do: (name, fn) => step.do(name, RETRY, fn as any) as any,
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

export type LeadParams = { businessId: string; searchId: string | null; forceDraft?: boolean };

export class LeadWorkflow extends WorkflowEntrypoint<Env, LeadParams> {
  async run(event: WorkflowEvent<LeadParams>, step: WorkflowStep) {
    const deps = depsFromEnv(this.env);
    const p = event.payload;
    try {
      await step.do("clear-error", () => setBusinessError(deps.db, p.businessId, null).then(() => true));
      return await runLead(deps, adaptStep(step), p);
    } catch (e) {
      await step.do("record-error", async () => {
        await setBusinessError(deps.db, p.businessId, (e as Error).message.slice(0, 500));
        if (p.searchId) await incrementProcessed(deps.db, p.searchId);
        return true;
      });
      return { auditId: null, draftId: null };
    }
  }
}

export type SearchParams = { searchId: string };

export class SearchWorkflow extends WorkflowEntrypoint<Env, SearchParams> {
  async run(_event: WorkflowEvent<SearchParams>, _step: WorkflowStep) {
    // Implemented in Task 13
  }
}
```

Note: Workflow step results must be serializable. `runLead` step callbacks return plain objects/strings/null only; `Response` objects never leave a step.

Modify `src/worker/index.ts` — add at the end:
```ts
export { LeadWorkflow, SearchWorkflow } from "./workflows";
```

Make sure the `workflows` block is in `wrangler.jsonc` (restore it if removed in Task 1).

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: lead pipeline and LeadWorkflow"
```

---

### Task 13: Search pipeline + SearchWorkflow

**Files:**
- Create: `src/worker/pipeline/search.ts`
- Modify: `src/worker/workflows.ts` (SearchWorkflow body)
- Test: `test/pipeline-search.test.ts`

**Interfaces:**
- Consumes: `ListingSource` (Task 8), `upsertBusiness`, `setFoundCount`, `setSearchStatus`, `getSearch` (Task 2), `recordUsage`, `PRICES` (Task 10), `StepLike` (Task 12).
- Produces:
  - `interface SearchDeps { db: D1Database; source: ListingSource; startLead: (p: { businessId: string; searchId: string }) => Promise<void> }`
  - `runSearch(deps: SearchDeps, step: StepLike, searchId: string) → Promise<{ businessIds: string[] }>`
  - `LEAD_BATCH_SIZE = 5`, `LEAD_BATCH_DELAY_MS = 20_000`

Behaviour: listing fetch in one step; on error → `setSearchStatus(failed, msg)` and no businesses written. Upsert all in one step (returns ids). Skipped businesses are linked to the search but no lead workflow is started for them, and processed_count is pre-incremented for them. Start leads in batches with `step.sleep` between batches. Mark `done` after starting all (the UI shows done when `processed_count >= found_count`; `status=done` means "all leads dispatched"). If zero listings → `done` with `found_count = 0`.

- [ ] **Step 1: Write the failing tests**

`test/pipeline-search.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runSearch } from "../src/worker/pipeline/search";
import { FakeListingSource } from "../src/worker/listings/fake";
import { createSearch, getSearch } from "../src/worker/db/searches";
import { listBusinessesForSearch, upsertBusiness, updateLead } from "../src/worker/db/businesses";
import type { StepLike } from "../src/worker/pipeline/lead";
import type { Listing } from "../src/worker/types";

const L = (id: string): Listing => ({ placeId: id, name: `B${id}`, category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null });

function recorder() {
  const sleeps: string[] = [];
  const step: StepLike = { do: (_n, fn) => fn(), sleep: async (n) => { sleeps.push(n); } };
  return { step, sleeps };
}

describe("runSearch", () => {
  it("upserts listings, starts leads in batches, marks done", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const started: string[] = [];
    const { step, sleeps } = recorder();
    const listings = Array.from({ length: 12 }, (_, i) => L(`S1-${i}`));
    await runSearch({ db: env.DB, source: new FakeListingSource(listings), startLead: async (p) => { started.push(p.businessId); } }, step, s.id);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.found_count).toBe(12);
    expect(after.status).toBe("done");
    expect(started).toHaveLength(12);
    expect(sleeps).toHaveLength(2); // 5 + 5 + 2
    expect(await listBusinessesForSearch(env.DB, s.id, { hideSkipped: false })).toHaveLength(12);
  });

  it("listing error → failed with message, nothing written", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const { step } = recorder();
    await runSearch({ db: env.DB, source: new FakeListingSource(new Error("Bright Data HTTP 401: bad zone")), startLead: async () => {} }, step, s.id);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/401/);
    expect(await listBusinessesForSearch(env.DB, s.id, { hideSkipped: false })).toHaveLength(0);
  });

  it("previously skipped businesses are not re-processed but count as processed", async () => {
    const s0 = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const b = await upsertBusiness(env.DB, L("SKIP-1"), s0.id);
    await updateLead(env.DB, b.id, { leadStatus: "skip" });
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const started: string[] = [];
    const { step } = recorder();
    await runSearch({ db: env.DB, source: new FakeListingSource([L("SKIP-1"), L("NEW-1")]), startLead: async (p) => { started.push(p.businessId); } }, step, s.id);
    expect(started).toHaveLength(1);
    expect((await getSearch(env.DB, s.id))!.processed_count).toBe(1);
  });

  it("zero listings → done with found 0", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const { step } = recorder();
    await runSearch({ db: env.DB, source: new FakeListingSource([]), startLead: async () => {} }, step, s.id);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.status).toBe("done");
    expect(after.found_count).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/pipeline-search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/worker/pipeline/search.ts`:
```ts
import type { ListingSource } from "../listings/source";
import type { StepLike } from "./lead";
import type { Listing } from "../types";
import { getSearch, setFoundCount, setSearchStatus, incrementProcessed } from "../db/searches";
import { upsertBusiness } from "../db/businesses";
import { recordUsage } from "../db/usage";
import { PRICES } from "../cost";

export const LEAD_BATCH_SIZE = 5;
export const LEAD_BATCH_DELAY_MS = 20_000;

export interface SearchDeps {
  db: D1Database; source: ListingSource; startLead: (p: { businessId: string; searchId: string }) => Promise<void>;
}

export async function runSearch(deps: SearchDeps, step: StepLike, searchId: string) {
  const search = await getSearch(deps.db, searchId);
  if (!search) throw new Error(`Search ${searchId} not found`);

  const fetched = await step.do("fetch-listings", async () => {
    try {
      const r = await deps.source.search({
        location: search.location, businessType: search.business_type, radiusKm: search.radius_km, maxResults: search.max_results,
      });
      await recordUsage(deps.db, "brightdata", r.requests, r.requests * PRICES.brightdataPerRequest);
      return { ok: true as const, listings: r.listings };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message, listings: [] as Listing[] };
    }
  });
  if (!fetched.ok) {
    await step.do("mark-failed", () => setSearchStatus(deps.db, searchId, "failed", fetched.error).then(() => true));
    return { businessIds: [] };
  }

  const toProcess = await step.do("upsert", async () => {
    const ids: string[] = [];
    let skipped = 0;
    for (const l of fetched.listings) {
      const b = await upsertBusiness(deps.db, l, searchId);
      if (b.lead_status === "skip") skipped++; else ids.push(b.id);
    }
    await setFoundCount(deps.db, searchId, fetched.listings.length);
    for (let i = 0; i < skipped; i++) await incrementProcessed(deps.db, searchId);
    return ids;
  });

  for (let i = 0; i < toProcess.length; i += LEAD_BATCH_SIZE) {
    if (i > 0) await step.sleep(`batch-gap-${i}`, LEAD_BATCH_DELAY_MS);
    const batch = toProcess.slice(i, i + LEAD_BATCH_SIZE);
    await step.do(`start-batch-${i}`, async () => {
      for (const businessId of batch) await deps.startLead({ businessId, searchId });
      return true;
    });
  }

  await step.do("mark-done", () => setSearchStatus(deps.db, searchId, "done").then(() => true));
  return { businessIds: toProcess };
}
```

Replace the `SearchWorkflow` class in `src/worker/workflows.ts`:
```ts
import { runSearch } from "./pipeline/search";
import { BrightDataListingSource } from "./listings/brightdata";

export class SearchWorkflow extends WorkflowEntrypoint<Env, SearchParams> {
  async run(event: WorkflowEvent<SearchParams>, step: WorkflowStep) {
    const env = this.env;
    const source = new BrightDataListingSource({ apiKey: env.BRIGHTDATA_API_KEY, zone: env.BRIGHTDATA_SERP_ZONE, fetch: (u, i) => fetch(u, i) });
    await runSearch({
      db: env.DB, source,
      startLead: async ({ businessId, searchId }) => {
        await env.LEAD_WORKFLOW.create({ id: `lead-${searchId}-${businessId}`, params: { businessId, searchId } });
      },
    }, adaptStep(step), event.payload.searchId);
  }
}
```

(Move the two new imports to the top of the file with the others.)

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: search pipeline and SearchWorkflow with batched lead dispatch"
```

---

### Task 14: API routes

**Files:**
- Create: `src/worker/routes/searches.ts`, `src/worker/routes/leads.ts`, `src/worker/routes/settings.ts`
- Modify: `src/worker/index.ts`
- Test: `test/routes.test.ts`

**Interfaces:**
- Consumes: db modules (Task 2), `pickRecipient` (Task 4), `estimateSearchCost`, `checkSpend` (Task 10), `regenerateDraft`, `depsFromEnv` (Tasks 12), workflows bindings.
- Produces (all JSON, all behind auth):
  - `GET /api/searches` → `Search[]`
  - `GET /api/searches/estimate?maxResults=N` → `{ estUsd, spent, limit, ok }`
  - `POST /api/searches {location, businessType, radiusKm?, maxResults?}` → 201 `Search` | 400 validation | 402 `{error:"spend limit"}`; creates `SEARCH_WORKFLOW` instance `search-<id>`
  - `GET /api/searches/:id` → `{ search, leads: LeadRow[] }` where `LeadRow = { business: Business; score: number|null; topFinding: string|null; offer: Offer|null; bestContact: string|null; hasEmail: boolean; partial: boolean }`; query `?hideSkipped=1`
  - `GET /api/leads?status=` → `LeadRow[]`
  - `GET /api/leads/:id` → `{ business, audit, contacts, draft, toContact }`; side effect: `new → reviewed`
  - `PATCH /api/leads/:id {leadStatus?, notes?}` → `Business`
  - `PATCH /api/leads/:id/draft {subject, body}` → `{ok:true}`
  - `POST /api/leads/:id/regenerate {steeringNote?}` → `Draft` (synchronous; Claude call inline)
  - `POST /api/leads/:id/reaudit` → 202; creates `LEAD_WORKFLOW` instance with `searchId: null, forceDraft: true`
  - `GET /api/settings` → `{ settings, usage }`; `PUT /api/settings` → `Settings`

- [ ] **Step 1: Write the failing tests**

`test/routes.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness, getBusiness } from "../src/worker/db/businesses";
import { insertAudit } from "../src/worker/db/audits";
import { replaceContacts } from "../src/worker/db/contacts";
import { insertDraft } from "../src/worker/db/drafts";
import { saveSettings } from "../src/worker/db/settings";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

async function seedLead() {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Ace", category: null, address: null, phone: null, websiteUrl: "https://ace.com", mapsUrl: null, rating: null, reviewCount: null }, s.id);
  const a = await insertAudit(env.DB, { business_id: b.id, site_status: "ok", partial: true, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
    https: false, has_title: true, has_meta_description: true, has_contact_form: false, copyright_year: null, latest_content_date: null, broken_link_count: 0,
    score: 15, offer: "seo_basics", findings: [{ code: "no_https", group: "basics", severity: "high", points: 15, evidence: "Not secure" }], raw_r2_key: null });
  const [c] = await replaceContacts(env.DB, b.id, [{ type: "email", value: "info@ace.com", source_url: null, person_name: null, role: null, confidence: 0.7 }]);
  await insertDraft(env.DB, { business_id: b.id, audit_id: a.id, to_contact_id: c.id, recipient_reason: "r", subject: "S", body: "B", offer: "seo_basics", steering_note: null });
  return { s, b };
}

describe("routes", () => {
  it("validates new search input", async () => {
    expect((await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "", businessType: "x" }) })).status).toBe(400);
    expect((await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "Boise", businessType: "x", maxResults: 500 }) })).status).toBe(400);
  });

  it("blocks search over spend limit with 402", async () => {
    await saveSettings(env.DB, { monthly_spend_limit_usd: 0 });
    const r = await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "Boise", businessType: "plumber", maxResults: 10 }) });
    expect(r.status).toBe(402);
    await saveSettings(env.DB, { monthly_spend_limit_usd: 25 });
  });

  it("search detail returns lead rows with score, top finding, best contact, partial", async () => {
    const { s } = await seedLead();
    const r = await (await api(`/api/searches/${s.id}`)).json<any>();
    expect(r.leads[0].score).toBe(15);
    expect(r.leads[0].topFinding).toBe("Not secure");
    expect(r.leads[0].bestContact).toBe("info@ace.com");
    expect(r.leads[0].hasEmail).toBe(true);
    expect(r.leads[0].partial).toBe(true);
  });

  it("opening a lead marks it reviewed and returns draft + recipient", async () => {
    const { b } = await seedLead();
    const r = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(r.draft.subject).toBe("S");
    expect(r.toContact.value).toBe("info@ace.com");
    expect((await getBusiness(env.DB, b.id))!.lead_status).toBe("reviewed");
  });

  it("patch status to contacted sets contacted_at; draft edit marks edited", async () => {
    const { b } = await seedLead();
    const r = await (await api(`/api/leads/${b.id}`, { method: "PATCH", body: JSON.stringify({ leadStatus: "contacted" }) })).json<any>();
    expect(r.contacted_at).not.toBeNull();
    expect((await api(`/api/leads/${b.id}/draft`, { method: "PATCH", body: JSON.stringify({ subject: "S2", body: "B2" }) })).status).toBe(200);
    const d = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(d.draft.edited).toBe(true);
  });

  it("rejects invalid lead status", async () => {
    const { b } = await seedLead();
    expect((await api(`/api/leads/${b.id}`, { method: "PATCH", body: JSON.stringify({ leadStatus: "bogus" }) })).status).toBe(400);
  });

  it("settings round trip with usage", async () => {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ your_name: "Logan" }) });
    const r = await (await api("/api/settings")).json<any>();
    expect(r.settings.your_name).toBe("Logan");
    expect(Array.isArray(r.usage)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/routes.test.ts`
Expected: FAIL — 404s.

- [ ] **Step 3: Implement**

`src/worker/routes/searches.ts`:
```ts
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createSearch, getSearch, listSearches } from "../db/searches";
import { listBusinessesForSearch } from "../db/businesses";
import { checkSpend, estimateSearchCost } from "../cost";
import { leadRows } from "./leads";

const NewSearch = z.object({
  location: z.string().trim().min(2),
  businessType: z.string().trim().min(2),
  radiusKm: z.number().min(1).max(100).default(15),
  maxResults: z.number().int().min(1).max(200).default(50),
});

export const searchRoutes = new Hono<{ Bindings: Env }>();

searchRoutes.get("/", async (c) => c.json(await listSearches(c.env.DB)));

searchRoutes.get("/estimate", async (c) => {
  const n = Math.min(200, Math.max(1, Number(c.req.query("maxResults") ?? 50)));
  const estUsd = estimateSearchCost(n);
  return c.json({ estUsd, ...(await checkSpend(c.env.DB, estUsd)) });
});

searchRoutes.post("/", async (c) => {
  const parsed = NewSearch.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  const spend = await checkSpend(c.env.DB, estimateSearchCost(parsed.data.maxResults));
  if (!spend.ok) return c.json({ error: "spend limit", ...spend }, 402);
  const s = await createSearch(c.env.DB, parsed.data);
  await c.env.SEARCH_WORKFLOW.create({ id: `search-${s.id}`, params: { searchId: s.id } });
  return c.json(s, 201);
});

searchRoutes.get("/:id", async (c) => {
  const search = await getSearch(c.env.DB, c.req.param("id"));
  if (!search) return c.json({ error: "not found" }, 404);
  const businesses = await listBusinessesForSearch(c.env.DB, search.id, { hideSkipped: c.req.query("hideSkipped") === "1" });
  return c.json({ search, leads: await leadRows(c.env.DB, businesses) });
});
```

`src/worker/routes/leads.ts`:
```ts
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { Business, LeadStatus } from "../types";
import { getBusiness, listAllBusinesses, updateLead, domainOf } from "../db/businesses";
import { latestAudit } from "../db/audits";
import { listContacts } from "../db/contacts";
import { latestDraft, updateDraftBody } from "../db/drafts";
import { pickRecipient } from "../recipient";
import { regenerateDraft } from "../pipeline/lead";
import { depsFromEnv } from "../workflows";

const STATUSES = ["new", "reviewed", "contacted", "replied", "won", "lost", "skip"] as const;

export async function leadRows(db: D1Database, businesses: Business[]) {
  return Promise.all(businesses.map(async (b) => {
    const [audit, contacts] = await Promise.all([latestAudit(db, b.id), listContacts(db, b.id)]);
    const best = pickRecipient(contacts, domainOf(b.website_url));
    return {
      business: b, score: audit?.score ?? null, topFinding: audit?.findings[0]?.evidence ?? null,
      offer: audit?.offer ?? null, bestContact: best.contact?.value ?? null, hasEmail: !!best.emailContact,
      partial: audit?.partial ?? false,
    };
  }));
}

export const leadRoutes = new Hono<{ Bindings: Env }>();

leadRoutes.get("/", async (c) => {
  const status = c.req.query("status") as LeadStatus | undefined;
  if (status && !STATUSES.includes(status)) return c.json({ error: "bad status" }, 400);
  return c.json(await leadRows(c.env.DB, await listAllBusinesses(c.env.DB, { status })));
});

leadRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  let business = await getBusiness(c.env.DB, id);
  if (!business) return c.json({ error: "not found" }, 404);
  if (business.lead_status === "new") business = await updateLead(c.env.DB, id, { leadStatus: "reviewed" });
  const [audit, contacts, draft] = await Promise.all([latestAudit(c.env.DB, id), listContacts(c.env.DB, id), latestDraft(c.env.DB, id)]);
  const toContact = draft?.to_contact_id ? contacts.find((x) => x.id === draft.to_contact_id) ?? null : null;
  return c.json({ business, audit, contacts, draft, toContact });
});

const PatchLead = z.object({ leadStatus: z.enum(STATUSES).optional(), notes: z.string().max(5000).optional() });
leadRoutes.patch("/:id", async (c) => {
  const p = PatchLead.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  if (!(await getBusiness(c.env.DB, c.req.param("id")))) return c.json({ error: "not found" }, 404);
  return c.json(await updateLead(c.env.DB, c.req.param("id"), p.data));
});

const PatchDraft = z.object({ subject: z.string().min(1).max(300), body: z.string().min(1).max(5000) });
leadRoutes.patch("/:id/draft", async (c) => {
  const p = PatchDraft.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  const d = await latestDraft(c.env.DB, c.req.param("id"));
  if (!d) return c.json({ error: "no draft" }, 404);
  await updateDraftBody(c.env.DB, d.id, p.data);
  return c.json({ ok: true });
});

leadRoutes.post("/:id/regenerate", async (c) => {
  const { steeringNote } = await c.req.json<{ steeringNote?: string }>().catch(() => ({ steeringNote: undefined }));
  try {
    return c.json(await regenerateDraft(depsFromEnv(c.env), c.req.param("id"), steeringNote?.trim() || null));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

leadRoutes.post("/:id/reaudit", async (c) => {
  const id = c.req.param("id");
  if (!(await getBusiness(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  await c.env.LEAD_WORKFLOW.create({ id: `reaudit-${id}-${Date.now()}`, params: { businessId: id, searchId: null, forceDraft: true } });
  return c.json({ ok: true }, 202);
});
```

`src/worker/routes/settings.ts`:
```ts
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getSettings, saveSettings } from "../db/settings";
import { monthUsage } from "../db/usage";

const S = z.object({
  your_name: z.string().max(200), business_name: z.string().max(200), contact_email: z.string().max(200),
  services_blurb: z.string().max(2000), signature: z.string().max(1000), physical_address: z.string().max(500),
  opt_out_line: z.string().max(500), tone_notes: z.string().max(5000), monthly_spend_limit_usd: z.number().min(0).max(10000),
}).partial();

export const settingsRoutes = new Hono<{ Bindings: Env }>();

settingsRoutes.get("/", async (c) => c.json({
  settings: await getSettings(c.env.DB), usage: await monthUsage(c.env.DB, new Date().toISOString().slice(0, 7)),
}));

settingsRoutes.put("/", async (c) => {
  const p = S.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  return c.json(await saveSettings(c.env.DB, p.data));
});
```

Update `src/worker/index.ts` — mount routes after `authRoutes`:
```ts
import { searchRoutes } from "./routes/searches";
import { leadRoutes } from "./routes/leads";
import { settingsRoutes } from "./routes/settings";
// ...
app.route("/api/searches", searchRoutes);
app.route("/api/leads", leadRoutes);
app.route("/api/settings", settingsRoutes);
```

Note: `routes/leads.ts` imports `depsFromEnv` from `workflows.ts`, which imports `cloudflare:workers` — fine inside the Worker runtime and pool-workers tests.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: JSON API for searches, leads, drafts, settings"
```

---

### Task 15: Frontend shell — API client, routing, Login, Settings

**Files:**
- Create: `src/client/api.ts`, `src/client/App.tsx`, `src/client/styles.css`, `src/client/pages/Login.tsx`, `src/client/pages/Settings.tsx`
- Modify: `src/client/main.tsx`

**Interfaces:**
- Consumes: API from Tasks 11 and 14.
- Produces: `api` object used by later pages: `api.get<T>(path)`, `api.post<T>(path, body?)`, `api.patch<T>(path, body)`, `api.put<T>(path, body)`; throws `ApiError {status, message}`; on 401 redirects to `/login`. Routes: `/login`, `/` (NewSearch), `/searches/:id`, `/leads/:id`, `/leads`, `/settings`.

- [ ] **Step 1: Write the client**

`src/client/api.ts`:
```ts
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method, credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/login")) { location.href = "/login"; throw new ApiError(401, "unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  get: <T,>(p: string) => req<T>("GET", p),
  post: <T,>(p: string, b?: unknown) => req<T>("POST", p, b ?? {}),
  patch: <T,>(p: string, b: unknown) => req<T>("PATCH", p, b),
  put: <T,>(p: string, b: unknown) => req<T>("PUT", p, b),
};
```

`src/client/main.tsx`:
```tsx
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<BrowserRouter><App /></BrowserRouter>);
```

`src/client/App.tsx`:
```tsx
import { NavLink, Route, Routes } from "react-router-dom";
import Login from "./pages/Login";
import NewSearch from "./pages/NewSearch";
import SearchDetail from "./pages/SearchDetail";
import LeadDetail from "./pages/LeadDetail";
import AllLeads from "./pages/AllLeads";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="*" element={
        <div className="shell">
          <nav className="nav">
            <strong>Site Search</strong>
            <NavLink to="/" end>New search</NavLink>
            <NavLink to="/leads">All leads</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <main>
            <Routes>
              <Route path="/" element={<NewSearch />} />
              <Route path="/searches/:id" element={<SearchDetail />} />
              <Route path="/leads" element={<AllLeads />} />
              <Route path="/leads/:id" element={<LeadDetail />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      } />
    </Routes>
  );
}
```

`src/client/styles.css`:
```css
:root { --bg:#fafaf9; --fg:#1c1917; --muted:#78716c; --line:#e7e5e4; --accent:#2563eb; --bad:#dc2626; --warn:#d97706; --ok:#16a34a; --card:#fff; }
@media (prefers-color-scheme: dark) { :root { --bg:#0c0a09; --fg:#f5f5f4; --muted:#a8a29e; --line:#292524; --card:#1c1917; } }
* { box-sizing: border-box; }
body { margin:0; font: 15px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
.shell { max-width: 1200px; margin: 0 auto; padding: 16px; }
.nav { display:flex; gap:16px; align-items:center; padding-bottom:12px; border-bottom:1px solid var(--line); margin-bottom:16px; flex-wrap:wrap; }
.nav a { color:var(--muted); text-decoration:none; } .nav a.active { color:var(--fg); font-weight:600; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; }
.grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:16px; } @media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
label { display:block; font-weight:600; margin:12px 0 4px; }
input, textarea, select { width:100%; padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); font:inherit; }
textarea { min-height: 120px; }
button { padding:8px 14px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); cursor:pointer; font:inherit; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button:disabled { opacity:.5; cursor:default; }
.row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { cursor:pointer; user-select:none; color:var(--muted); font-weight:600; }
.table-wrap { overflow-x:auto; }
.score { font-weight:700; } .score.high { color:var(--bad); } .score.mid { color:var(--warn); } .score.low { color:var(--muted); }
.muted { color:var(--muted); } .error { color:var(--bad); }
.badge { display:inline-block; padding:1px 8px; border-radius:99px; border:1px solid var(--line); font-size:12px; }
progress { width:100%; }
```

`src/client/pages/Login.tsx`:
```tsx
import { useState } from "react";
import { api, ApiError } from "../api";

export default function Login() {
  const [pw, setPw] = useState(""); const [err, setErr] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try { await api.post("/login", { password: pw }); location.href = "/"; }
    catch (x) { setErr(x instanceof ApiError && x.status === 401 ? "Wrong password" : "Login failed"); }
  }
  return (
    <div className="shell" style={{ maxWidth: 360, marginTop: 80 }}>
      <form className="card" onSubmit={submit}>
        <h2>Site Search</h2>
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {err && <p className="error">{err}</p>}
        <p><button className="primary" type="submit">Sign in</button></p>
      </form>
    </div>
  );
}
```

`src/client/pages/Settings.tsx`:
```tsx
import { useEffect, useState } from "react";
import { api } from "../api";

type S = Record<string, string | number>;
const FIELDS: [string, string, "input" | "textarea"][] = [
  ["your_name", "Your name", "input"], ["business_name", "Business name", "input"], ["contact_email", "Contact email (used in crawler user-agent)", "input"],
  ["services_blurb", "What you offer", "textarea"], ["signature", "Signature", "textarea"],
  ["physical_address", "Physical mailing address (required by CAN-SPAM)", "input"], ["opt_out_line", "Opt-out line", "input"],
  ["tone_notes", "Voice / tone notes for drafts", "textarea"],
];

export default function Settings() {
  const [s, setS] = useState<S | null>(null);
  const [usage, setUsage] = useState<{ service: string; units: number; est_cost_usd: number }[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.get<{ settings: S; usage: typeof usage }>("/settings").then((r) => { setS(r.settings); setUsage(r.usage); }); }, []);
  if (!s) return <p>Loading…</p>;
  const set = (k: string, v: string | number) => { setS({ ...s, [k]: v }); setSaved(false); };
  async function save() { setS(await api.put<S>("/settings", { ...s, monthly_spend_limit_usd: Number(s!.monthly_spend_limit_usd) })); setSaved(true); }
  const total = usage.reduce((t, u) => t + u.est_cost_usd, 0);
  return (
    <div className="grid2">
      <div className="card">
        <h2>Your profile</h2>
        {FIELDS.map(([k, label, kind]) => (
          <div key={k}>
            <label htmlFor={k}>{label}</label>
            {kind === "input"
              ? <input id={k} value={String(s[k] ?? "")} onChange={(e) => set(k, e.target.value)} />
              : <textarea id={k} value={String(s[k] ?? "")} onChange={(e) => set(k, e.target.value)} />}
          </div>
        ))}
        <label htmlFor="limit">Monthly spend limit (USD)</label>
        <input id="limit" type="number" min={0} value={Number(s.monthly_spend_limit_usd)} onChange={(e) => set("monthly_spend_limit_usd", e.target.value)} />
        <p className="row"><button className="primary" onClick={save}>Save</button>{saved && <span className="muted">Saved</span>}</p>
      </div>
      <div className="card">
        <h2>This month</h2>
        <table><tbody>
          {usage.map((u) => <tr key={u.service}><td>{u.service}</td><td>{u.units} calls</td><td>${u.est_cost_usd.toFixed(2)}</td></tr>)}
          <tr><td><strong>Total</strong></td><td /><td><strong>${total.toFixed(2)}</strong> of ${Number(s.monthly_spend_limit_usd).toFixed(2)}</td></tr>
        </tbody></table>
      </div>
    </div>
  );
}
```

Create temporary stubs so the app compiles (replaced in Tasks 16–17): `src/client/pages/NewSearch.tsx`, `SearchDetail.tsx`, `LeadDetail.tsx`, `AllLeads.tsx`, each:
```tsx
export default function Page() { return <p>Coming soon</p>; }
```

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: no errors; `dist/client/index.html` exists.

- [ ] **Step 3: Manual check in dev**

```bash
cp .dev.vars.example .dev.vars   # fill APP_PASSWORD + SESSION_SECRET at minimum
npm run db:migrate:local
npm run dev
```

Open the dev URL. Expected: unauthenticated `/settings` redirects to `/login`; correct password lands on New search; Settings saves and reloads values.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: client shell, login, settings"
```

---

### Task 16: Frontend — New Search and Search Detail

**Files:**
- Modify: `src/client/pages/NewSearch.tsx`, `src/client/pages/SearchDetail.tsx`
- Create: `src/client/pages/LeadTable.tsx`, `src/client/types.ts`

**Interfaces:**
- Consumes: `api` (Task 15); endpoints `GET /searches/estimate`, `POST /searches`, `GET /searches`, `GET /searches/:id`.
- Produces: `LeadRow` client type and `<LeadTable rows={LeadRow[]} />` (sortable by score/name/status, filters: hide skipped, min score, has email) reused by AllLeads in Task 17.

- [ ] **Step 1: Shared client types**

`src/client/types.ts`:
```ts
export type LeadStatus = "new" | "reviewed" | "contacted" | "replied" | "won" | "lost" | "skip";
export interface Business { id: string; name: string; category: string | null; address: string | null; phone: string | null;
  website_url: string | null; maps_url: string | null; lead_status: LeadStatus; notes: string | null; contacted_at: string | null; last_error: string | null; }
export interface LeadRow { business: Business; score: number | null; topFinding: string | null; offer: string | null;
  bestContact: string | null; hasEmail: boolean; partial: boolean; }
export interface Search { id: string; location: string; business_type: string; max_results: number; status: "running" | "done" | "failed";
  error: string | null; found_count: number; processed_count: number; created_at: string; }
export const STATUSES: LeadStatus[] = ["new", "reviewed", "contacted", "replied", "won", "lost", "skip"];
```

- [ ] **Step 2: LeadTable**

`src/client/pages/LeadTable.tsx`:
```tsx
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { LeadRow } from "../types";

type Key = "score" | "name" | "status";
const scoreClass = (s: number | null) => (s === null ? "low" : s >= 60 ? "high" : s >= 20 ? "mid" : "low");

export default function LeadTable({ rows }: { rows: LeadRow[] }) {
  const [sort, setSort] = useState<Key>("score");
  const [hideSkipped, setHideSkipped] = useState(true);
  const [minScore, setMinScore] = useState(0);
  const [emailOnly, setEmailOnly] = useState(false);

  const view = useMemo(() => rows
    .filter((r) => !hideSkipped || r.business.lead_status !== "skip")
    .filter((r) => (r.score ?? 0) >= minScore)
    .filter((r) => !emailOnly || r.hasEmail)
    .sort((a, b) => sort === "score" ? (b.score ?? -1) - (a.score ?? -1)
      : sort === "name" ? a.business.name.localeCompare(b.business.name)
      : a.business.lead_status.localeCompare(b.business.lead_status)), [rows, sort, hideSkipped, minScore, emailOnly]);

  return (
    <>
      <div className="row" style={{ margin: "12px 0" }}>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}><input type="checkbox" style={{ width: "auto" }} checked={hideSkipped} onChange={(e) => setHideSkipped(e.target.checked)} /> Hide skipped</label>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}><input type="checkbox" style={{ width: "auto" }} checked={emailOnly} onChange={(e) => setEmailOnly(e.target.checked)} /> Has email</label>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}>Min score <input type="number" min={0} max={100} style={{ width: 70 }} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} /></label>
        <span className="muted">{view.length} of {rows.length}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th onClick={() => setSort("name")}>Business</th>
            <th onClick={() => setSort("score")}>Score ▾</th>
            <th>Top finding</th><th>Best contact</th><th>Offer</th>
            <th onClick={() => setSort("status")}>Status</th>
          </tr></thead>
          <tbody>
            {view.map((r) => (
              <tr key={r.business.id}>
                <td><Link to={`/leads/${r.business.id}`}>{r.business.name}</Link>
                  {r.business.last_error && <span title={r.business.last_error}> ⚠</span>}
                  <div className="muted">{r.business.website_url ?? "no website"}</div></td>
                <td><span className={`score ${scoreClass(r.score)}`}>{r.score ?? "…"}</span>{r.partial && <span className="badge" title="PageSpeed unavailable">partial</span>}</td>
                <td>{r.topFinding ?? <span className="muted">—</span>}</td>
                <td>{r.bestContact ?? <span className="muted">none</span>}</td>
                <td>{r.offer ?? "—"}</td>
                <td><span className="badge">{r.business.lead_status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
```

- [ ] **Step 3: NewSearch**

`src/client/pages/NewSearch.tsx`:
```tsx
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Search } from "../types";

const TYPES = ["plumber", "electrician", "roofer", "HVAC", "dentist", "chiropractor", "restaurant", "landscaper", "auto repair", "law firm", "salon", "church"];

export default function NewSearch() {
  const nav = useNavigate();
  const [location, setLocation] = useState(""); const [type, setType] = useState("");
  const [radiusKm, setRadius] = useState(15); const [maxResults, setMax] = useState(50);
  const [est, setEst] = useState<{ estUsd: number; spent: number; limit: number; ok: boolean } | null>(null);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<Search[]>([]);

  useEffect(() => { api.get<Search[]>("/searches").then(setRecent); }, []);
  useEffect(() => { api.get<typeof est>(`/searches/estimate?maxResults=${maxResults}`).then(setEst); }, [maxResults]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    try { const s = await api.post<Search>("/searches", { location, businessType: type, radiusKm, maxResults }); nav(`/searches/${s.id}`); }
    catch (x) { setErr(x instanceof ApiError ? (x.status === 402 ? "This search would go over your monthly spend limit." : x.message) : "Failed"); setBusy(false); }
  }

  return (
    <div className="grid2">
      <form className="card" onSubmit={submit}>
        <h2>New search</h2>
        <label htmlFor="loc">Location</label>
        <input id="loc" placeholder="Boise, ID" value={location} onChange={(e) => setLocation(e.target.value)} required />
        <label htmlFor="type">Business type</label>
        <input id="type" list="types" placeholder="plumber" value={type} onChange={(e) => setType(e.target.value)} required />
        <datalist id="types">{TYPES.map((t) => <option key={t} value={t} />)}</datalist>
        <div className="row">
          <div style={{ flex: 1 }}><label htmlFor="r">Radius (km)</label><input id="r" type="number" min={1} max={100} value={radiusKm} onChange={(e) => setRadius(Number(e.target.value))} /></div>
          <div style={{ flex: 1 }}><label htmlFor="m">Max results</label><input id="m" type="number" min={1} max={200} value={maxResults} onChange={(e) => setMax(Number(e.target.value))} /></div>
        </div>
        {est && <p className="muted">Estimated cost: up to ${est.estUsd.toFixed(2)} · spent this month ${est.spent.toFixed(2)} of ${est.limit.toFixed(2)}</p>}
        {err && <p className="error">{err}</p>}
        <button className="primary" disabled={busy || (est !== null && !est.ok)}>{busy ? "Starting…" : "Find businesses"}</button>
      </form>
      <div className="card">
        <h2>Recent searches</h2>
        <table><tbody>
          {recent.map((s) => (
            <tr key={s.id}>
              <td><Link to={`/searches/${s.id}`}>{s.business_type} in {s.location}</Link></td>
              <td className="muted">{s.processed_count}/{s.found_count}</td>
              <td><span className="badge">{s.status}</span></td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}
```

Note: the radius is passed through to the search record but Bright Data's Maps URL search is driven by the location text. Radius is stored for reference only in v1.

- [ ] **Step 4: SearchDetail**

`src/client/pages/SearchDetail.tsx`:
```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import type { LeadRow, Search } from "../types";
import LeadTable from "./LeadTable";

export default function SearchDetail() {
  const { id } = useParams();
  const [data, setData] = useState<{ search: Search; leads: LeadRow[] } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const d = await api.get<{ search: Search; leads: LeadRow[] }>(`/searches/${id}`);
      setData(d);
      const finished = d.search.status === "failed" || (d.search.status === "done" && d.search.processed_count >= d.search.found_count);
      if (!finished) timer = setTimeout(load, 4000);
    };
    load();
    return () => clearTimeout(timer);
  }, [id]);

  if (!data) return <p>Loading…</p>;
  const { search, leads } = data;
  return (
    <div>
      <h2>{search.business_type} in {search.location}</h2>
      {search.status === "failed"
        ? <p className="error">Search failed: {search.error}</p>
        : <div className="card">
            <div className="row"><span>{search.processed_count} of {search.found_count || "?"} businesses audited</span>
              {search.status === "running" && search.found_count === 0 && <span className="muted">Fetching listings…</span>}</div>
            <progress max={search.found_count || 1} value={search.processed_count} />
          </div>}
      <LeadTable rows={leads} />
    </div>
  );
}
```

- [ ] **Step 5: Typecheck, build, manual check**

Run: `npm run typecheck && npm run build`
Expected: no errors.
In `npm run dev` with a real `BRIGHTDATA_*` key: start a 5-result search, confirm redirect to the detail page, the progress bar advances, and rows appear sorted by score.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: new search form and search detail with lead table"
```

---

### Task 17: Frontend — Lead Detail and All Leads

**Files:**
- Modify: `src/client/pages/LeadDetail.tsx`, `src/client/pages/AllLeads.tsx`

**Interfaces:**
- Consumes: `api`; endpoints `GET/PATCH /leads/:id`, `PATCH /leads/:id/draft`, `POST /leads/:id/regenerate`, `POST /leads/:id/reaudit`, `GET /leads?status=`; `LeadTable`, `STATUSES` (Task 16).

- [ ] **Step 1: LeadDetail**

`src/client/pages/LeadDetail.tsx`:
```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { STATUSES, type Business, type LeadStatus } from "../types";

interface Finding { code: string; severity: string; points: number; evidence: string; }
interface Audit { score: number; offer: string; partial: boolean; site_status: string; findings: Finding[]; created_at: string; }
interface Contact { id: string; type: string; value: string; source_url: string | null; person_name: string | null; role: string | null; }
interface Draft { id: string; subject: string; body: string; recipient_reason: string; edited: boolean; }
interface Data { business: Business; audit: Audit | null; contacts: Contact[]; draft: Draft | null; toContact: Contact | null; }

export default function LeadDetail() {
  const { id } = useParams();
  const [d, setD] = useState<Data | null>(null);
  const [subject, setSubject] = useState(""); const [body, setBody] = useState("");
  const [steer, setSteer] = useState(""); const [busy, setBusy] = useState(""); const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState("");

  async function load() {
    const x = await api.get<Data>(`/leads/${id}`);
    setD(x); setSubject(x.draft?.subject ?? ""); setBody(x.draft?.body ?? ""); setNotes(x.business.notes ?? "");
  }
  useEffect(() => { load(); }, [id]);
  if (!d) return <p>Loading…</p>;
  const b = d.business;
  const dirty = d.draft && (subject !== d.draft.subject || body !== d.draft.body);

  async function saveDraft() { if (dirty) await api.patch(`/leads/${id}/draft`, { subject, body }); }
  async function setStatus(s: LeadStatus) { await api.patch(`/leads/${id}`, { leadStatus: s }); await load(); }
  async function copy() { await saveDraft(); await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); setMsg("Copied"); }
  async function copyAndMark() { await copy(); await setStatus("contacted"); setMsg("Copied and marked contacted"); }
  async function regenerate() {
    setBusy("regen"); setMsg("");
    try { await api.post(`/leads/${id}/regenerate`, { steeringNote: steer }); setSteer(""); await load(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  }
  async function reaudit() { await api.post(`/leads/${id}/reaudit`); setMsg("Re-audit started. Refresh in a minute."); }
  const mailto = d.toContact ? `mailto:${d.toContact.value}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : null;

  return (
    <div className="grid2">
      <div className="card">
        <h2>{b.name}</h2>
        <p className="muted">{b.category} · {b.address}</p>
        <p className="row">
          {b.website_url ? <a href={b.website_url} target="_blank" rel="noreferrer">Website</a> : <span className="badge">no website</span>}
          {b.maps_url && <a href={b.maps_url} target="_blank" rel="noreferrer">Google Maps</a>}
          {b.phone && <span>{b.phone}</span>}
        </p>
        {b.last_error && <p className="error">⚠ {b.last_error}</p>}
        {d.audit ? <>
          <h3>Score {d.audit.score} <span className="badge">{d.audit.offer}</span> {d.audit.partial && <span className="badge">partial audit</span>}</h3>
          <ul>{d.audit.findings.map((f) => <li key={f.code}><strong>+{f.points}</strong> {f.evidence}</li>)}</ul>
          <p className="muted">Audited {new Date(d.audit.created_at).toLocaleString()}</p>
        </> : <p className="muted">Audit in progress…</p>}
        <h3>Contacts</h3>
        <ul>{d.contacts.map((c) => (
          <li key={c.id}>{c.type}: {c.value}{c.person_name && ` (${c.person_name}${c.role ? `, ${c.role}` : ""})`}
            {c.source_url && <> · <a href={c.source_url} target="_blank" rel="noreferrer">source</a></>}</li>
        ))}{!d.contacts.length && <li className="muted">None found</li>}</ul>
        <label htmlFor="status">Status</label>
        <select id="status" value={b.lead_status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <label htmlFor="notes">Notes</label>
        <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => api.patch(`/leads/${id}`, { notes })} />
        <p className="row"><button onClick={reaudit}>Re-audit</button><button onClick={() => setStatus("skip")}>Skip</button></p>
      </div>

      <div className="card">
        <h2>Draft email</h2>
        {d.draft ? <>
          <p><strong>To:</strong> {d.toContact?.value ?? "—"} <span className="muted">({d.draft.recipient_reason})</span></p>
          <label htmlFor="subj">Subject</label>
          <input id="subj" value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={saveDraft} />
          <label htmlFor="body">Body</label>
          <textarea id="body" style={{ minHeight: 320 }} value={body} onChange={(e) => setBody(e.target.value)} onBlur={saveDraft} />
          <p className="muted">{body.trim().split(/\s+/).length} words</p>
          <p className="row">
            <button onClick={copy}>Copy email</button>
            {mailto && <a href={mailto} onClick={saveDraft}><button>Open in mail app</button></a>}
            <button className="primary" onClick={copyAndMark}>Copy & mark contacted</button>
          </p>
        </> : <p className="muted">No draft yet{d.audit && d.audit.score < 20 ? " (low priority lead)" : ""}.</p>}
        <label htmlFor="steer">Regenerate with a note (optional)</label>
        <div className="row">
          <input id="steer" style={{ flex: 1 }} placeholder="shorter / mention I'm local" value={steer} onChange={(e) => setSteer(e.target.value)} />
          <button onClick={regenerate} disabled={busy === "regen"}>{busy === "regen" ? "Writing…" : d.draft ? "Regenerate" : "Generate draft"}</button>
        </div>
        {msg && <p className="muted">{msg}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: AllLeads**

`src/client/pages/AllLeads.tsx`:
```tsx
import { useEffect, useState } from "react";
import { api } from "../api";
import { STATUSES, type LeadRow, type LeadStatus } from "../types";
import LeadTable from "./LeadTable";

export default function AllLeads() {
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  useEffect(() => { setRows(null); api.get<LeadRow[]>(`/leads${status ? `?status=${status}` : ""}`).then(setRows); }, [status]);
  return (
    <div>
      <div className="row"><h2 style={{ margin: 0 }}>All leads</h2>
        <select style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | "")}>
          <option value="">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      {rows ? <LeadTable rows={rows} /> : <p>Loading…</p>}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck, build, manual check**

Run: `npm run typecheck && npm run build && npm test`
Expected: no type errors; all tests pass.
Manual in `npm run dev`: open a lead → status becomes `reviewed`; edit the draft and blur → reload keeps the edit; "Copy & mark contacted" sets status; Regenerate with a note produces a new draft; All leads filter by `contacted` shows it.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: lead detail with draft editing and all-leads view"
```

---

### Task 18: Prompt check, voice seeding, deploy, smoke test

**Files:**
- Create: `scripts/prompt-check.ts`, `scripts/fixtures/leads.json`, `README.md`

**Interfaces:**
- Consumes: `generateDraft`, `anthropicCaller`, `wordCount` (Task 9).

- [ ] **Step 1: Write prompt fixtures**

`scripts/fixtures/leads.json` — 5 leads, one per offer plus a no-website case:
```json
[
  { "business": { "name": "Ace Plumbing", "category": "Plumber", "address": "Boise, ID", "website_url": "https://aceplumbing.com" },
    "offer": "performance",
    "findings": [
      { "code": "slow_mobile", "group": "speed", "severity": "high", "points": 25, "evidence": "Scores 31/100 on Google's mobile speed test" },
      { "code": "slow_lcp", "group": "speed", "severity": "medium", "points": 10, "evidence": "Main content takes about 8.4 seconds to appear on a phone" }
    ],
    "contacts": [{ "id": "c1", "type": "email", "value": "info@aceplumbing.com", "source_url": "https://aceplumbing.com/contact", "person_name": null, "role": null, "confidence": 0.7 }] },
  { "business": { "name": "Grace Community Church", "category": "Church", "address": "Meridian, ID", "website_url": "https://gracemeridian.org" },
    "offer": "care_plan",
    "findings": [
      { "code": "past_events", "group": "stale", "severity": "low", "points": 5, "evidence": "Lists events that already happened (e.g. 2025-04-20)" },
      { "code": "old_copyright", "group": "stale", "severity": "medium", "points": 10, "evidence": "The footer still says © 2021" },
      { "code": "stale_content", "group": "stale", "severity": "medium", "points": 10, "evidence": "The newest post or update is from 2023-11" }
    ],
    "contacts": [{ "id": "c2", "type": "email", "value": "pastor.mike@gracemeridian.org", "source_url": "https://gracemeridian.org/staff", "person_name": "Mike Hale", "role": "Pastor", "confidence": 0.9 }] },
  { "business": { "name": "Rivera Landscaping", "category": "Landscaper", "address": "Nampa, ID", "website_url": null },
    "offer": "new_site",
    "findings": [{ "code": "no_website", "group": "site", "severity": "high", "points": 100, "evidence": "No website listed on their Google Business profile" }],
    "contacts": [] },
  { "business": { "name": "Smith Law", "category": "Law firm", "address": "Boise, ID", "website_url": "http://smithlawboise.com" },
    "offer": "seo_basics",
    "findings": [
      { "code": "no_https", "group": "basics", "severity": "high", "points": 15, "evidence": "The site isn't secure (no HTTPS), so browsers show a warning" },
      { "code": "no_title_or_meta", "group": "basics", "severity": "low", "points": 6, "evidence": "The homepage is missing the title or summary Google shows in search results" }
    ],
    "contacts": [{ "id": "c4", "type": "form", "value": "http://smithlawboise.com/contact", "source_url": null, "person_name": null, "role": null, "confidence": 0.6 }] },
  { "business": { "name": "Bluebird Bakery", "category": "Bakery", "address": "Eagle, ID", "website_url": "https://bluebirdbakes.com" },
    "offer": "new_site",
    "findings": [
      { "code": "not_mobile_friendly", "group": "speed", "severity": "high", "points": 20, "evidence": "The site isn't set up for phones, so text and buttons are hard to use" },
      { "code": "old_copyright", "group": "stale", "severity": "medium", "points": 10, "evidence": "The footer still says © 2016" }
    ],
    "contacts": [{ "id": "c5", "type": "email", "value": "bluebirdbakes@gmail.com", "source_url": "https://bluebirdbakes.com", "person_name": null, "role": null, "confidence": 0.7 }] }
]
```

- [ ] **Step 2: Write the script**

`scripts/prompt-check.ts`:
```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { generateDraft, anthropicCaller, wordCount } from "../src/worker/drafter/draft";
import type { Settings } from "../src/worker/types";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error("Set ANTHROPIC_API_KEY"); process.exit(1); }

const settings: Settings = {
  your_name: "Logan Irish", business_name: process.env.BIZ_NAME ?? "Logan Irish Web", contact_email: "",
  services_blurb: "I build, speed up, and look after websites for small local businesses.",
  signature: "Logan Irish", physical_address: process.env.ADDRESS ?? "123 Main St, Boise, ID 83702",
  opt_out_line: "If you'd rather not hear from me, just reply \"no thanks\" and I won't follow up.",
  tone_notes: process.env.TONE ?? "", monthly_spend_limit_usd: 25,
};
const JARGON = /\b(LCP|CLS|Core Web Vitals|meta description|viewport|SEO)\b/i;
const leads = JSON.parse(readFileSync("scripts/fixtures/leads.json", "utf8"));
const call = anthropicCaller(key);
let failures = 0; const out: string[] = [];

for (const l of leads) {
  const d = await generateDraft({ settings, business: { id: "x", ...l.business }, findings: l.findings, offer: l.offer, contacts: l.contacts.map((c: any) => ({ business_id: "x", ...c })), steeringNote: null }, call);
  const bodyNoFooter = d.body.replace(settings.signature, "").replace(settings.physical_address, "").replace(settings.opt_out_line, "");
  const checks = {
    under120: wordCount(bodyNoFooter) < 120,
    address: d.body.includes(settings.physical_address),
    optOut: d.body.includes(settings.opt_out_line),
    noJargon: !JARGON.test(d.body),
  };
  const ok = Object.values(checks).every(Boolean);
  if (!ok) failures++;
  out.push(`## ${l.business.name} (${l.offer}) ${ok ? "PASS" : "FAIL " + JSON.stringify(checks)}\nTo: ${d.to_contact_id ?? "—"} (${d.recipient_reason})\nSubject: ${d.subject}\n\n${d.body}\n`);
}
mkdirSync("scripts/out", { recursive: true });
writeFileSync("scripts/out/prompt-check.md", out.join("\n---\n\n"));
console.log(out.join("\n---\n\n"));
console.log(failures ? `\n${failures} draft(s) failed checks` : "\nAll drafts passed checks");
process.exit(failures ? 1 : 0);
```

Add `scripts/out` to `.gitignore`.

- [ ] **Step 3: Seed tone notes from logan-voice**

Read the `logan-voice` skill (`Skill` tool, skill `logan-voice`) and condense its rules into ≤ 15 short lines suitable for `tone_notes` (sentence length, words to avoid, how Logan opens and closes, formality). Save them to `scripts/tone-notes.txt`. Run:

```bash
ANTHROPIC_API_KEY=... TONE="$(cat scripts/tone-notes.txt)" npm run prompt-check
```

Expected: 5 drafts printed, "All drafts passed checks". Read each draft; if any cites a finding not given or sounds off-voice, adjust `src/worker/drafter/prompt.ts` rules or the tone notes and rerun. Show the output file to Logan for a voice check.

- [ ] **Step 4: README**

`README.md`:
```markdown
# Site Search

Personal tool: find local businesses, audit their websites, draft outreach emails.

## Setup
1. `npm install`
2. `npx wrangler d1 create site-search` → paste id into `wrangler.jsonc`
3. `npx wrangler r2 bucket create site-search-raw`
4. `cp .dev.vars.example .dev.vars` and fill in keys
5. `npm run db:migrate:local && npm run dev`

## Deploy
1. `npm run db:migrate:remote`
2. Set secrets: `npx wrangler secret put APP_PASSWORD` (repeat for SESSION_SECRET, BRIGHTDATA_API_KEY, BRIGHTDATA_SERP_ZONE, PAGESPEED_API_KEY, ANTHROPIC_API_KEY)
3. `npm run deploy`
4. Sign in, fill in Settings (address + opt-out are required for CAN-SPAM), paste tone notes from `scripts/tone-notes.txt`.

## Keys
- Bright Data: SERP API zone + API key.
- PageSpeed: Google Cloud API key with PageSpeed Insights API enabled.
- Anthropic: API key.

## Tuning
Scoring weights: `src/worker/scoring/config.ts`. Prices for the spend guard: `src/worker/cost.ts`.
```

- [ ] **Step 5: Deploy**

```bash
npm test && npm run typecheck
npm run db:migrate:remote
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put BRIGHTDATA_API_KEY
npx wrangler secret put BRIGHTDATA_SERP_ZONE
npx wrangler secret put PAGESPEED_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

Expected: deploy prints the `*.workers.dev` URL.

- [ ] **Step 6: Manual smoke test (spec §9)**

On the deployed URL:
1. Sign in; fill Settings including address, opt-out, tone notes.
2. Run one search with `maxResults: 10` in Logan's city.
3. Confirm: progress reaches 10/10 within ~5 minutes; at least one lead has a score ≥ 60; at least one has an email contact; no lead is stuck without an audit (⚠ leads show an error and the Re-audit button works).
4. Open the top lead; check the draft cites real findings, is under 120 words, and ends with the address and opt-out line.
5. Copy & mark contacted; confirm it appears under All leads → contacted.
6. Check Settings → This month shows Bright Data and Claude usage.

Record any issues found as follow-up tasks; fix blockers before calling v1 done.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: prompt check script, README, deploy config"
```

---

## Self-Review Notes

- **Spec coverage:** §1 goals → Tasks 12–17; §2 components → Tasks 3–9, 12–13; §3 data model → Task 2 (+`contact_email`, `domain` additions noted); §4 scoring → Task 3; §5 recipient → Task 4; §6 drafting → Task 9, 18; §7 screens → Tasks 15–17; §8 error handling → Tasks 6, 7, 9, 10, 12, 13; §9 testing → every task + Task 18; §10 secrets → Tasks 1, 18 (added `BRIGHTDATA_SERP_ZONE`, required by the SERP API); §11 compliance → Tasks 6 (user-agent), 9 (footer enforcement), 15 (settings labels).
- **Known deviations from spec, flagged for Logan:** PageSpeed throttling uses batched workflow starts instead of a Cloudflare Queue; radius is stored but not applied to the Bright Data query in v1; Bright Data Maps JSON field names must be confirmed from a live capture in Task 8 Step 1.
