# Agency OS — Plan 9: Client and Site Records, Access Checklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every client one record page and every client site its own record with an access checklist that holds password-manager item names only, so Logan can see at a glance who a client is, what they pay, what they host where, and what access is still missing.

**Architecture:** The organization record stays the existing `businesses` row (a client is a lead that is won, or that has a project); nothing is duplicated. Two new tables hold what is new: `sites` (one or more per business) and `site_access_items` (a fixed six-row checklist per site). A new `src/worker/sites/` folder holds the pure rules (what a vault name may contain, what is flagged) and the seeding; a new `src/worker/clients/` folder assembles the client record from tables that already exist (people, subscriptions, projects, invoices, documents, change orders, activity). The owner UI gets a client list, a three-column client page (spec §6) and a site/access panel. A Today row names clients whose access is still missing.

**Tech Stack:** Existing stack (Workers, Hono, D1, zod, vitest Workers pool, React SPA). No new npm packages.

**Spec:** `docs/superpowers/specs/2026-11-17-agency-os-design.md` (source: `/Users/loganirish/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md`). Implemented: §7 Site record (URL, CMS, host, registrar, DNS provider, admin URL, hosting tier, access method, password-manager item names only) and Organization/Contact as they apply to a client; §6 record-page layout (details left, timeline middle, linked things right, header strip with Care and money); §9.5 site access checklist (host, DNS, registrar, admin, GBP, analytics; item names only); §9.8 "client-hosted sites allowed if SSH+WP-CLI or MainWP works, otherwise the checklist flags it"; §12 Phase 2 line "Client and site records with access checklist"; §2 anti-goal (no passwords stored). **Not in this plan:** health score and A/B/C grade (spec §12 puts "Health, grade, capacity" in Phase 3), the site `monitoring status` field (Phase 3's Care fleet is the only thing that can set it truthfully), the "let me move you" recommendation draft (Phase 3, only the flag is built here), MCP tools for clients and sites (Plan 10), the MRR dashboard (Plan 10, which reuses `clientMrrCents`), a contact-role vocabulary (the existing free-text `people.role` stays).

**Phase 2 roadmap:** 6 Onboarding (merged) · 7 Projects (merged) · 8 Billing (merged) · **9 Client and site records, access checklist (this plan)** · 10 Meetily, full MCP, money dashboard v1.

**Starts from:** `main` at `bf05cc1` (Plan 8 merged). Relies on: `businesses` and `siteDomain`/`domainOf` (`db/businesses.ts`), `people` (`db/people.ts`), `activity` (`db/activity.ts`: `activityStmt`, `logActivityOnce`; `ACTIVITY_KINDS` in `types.ts`), `subscriptions` (`db/subscriptions.ts`: `listSubscriptions`, `Subscription`), `projects` (`db/projects.ts`: `listProjects`, `liveProjectSql`, `hasProject`), `invoices` (`db/invoices.ts`: `listInvoices`), `changeOrders` (`db/changeOrders.ts`: `listChangeOrders`), `documents` (`db/documents.ts`), `holds` (`db/holds.ts`: `isOnHold`), `onboarding/start.ts` (`startOnboarding`), `projects/start.ts` (`begin`), `onboarding/templates.ts` (`ITEM_TEMPLATES`, `cleanText`, `looksLikeCredential`), `projects/http.ts` (`bodyOf`, `NOT_FOUND`, `ownerOnError`), `today.ts` (`buildToday`, `billingAttention` as the pattern for a per-client Today reason).

## Global Constraints

- Branch `feat/agency-os-clients` from `main`, worktree `../site-search-agency-os`. `npm test && npm run typecheck` pass after every task; `npm run build` after every UI task. Never edit an applied or merged migration; the new one is `0058_sites.sql` (0057 is the latest).
- **Models:** Sonnet for Tasks 1–6 and 9 (schema, security rules, money numbers, whole-branch review). Haiku is fine for Task 7 (labels, nav, one link) and for fixture-only edits. Set `model` explicitly on every dispatch.
- **No secret is ever stored (spec §2 anti-goal).** A site's access item holds the *name* of a password-manager item, never a login, key, token or recovery code. The vault name and the access note are **owner-only**: they never appear on any client page, in any mail or approval body, in an activity line, in a log or error message, or in `get_lead`/any MCP output.
- Everything typed (by Logan or a client) goes through `cleanText` before it is stored; every URL is `http(s)` only (the owner UI renders them as links, so `javascript:` and `data:` are refused); every error is a plain sentence and never repeats the refused text.
- A **client** is a business with `lead_status = 'won'` or with at least one project. Test records (`test = 1`) never count in the client list, MRR or Today, and are shown only with `?test=1`.
- Money is integer cents; dates are `YYYY-MM-DD` in the booking time zone (`zoneOf`, default America/Los_Angeles); times are UTC ISO strings with milliseconds.
- Seeding is idempotent and never throws into a payment or project path: a failed seed logs a plain line and returns null.
- Follow existing patterns: zod on every route body, DB helpers in `src/worker/db/*.ts`, pure view helpers in `src/client/*View.ts` tested in `test/*-view.test.ts`, guards written into the SQL statement.

## Scope decisions (flag to Logan)

- **No new "organization" table.** The client record is `businesses` plus linked rows. A new `/clients` list and `/clients/:id` page sit beside the lead pages; the lead page links to the client page once the lead is won.
- **Six fixed access items per site:** `hosting`, `dns`, `registrar`, `admin`, `gbp`, `analytics` (spec §9.5). GBP and analytics are repeated on every site of a client; Logan marks the ones that do not apply `not_applicable`.
- **Access statuses:** `needed` → `requested` → `received` → `verified` (Logan confirmed it works), or `not_applicable`. The vault item name is optional (an invitation as a user has no stored login). Going back from `received`/`verified` clears the later timestamps.
- **Care status is derived**, never stored: it is read from the client's active subscriptions.
- **Hosting tier is seeded from the signed packages** (`client_hosted_surcharge` ⇒ client-hosted; a build or Care package ⇒ Logan-hosted; otherwise unknown) and is Logan's to edit; an edit is never overwritten by a later seed.
- **Client-facing access questions (Task 8) are the cut line.** They add six phase-1 text items to every onboarding with a job in it and change a Plan 6 test that said light onboardings get no items. Drop Task 8 first if the branch has to shrink; the owner checklist works without it.
- Parked Plan 7 item "change orders on a done build are invisible" is addressed here: the client page lists every change order of the client, whatever the state of its project.

## Review Focus

1. **A password typed into the wrong box.** A vault-name or note containing `password: hunter2`, a bare `Tr0ub4dor&3xyz`, `https://user:pw@host/`, `sk_live_…`, a private-key header, a JWT. Refused with a plain sentence that does not echo it. Tests in Tasks 2 and 4.
2. **The vault name leaking.** Client onboarding page JSON, activity detail, approval or mail bodies, error text, `get_lead`. Tests in Tasks 4 and 9.
3. **Duplicate or lost sites.** Onboarding start, project start and a manual add racing; a retried start; a real document arriving after a test one; two sites for one business; the same domain added twice. Tests in Task 3.
4. **Wrong client numbers.** A test subscription, a cancelled one, a past-due one, two Care rows, a lead that is won but has no project, a client with a project but not won, MRR counting a client twice because of two sites. Tests in Task 4.
5. **Hostile or stale rows.** `javascript:` as a site or admin URL; an archived site still flagged on Today; a lead with sites deleted (a foreign-key failure instead of a plain refusal); a site opened under the wrong client's id. Tests in Tasks 1, 4 and 5.

---

### Task 1: Tables and site database layer

**Files:**
- Create: `migrations/0058_sites.sql`, `src/worker/db/sites.ts`, `test/sites-db.test.ts`
- Modify: `src/worker/routes/leads.ts:300-302` (refuse to delete a lead that has a site), `test/fixtures/projects.ts` (`resetProjectWork` deletes `site_access_items` then `sites` first, so tests that clear businesses do not hit the foreign key)

**Interfaces:**
- Consumes: `businesses(id)`; `Hono` lead delete refusals as written at `routes/leads.ts:300-302`.
- Produces (`db/sites.ts`):
  - `ACCESS_KEYS = ["hosting","dns","registrar","admin","gbp","analytics"] as const; type AccessKey`
  - `ACCESS_STATUSES = ["needed","requested","received","verified","not_applicable"] as const; type AccessStatus`
  - `type HostingTier = "logan_hosted"|"client_hosted"|"unknown"`; `type AccessMethod = "ssh_wpcli"|"mainwp"|"none"|"unknown"`; `type Cms = "wordpress"|"webflow"|"wix"|"squarespace"|"shopify"|"custom"|"unknown"`
  - `interface Site { id; businessId; seedKey: "primary"|null; url: string|null; domain: string|null; cms: Cms; hostProvider: string|null; registrar: string|null; dnsProvider: string|null; adminUrl: string|null; hostingTier: HostingTier; accessMethod: AccessMethod; notes: string|null; test: boolean; archivedAt: string|null; createdAt: string; updatedAt: string }`
  - `interface AccessItem { siteId; key: AccessKey; status: AccessStatus; vaultItem: string|null; note: string|null; requestedAt: string|null; receivedAt: string|null; verifiedAt: string|null; updatedAt: string }`
  - `createSite(db, o: { businessId: string; seedKey?: "primary"; test?: boolean } & Partial<SiteFields>): Promise<{ site: Site; created: boolean }>` — one `db.batch` inserts the site and its six `needed` items; with a `seedKey` a second call returns the existing site and `created: false`.
  - `getSite(db, id): Promise<Site|null>`, `listSites(db, o: { businessId?: string; includeArchived?: boolean }): Promise<Site[]>`, `updateSite(db, id, patch: Partial<SiteFields>, now: string): Promise<Site|null>`, `archiveSite(db, id, now): Promise<boolean>`, `hasSite(db, businessId): Promise<boolean>`
  - `listAccess(db, siteId): Promise<AccessItem[]>` (always six, in `ACCESS_KEYS` order), `setAccess(db, siteId, key, patch: { status?: AccessStatus; vaultItem?: string|null; note?: string|null }, now: string): Promise<AccessItem|null>`

- [ ] **Step 1: Write the failing tests** in `test/sites-db.test.ts`: `createSite makes the site and exactly six needed items`; `a seeded site is created once and a second call returns it with created false`; `two hand-added sites for one business are allowed`; `a duplicate domain on the same business is refused (a plain error, not a crash)`; `setAccess to requested stamps requested_at, to received stamps received_at, to verified stamps verified_at`; `moving verified back to requested clears received_at and verified_at but keeps requested_at`; `setAccess on an unknown site or key returns null`; `archiveSite hides the site from listSites unless includeArchived`; `hasSite is true for an archived site too` (so a lead is never deleted from under its history).
- [ ] **Step 2: Run** `npx vitest run test/sites-db.test.ts`. Expected: FAIL (`no such table: sites`).
- [ ] **Step 3: Write `0058_sites.sql`.** `sites(id PK, business_id NOT NULL REFERENCES businesses(id), seed_key TEXT, url, domain, cms, host_provider, registrar, dns_provider, admin_url, hosting_tier, access_method, notes, test, archived_at, created_at, updated_at)` with CHECKs on `cms`, `hosting_tier`, `access_method` (the values above), `test IN (0,1)`; `UNIQUE INDEX uq_sites_seed ON sites(business_id, seed_key) WHERE seed_key IS NOT NULL`; `UNIQUE INDEX uq_sites_domain ON sites(business_id, domain) WHERE domain IS NOT NULL AND archived_at IS NULL`; `INDEX idx_sites_business`. `site_access_items(site_id NOT NULL REFERENCES sites(id), key CHECK in the six, status CHECK in the five DEFAULT 'needed', vault_item, note, requested_at, received_at, verified_at, updated_at, PRIMARY KEY(site_id, key))`. No `ON DELETE CASCADE` (a client with sites is archived, never deleted). Header comment says "item names only, never a login".
- [ ] **Step 4: Implement `db/sites.ts`** per the Interfaces. Row mappers like `db/subscriptions.ts`. Timestamp rules are written into one `UPDATE` with `CASE` so two writers cannot disagree. The domain is `siteDomain(url)`.
- [ ] **Step 5: Add the lead-delete refusal** `if (await hasSite(c.env.DB, id)) return c.json({ error: "this lead has a site record" }, 409);` beside the existing two, and add the two tables to `resetProjectWork`.
- [ ] **Step 6: Run** `npx vitest run test/sites-db.test.ts && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(sites): sites and access tables and database layer`.

### Task 2: Access rules (pure)

**Files:**
- Create: `src/worker/sites/access.ts`, `test/sites-access.test.ts`

**Interfaces:**
- Consumes: `looksLikeCredential`, `cleanText` (`onboarding/templates.ts`); `AccessKey`, `AccessItem`, `Site` (Task 1).
- Produces:
  - `ACCESS_LABELS: Record<AccessKey, { label: string; help: string }>` — labels "Hosting", "DNS", "Registrar", "Site admin", "Google Business Profile", "Analytics"; each `help` says what to record and ends "Name the password manager item, never the login."
  - `vaultNameProblem(raw: string): string | null` — null when fine (empty is fine: it clears the field); otherwise a plain sentence that never repeats the input.
  - `noteProblem(raw: string): string | null` — the same secret-shape checks as the name, without the single-token rule, cap 500 characters.
  - `cleanVaultName(raw: string): string | null` — `cleanText(raw, 80)`, empty ⇒ null.
  - `unresolved(items: AccessItem[]): AccessItem[]` — items not `received`, `verified` or `not_applicable`.
  - `type SiteFlag = { code: "access_missing" | "client_hosted_no_access"; text: string }`
  - `siteFlags(o: { site: Site; items: AccessItem[]; careActive: boolean }): SiteFlag[]` — `access_missing` text is `"Still missing: Hosting, DNS."` listing the labels; `client_hosted_no_access` applies when the tier is `client_hosted`, Care is active and `accessMethod` is `none` or `unknown`, text `"Care on a client-hosted site needs SSH with WP-CLI or a MainWP connection. Ask for access, or recommend moving the site to your hosting."`; an archived site has no flags.

- [ ] **Step 1: Write the failing tests.** `vaultNameProblem` accepts `"Acme Plumbing - GoDaddy"`, `"Acme Plumbing GoDaddy login item"` and `"acme-godaddy-owner"`; it refuses (and the returned sentence does not contain the input) (and that the returned sentence does not contain the input): `"password: hunter2"`, `"Tr0ub4dor&3xyzQ9"`, `"https://admin:pw@acme.com/"`, `"https://acme.com/wp-admin"` (a name is not a link), `"sk_live_51Habc123def456"`, `"AKIAIOSFODNN7EXAMPLE"`, `"-----BEGIN PRIVATE KEY-----"`, `"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc"`, `"a".repeat(81)` and a 32-character hex string. Control and bidi characters are stripped before the check (`"Acme‮ GoDaddy"` ⇒ `"Acme GoDaddy"`). `noteProblem` accepts `"Owner is Dana; invited me as editor on 12/3."` and refuses `"login = dana / hunter2"`. `siteFlags`: all six `needed` ⇒ `access_missing` lists six labels; one `not_applicable` and the rest `verified` ⇒ no flags; client-hosted + Care + `none` ⇒ `client_hosted_no_access`; Logan-hosted + `none` ⇒ no flag; archived ⇒ `[]`.
- [ ] **Step 2: Run** `npx vitest run test/sites-access.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** The single-token rule is: no whitespace, length ≥ 16, and at least three of {lowercase, uppercase, digit, symbol}. Sentences: `"That looks like a login or a key. Type only the name of the password manager item."` and `"A password manager item name is a name, not a link."`.
- [ ] **Step 4: Run** the file, then `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sites): access rules and site flags`.

### Task 3: Seed sites from a sale

**Files:**
- Create: `src/worker/sites/seed.ts`, `test/sites-seed.test.ts`
- Modify: `src/worker/onboarding/start.ts` (after `createOnboarding`), `src/worker/projects/start.ts` (in `begin`), `src/worker/types.ts` (`ACTIVITY_KINDS` gains `"site_added"`, `"access_changed"`)

**Interfaces:**
- Consumes: `createSite`, `getSite`, `listSites`, `updateSite` (Task 1); `siteDomain`; `logActivityOnce`; `PackageKey`; `BUILD_KEYS` (`documents/schedule.ts`).
- Produces:
  - `hostingTierFor(keys: PackageKey[]): HostingTier` — `client_hosted_surcharge` ⇒ `client_hosted`; else any key in `BUILD_KEYS` or `care`/`care_plus`/`care_fallback` ⇒ `logan_hosted`; else `unknown`.
  - `ensureSite(db: D1Database, o: { businessId: string; packageKeys: PackageKey[]; test: boolean }): Promise<{ site: Site; created: boolean } | null>` — seeds the `primary` site from the business's `website_url`; returns null (and logs one plain line) on any failure, never throws.

- [ ] **Step 1: Write the failing tests.** `a signed starter site seeds one primary site with the business's domain and logan_hosted`; `client_hosted_surcharge in the packages seeds client_hosted`; `a business with no website still gets a site, with null url and domain`; `calling ensureSite twice leaves one site and one site_added line`; `two ensureSite calls at once leave one site` (`Promise.all`); `a real document after a test one turns the site real (test 0)`; `a test document after a real one leaves it real`; `an owner-edited hosting tier is not overwritten by a later seed, but an unknown tier is filled`; `startOnboarding on a signed proposal seeds the site`; `a project start seeds the site when onboarding did not`; `a failing seed never fails the onboarding or the project start` (force `createSite` to throw via a bad business id).
- [ ] **Step 2: Run** `npx vitest run test/sites-seed.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `ensureSite`** with the seed key `primary`, so the unique index makes it idempotent; on a conflict read the existing row and apply only the two allowed updates above. Wrap in `try/catch`, `console.error("sites: not seeded", message)` with no input echoed.
- [ ] **Step 4: Wire it in.** Call `ensureSite(env.DB, { businessId: doc.businessId, packageKeys: keys, test })` once in `startOnboarding` after the onboarding row exists (outside the success path's return value) and once in `begin` with the document's package keys. Log `site_added` with detail `"Site record made for <domain or 'a new site'>"` once per site.
- [ ] **Step 5: Run** the file, then `npm test && npm run typecheck`. Expected: PASS (the existing onboarding and project tests still pass).
- [ ] **Step 6: Commit** `feat(sites): seed a site record when a sale starts onboarding or a project`.

### Task 4: Client record, list and routes

**Files:**
- Create: `src/worker/clients/record.ts`, `src/worker/routes/clients.ts`, `test/clients-record.test.ts`, `test/clients-routes.test.ts`, `test/fixtures/clients.ts`
- Modify: `src/worker/index.ts` (mount `clientRoutes` under `/api`), `src/worker/db/changeOrders.ts` (add `listChangeOrdersForBusiness`)

**Interfaces:**
- Consumes: Tasks 1–3; `listPeople`; `listSubscriptions`; `listProjects`; `listInvoices`; `listChangeOrders`; `isOnHold`; the documents helper that lists a business's documents (add `listForBusiness(db, businessId)` in `db/documents.ts` if none exists); `listActivity`; `bodyOf`, `NOT_FOUND`, `ownerOnError`; `cleanText`.
- Produces (`clients/record.ts`):
  - `isClient(db, businessId): Promise<boolean>`
  - `clientMrrCents(subs: Subscription[]): number` — sum of `monthlyCents` over `active` and `past_due`, `test` excluded; Plan 10 reuses it.
  - `careLabel(subs: Subscription[]): string | null` — `"Care $129/mo"` style for the active `care`, `care_plus` or `care_fallback` row; null when none.
  - `interface ClientRow { id; name; careLabel: string|null; mrrCents: number; siteCount: number; accessMissing: number; openInvoiceCents: number; held: boolean; nextRenewalOn: string|null }`
  - `listClients(db, o: { includeTest?: boolean }): Promise<ClientRow[]>`
  - `interface ClientRecord { business; people; sites: { site: Site; access: AccessItem[]; flags: SiteFlag[] }[]; subscriptions; mrrCents; careLabel; projects; invoices: { openCents; overdueCount; paidCents }; documents; changeOrders; held: boolean; nextRenewalOn: string|null; activity }`
  - `getClientRecord(db, businessId, now: Date): Promise<ClientRecord | null>` — null for an unknown id or a lead that is not a client.
- Produces (routes, behind `requireAuth`): `GET /clients` (`?test=1`), `GET /clients/:id`, `POST /clients/:id/sites` (201), `PATCH /sites/:id`, `DELETE /sites/:id` (archives; 204), `PUT /sites/:id/access/:key` (body `{ status?, vaultItem?, note? }`). Every write logs one activity line (`site_added`, or `access_changed` with detail `"Hosting: received"`, status only, never the vault name).

- [ ] **Step 1: Write the failing record tests** (`seedClient` fixture: won business, a person, a site, subscriptions, a project, an invoice): `MRR counts active and past_due and not cancelled, ended, planned or test`; `two sites do not double the client's MRR`; `a client with Care and a Website Subscription shows Care $129/mo and both rows`; `a won lead with no project is a client; a lead with a project but not won is a client; a plain lead is not (getClientRecord returns null)`; `nextRenewalOn is the earliest term_ends_on among live subscriptions`; `a change order on a done project is listed`; `listClients excludes test records unless includeTest`; `an archived site is not listed in the record or counted in accessMissing`.
- [ ] **Step 2: Write the failing route tests:** `PUT access with status received and vaultItem "Acme GoDaddy" saves it and logs "Hosting: received" without the name`; `PUT access with vaultItem "password: x" is a 400 and nothing changes, and the error text does not contain the input`; `PATCH a site with url "javascript:alert(1)" or adminUrl "data:text/html,x" is a 400`; `PATCH hostingTier to an unknown value is a 400`; `a site under another client's id is a 404`; `DELETE archives and a second DELETE is 404`; `the raw JSON of GET /clients/:id is the only place the vault name appears` (assert it is absent from the activity array).
- [ ] **Step 3: Run** `npx vitest run test/clients-record.test.ts test/clients-routes.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `record.ts` with `Promise.all` over the existing helpers; list totals come from one SQL pass for `listClients` (do not call `getClientRecord` per row). The routes use zod with `cleanText` transforms, `vaultNameProblem`/`noteProblem` from Task 2, and `isHttpUrl` (a small helper in `sites/access.ts`: `new URL` succeeds and protocol is `http:` or `https:`).
- [ ] **Step 5: Run** both files, then `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(clients): client record, list and site/access routes`.

### Task 5: Today row for missing access

**Files:**
- Modify: `src/worker/today.ts` (add `access_missing` to `TODAY_KINDS`, add `accessAttention`, merge it where `billingAttention` is merged), `src/client/todayView.ts` (label and link for the new kind)
- Test: `test/sites-today.test.ts`

**Interfaces:**
- Consumes: `listSites`, `listAccess`, `unresolved` (Tasks 1–2); `liveProjectSql`; the `Today` item shape used by `billingAttention`.
- Produces: `accessAttention(db: D1Database, now: Date): Promise<Map<string, { reason: string; priority: number }>>` — one reason per client (priority 65), for a client with a live non-test project started at least 3 days ago and a non-archived, non-test site with unresolved items; reason `"Access still missing: Hosting, DNS"`.

- [ ] **Step 1: Write the failing tests:** `a client with a live project started 4 days ago and a needed item gets one row naming the labels`; `a project started 1 day ago gets no row`; `received, verified and not_applicable items do not count`; `an archived site, a test site and a cancelled project give no row`; `two sites with gaps give one row`; `the row clears when the last item is received`.
- [ ] **Step 2: Run** `npx vitest run test/sites-today.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `accessAttention` as one SQL join, mirror how `billingAttention` is merged so a client's money reason (priority 90 and 80) still wins when both exist; add the kind's label in `todayView.ts` linking to `/clients/<id>`.
- [ ] **Step 4: Run** the file, then `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(today): a row for clients whose site access is still missing`.

### Task 6: Client list and client page

**Files:**
- Create: `src/client/clientView.ts`, `src/client/pages/Clients.tsx`, `src/client/pages/Client.tsx`, `src/client/components/client/SitePanel.tsx`, `src/client/components/client/AccessChecklist.tsx`, `src/client/components/client/LinkedPanel.tsx`, `test/client-view.test.ts`
- Modify: `src/client/App.tsx` (routes `/clients` and `/clients/:id`), `src/client/api.ts` (typed calls for the six routes)

**Interfaces:**
- Consumes: `ClientRow`, `ClientRecord`, `AccessItem`, `SiteFlag` (types only, imported from the worker like `OnboardingTab` does); `ACCESS_LABELS`; `vaultNameProblem` (so the form refuses before the request).
- Produces (`clientView.ts`, pure): `accessTone(status: AccessStatus): "neutral"|"warn"|"good"`, `accessActions(status): AccessStatus[]` (the next sensible moves, e.g. `needed` ⇒ `["requested","not_applicable"]`), `moneyLabel(cents: number): string` (`"$129/mo"`, `"$1,998.50"`), `renewalLabel(nextRenewalOn: string | null, today: string): string` (`"Renews in 12 days"`, `"Term ended"`, `"No term"`), `siteTitle(site): string` (domain, else `"New site (no domain yet)"`), `safeHref(url: string | null): string | null` (http(s) only).

- [ ] **Step 1: Write the failing view tests:** `accessTone marks needed and requested as warn, received and verified as good`; `accessActions never offers the current status`; `moneyLabel formats integer cents and never shows NaN for 0`; `renewalLabel handles today, past, null and a date 400 days out`; `siteTitle for a site with no domain`; `safeHref rejects javascript:, data: and an empty string`.
- [ ] **Step 2: Run** `npx vitest run test/client-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `clientView.ts`**, then the pages. **Client page (spec §6):** header strip `name · Care label · MRR · Hold badge · Renewal`; three columns on desktop, one column on a phone. Left: About (people with the point of contact first, phone, website, notes), Sites (one `SitePanel` each: fields editable inline, the hosting-tier and access-method selects, flags in a warning box), and inside each site the six-row `AccessChecklist` (status select limited by `accessActions`, a vault-item name input with the hint "Type the name of the password manager item. Never the login." and the refusal shown inline, an owner-only note). Middle: the activity timeline (reuse `ActivityTab` and `activityView`). Right (`LinkedPanel`): projects (links to `/projects/:id`), invoices summary, documents, change orders, tasks open, next renewal. **List page:** one row per client with the `ClientRow` fields, sortable by MRR and by "access missing", a "show test" toggle.
- [ ] **Step 4: Run** the view tests, `npm test && npm run typecheck && npm run build`. Expected: PASS and a clean build.
- [ ] **Step 5: Look at it.** Start the dev server, seed one client with two sites through the routes, and open `/clients` and `/clients/<id>` at desktop and 375px width in the in-app browser. Record what you saw (or that it could not be run) in the ledger; this plan's earlier pages were never viewed against the real Worker, so say so plainly if that is still true.
- [ ] **Step 6: Commit** `feat(clients): client list, client page, site panel and access checklist`.

### Task 7: Navigation, lead link and timeline labels

**Files:**
- Modify: `src/client/navView.ts` (a "Clients" entry after "Pipeline"), `src/client/pages/LeadDetail.tsx` (a "Open client record" link in the header when `b.lead_status === "won"`), `src/client/activityView.ts` (labels for `site_added` and `access_changed`), `test/activity-view.test.ts`

**Interfaces:**
- Consumes: the two new activity kinds from Task 3.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test:** `site_added and access_changed each have an icon, a tone and a title, and the detail is shown as text`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Make the three edits.** Titles: "Site record added", "Access updated".
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(clients): nav entry, lead link and timeline labels`.

### Task 8: Ask the client where things live (cut line)

**Files:**
- Modify: `src/worker/onboarding/templates.ts` (six new `ITEM_TEMPLATES`), `src/worker/clients/record.ts` (attach each site's matching client answers), `src/client/components/client/AccessChecklist.tsx` (show the answer, read-only), `test/onboarding-templates.test.ts` (and any of `test/onboarding-start.test.ts`, `test/onboarding-schedule.test.ts`, `test/onboarding-public.test.ts` that assert a light onboarding has no items; find them with `grep -n "no items" test/onboarding-*.test.ts`)
- Test: `test/sites-onboarding-items.test.ts`

**Interfaces:**
- Consumes: `ITEM_TEMPLATES`, `itemsFor`, `looksLikeCredential` (`onboarding/templates.ts`); `listItems` (`db/onboardings.ts`).
- Produces: items with keys `access_hosting`, `access_dns`, `access_registrar`, `access_admin`, `access_gbp`, `access_analytics` (kind `text`, phase 1, applying to any onboarding whose packages include a job, so build and light alike; not to `hourly` or the surcharge alone); `AccessItem` in the record gains `clientAnswer: string | null` read from the item's `text_value` by key.

- [ ] **Step 1: Write the failing tests:** `itemsFor a starter site includes the six access items after the phase-1 content items`; `itemsFor care alone and quick fix include them too, and itemsFor hourly alone includes none`; `the instructions of each say never to send a password`; `a client answer of "password: abc" to an access item is refused by the existing answer check`; `the client record shows the client's answer beside the matching access row`; `the client's public page JSON contains no vault item name or owner note` (create a site access item with a vault name and note, read `/api/public/o/<token>`, assert both strings are absent).
- [ ] **Step 2: Run** `npx vitest run test/sites-onboarding-items.test.ts`. Expected: FAIL.
- [ ] **Step 3: Add the six templates** (labels like "Who hosts your website?"; instructions name the provider, ask whether the client can add Logan as a user, end with "Do not send any password."). Update the Plan 6 test's expectation for light onboardings to the six access items.
- [ ] **Step 4: Attach the answers** in `getClientRecord` (matching `access_<key>` on the client's onboarding for that business) and render them in the checklist as quoted text labelled "Client wrote (may be wrong)".
- [ ] **Step 5: Run** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(onboarding): ask the client where hosting, domain and profiles live`.

### Task 9: Flow test and open-items note

**Files:**
- Create: `test/clients-flow.test.ts`, `docs/superpowers/notes/2026-11-plan-9-open-items.md`

**Interfaces:**
- Consumes: the real entry points used by `test/billing-flow.test.ts` (signed Stripe webhook, owner `/api` routes, public `/o/` page, cron), fakes for Stripe, mail and the PDF browser.
- Produces: the note listing Logan-run checks and decisions.

- [ ] **Step 1: Write the flow test** telling one story: a signed Growth proposal with Care and the client-hosted surcharge is paid by webhook ⇒ onboarding and one `primary` site exist, tier `client_hosted`, six `needed` items (and the six client questions); the client answers two of them on the public page; `/api/clients` lists the client with the right Care label and MRR once the Care subscription is paid; at day 4 the Today row appears and names the missing items; Logan records `requested`, then `received` with a vault name and a note on four items and `not_applicable` on two ⇒ the row clears; `client_hosted_no_access` shows until `accessMethod` is set to `mainwp`; a password-looking vault name is refused and the stored row is unchanged; the public onboarding page, the welcome and Friday mails, the approvals and `get_lead` never contain the vault name or note; deleting the lead is refused with 409; archiving the site removes its flags.
- [ ] **Step 2: Run** `npx vitest run test/clients-flow.test.ts`. Expected: PASS (fix the code, not the test, if it finds a defect; record any in the note).
- [ ] **Step 3: Write the open-items note** in the shape of the Plan 8 note: what was built, **Needs Logan** (apply remote migration `0058_sites` before deploying; open `/clients` and a client page in a real browser at phone width; decide which of the six access items belong on a Care-only client), **Decisions for Logan** (the scope decisions above, plus the vault-name heuristic and the Task 8 cut line), **Known gaps** (anything the review parks).
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build`. Expected: all pass.
- [ ] **Step 5: Whole-branch review.** Dispatch one reviewer on Sonnet with the diff against `main`, the spec sections above and the Review Focus list; apply one fix wave; re-run step 4.
- [ ] **Step 6: Commit** `test(clients): end-to-end client and site flow; plan 9 open items`.

---

## Self-Review

- **Spec coverage:** §7 Site fields (Task 1 columns; monitoring status deliberately deferred and named); Organization/Contact (reused, not duplicated; Task 4 record); §6 layout and header strip (Task 6); §9.5 checklist and item-names-only (Tasks 1, 2, 4, 6) and the client-facing half (Task 8); §9.8 client-hosted flag (Task 2 `siteFlags`, shown in Task 6); §12 Phase 2 line (all). Gaps named in "Not in this plan".
- **Type consistency:** `AccessKey`, `AccessStatus`, `Site`, `AccessItem` are defined once in Task 1 and used unchanged in Tasks 2–8; `SiteFlag` from Task 2 is consumed by Tasks 4 and 6; `ClientRow`/`ClientRecord` from Task 4 by Tasks 6 and 8; `accessAttention` (Task 5) uses `unresolved` (Task 2).
- **Proportion:** the plan is a set of interfaces, test names and the decisions an implementer cannot make alone; no function bodies except the two heuristics that the tests alone would not pin.

## Execution notes

- Order is Task 1 → 2 → 3 → 4, then 5 and 6 (independent of each other), then 7, 8, 9. Tasks 1–4 are strictly sequential (each consumes the last).
- Plan 10 carry-forwards from here: MCP `get_client` and `get_site` reading `getClientRecord` (with the vault name omitted), the money dashboard reusing `clientMrrCents`, and Meetily matching meetings to clients through `people` and `sites.domain`.
