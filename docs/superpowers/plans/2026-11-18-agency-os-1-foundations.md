# Agency OS — Plan 1 of 5: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn site-search into the base of Agency OS. Remove job hunting, enforce a $150 total spend cap that includes fixed costs, add an approval inbox that every outbound action will go through, log every Claude action, add passkey sign-in, and expose a first MCP server that Claude can use to read records and propose approvals.

**Architecture:** Same Worker, D1 and React SPA. New pieces:
- Generic `approvals` records, with a handler registry keyed by `kind`. Approving claims the record atomically, then runs the kind's handler.
- An `agent_actions` log.
- A `fixed_costs` table that feeds a `spendStatus` function.
- WebAuthn passkeys stored in D1.
- A stateless MCP endpoint at `/mcp` behind a bearer token.

**Tech Stack:** TypeScript, Hono 4, zod 4, D1, React 19 + react-router 7, vitest 4 with `@cloudflare/vitest-pool-workers`, plus these new dependencies:
- `@simplewebauthn/server@^14.1.0` and `@simplewebauthn/browser@^14.0.0` (same versions as life-os)
- `@modelcontextprotocol/sdk@1.26.0` (same as life-os)
- `agents` (Cloudflare Agents SDK), for its Workers MCP handler

**Spec:** `/Users/loganirish/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md`. Task 1 copies it into this repo at `docs/superpowers/specs/2026-11-17-agency-os-design.md`. Sections this plan implements:
- §2 non-goal: remove job hunting
- §5 auth
- §9.13 approvals, action log, spend control, first MCP
- §12 Phase 1 "Today + approval inbox, basic MCP server (read, draft), spend tracker"

**Phase 1 roadmap.** This is plan 1. Each plan below ships working software on its own, and each starts from the merged result of the one before.
1. **Foundations** (this plan)
2. **Mail + sequences:** mail layer over SMTP/IMAP, outreach mailbox, sequence engine, reply sync, `email.send` approval kind, conflict gate, campaigns and niche test, per-service spend sub-caps (spec §9.13). Sub-caps wait for plan 2, when the scheduled Claude jobs they limit first exist.
3. **Video audits:** job queue for the Mac helper, the Mac helper (Qwen3-TTS, HyperFrames), annotation editor, script writer, landing page on hellositeline.com
4. **Sales:** booking page over the Google Calendar API, call prep, recommendation deck
5. **Close:** proposal/SOW templates, click-to-sign with audit trail, Stripe deposit invoice, deal → Won

## Global Constraints

- Work starts on branch `feat/agency-os-foundations`, cut from `main`. Do not build on `feat/google-places-listing-source`, `feat/job-watch` or `feat/job-watch-role-selector`. Job-watch is dropped (spec §2).
- New migrations are numbered from `0023` up, one number per file. Never rename or edit an existing migration: both `0022_*` files are already applied.
- Single user. Anything that reaches a prospect or client goes through an approval. Claude never sends directly (spec §2 anti-goals).
- Never store passwords, API keys or client logins in D1. Secrets live in Worker secrets (spec §2, §5).
- Total monthly cap is $150, covering both variable usage and fixed costs. Warn at 80%. At the cap, optional jobs pause, while approved and in-flight work continues (spec §9.13).
- No Webfor client names, content or pricing in seeds, fixtures or copy (spec §2).
- Follow the existing patterns:
  - zod validation that returns 400 with `fields`
  - `c.json({ error })` for errors
  - DB helpers in `src/worker/db/*.ts`
  - pure view helpers in `src/client/*View.ts`, tested in `test/*-view.test.ts`
- Run commands from `~/Project Sites/site-search`. Test: `npm test`. Types: `npm run typecheck`.

## Review Focus

1. **Double approve.** Two tabs, a double-click or a batch that overlaps a single approve must run the handler exactly once. Covered by Task 4: `approve twice runs handler once`.
2. **Handler failure.** When the handler throws (SMTP down, Stripe error), the approval goes back to `pending` with the error text. It is never marked approved. Covered by Task 4: `failed handler leaves approval pending with error`.
3. **Legacy job-hunting rows.** Drafts still saved with `purpose = 'full_time'` before the cleanup must not crash the Outreach page or the drafts API. They are treated as `freelance` until deleted. Covered by Task 2: `legacy full_time draft still lists`.
4. **Cap reached mid-month.** The radar cron skips with a logged reason when capped. User-started work still gets the existing `checkSpend` 402-style response. Disabled fixed costs (Workspace before the first client) do not count. Covered by Task 3: `capped month skips optional radar run` and `inactive fixed cost not counted`.
5. **MCP auth and reach.** A missing or wrong bearer token returns 401. MCP can only *propose* approvals for registered kinds, and can never execute one. Covered by Task 8: `mcp rejects bad token`, `propose with unknown kind fails`, `mcp cannot approve`.

---

### Task 1: Branch, spec in repo, migration-number guard

**Files:**
- Create: `docs/superpowers/specs/2026-11-17-agency-os-design.md` (copy of the spec)
- Create: `test/migrations.test.ts`

**Interfaces:**
- Produces: the rule that migration numbers ≥ 0023 are unique, enforced by a test.

- [ ] **Step 1: Branch from main without disturbing current work**

The working tree has an uncommitted `src/client/ui.css` change on `feat/google-places-listing-source`. Use a worktree so it stays untouched:
```bash
git worktree add ../site-search-agency-os -b feat/agency-os-foundations main
cd ../site-search-agency-os && npm ci
```
Expected: new directory on branch `feat/agency-os-foundations`.

- [ ] **Step 2: Baseline is green**

Run: `npm test && npm run typecheck`
Expected: all tests pass. If anything fails on `main`, stop and report it before changing code.

- [ ] **Step 3: Copy the spec into the repo**

```bash
mkdir -p docs/superpowers/specs && cp "/Users/loganirish/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md" docs/superpowers/specs/
```

- [ ] **Step 4: Write the failing-if-violated guard test** `test/migrations.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
describe("migrations", () => {
  it("numbers from 0023 on are unique", () => {
    const nums = env.TEST_MIGRATIONS.map((m) => m.name.slice(0, 4)).filter((n) => Number(n) >= 23);
    expect(new Set(nums).size).toBe(nums.length);
  });
});
```

- [ ] **Step 5: Run it**

Run: `npx vitest run test/migrations.test.ts`
Expected: PASS (no migrations ≥ 0023 yet).

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs test/migrations.test.ts
git commit -m "chore: add Agency OS spec and migration-number guard"
```

---

### Task 2: Remove job hunting

**Files** (every `full_time` reference found on `main`):
- Modify (worker):
  - `src/worker/types.ts:147-148`: `Purpose` becomes `"freelance"`; `PURPOSES = ["freelance"]`
  - `src/worker/drafter/prompt.ts:176`: always `buildFreelancePrompt`; delete `buildFullTimePrompt`
  - `src/worker/pipeline/lead.ts:83-104`: purpose is always `"freelance"`; remove the work-sample selection for full-time; footer uses `settings.footer_freelance ?? 1`
  - `src/worker/routes/leads.ts:374`: `purpose: z.literal("freelance").optional()`
  - `src/worker/routes/outreach.ts:35-39`: drop the `full_time` count and the purpose filter values other than `freelance`
  - `src/worker/routes/settings.ts:36-37`: drop `default_purpose` and `footer_full_time` from the schema
  - `src/worker/db/settings.ts:7`: drop `footer_full_time` from the editable key list
- Modify (client):
  - `src/client/emailView.ts`: `Purpose = "freelance"`; remove `profileGaps`, `purposeSwitchNotice`, the `swap_samples` tweak and the full-time entries in `PURPOSE_LABEL`/`PURPOSE_HINT`
  - `src/client/components/EmailComposer.tsx`: remove the purpose segment control and work-sample picker
  - `src/client/components/Shell.tsx:102-104`: remove the "Purpose" sidebar group
  - `src/client/pages/Outreach.tsx`, `src/client/pages/settings/Footer.tsx`, `src/client/types.ts`
- Delete: `src/client/pages/settings/JobSearch.tsx`, its route in `src/client/App.tsx`, and its settings-home entry. The Work Samples page stays (agency portfolio later); change its intro copy to "Add your best two or three projects. Agency emails can link to what is listed here."
- Modify tests: `test/draft-compose.test.ts`, `test/drafter.test.ts`, `test/email-render.test.ts`, `test/email-view.test.ts`, `test/outreach.test.ts`, `test/settings-pages.test.ts`. Delete full-time cases and keep the freelance ones.
- Migration: none. The old columns stay unused (YAGNI). Leave the `full_time` value in old rows to the ops step below.

**Interfaces:**
- Produces: `Purpose = "freelance"` (worker and client). Plan 2 replaces purpose with campaigns.

- [ ] **Step 1: Add the legacy-row test** in `test/outreach.test.ts`

`legacy full_time draft still lists`: insert a business and a draft row with `purpose = 'full_time'` directly via `env.DB`, then `GET /api/outreach?view=drafts` with a session cookie. Assert status 200 and that the draft appears with `purpose === "freelance"`.

- [ ] **Step 2: Run it**

Run: `npx vitest run test/outreach.test.ts`
Expected: FAIL on the `purpose` assertion (it comes back as `full_time`).

- [ ] **Step 3: Make the code changes listed above**

Where draft rows are read, map any stored purpose to `"freelance"` (one function in `src/worker/db/drafts.ts`: `normalizePurpose(_: string): Purpose`).

- [ ] **Step 4: Prove nothing references the removed feature**

Run: `git grep -n "full_time\|fullTime\|JobSearch\|job-search" -- src test`
Expected: only `normalizePurpose` and its test.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat!: remove job-hunting features (Agency OS is agency-only)"
```

- [ ] **Step 7 (ops, needs Logan's explicit OK; never automatic): export and delete job-target data in production**

Show Logan the count first:
```bash
npx wrangler d1 execute site-search --remote --command "SELECT COUNT(*) AS drafts, COUNT(DISTINCT business_id) AS leads FROM drafts WHERE purpose='full_time'"
```
After Logan confirms, export first:
```bash
npx wrangler d1 execute site-search --remote --json --command "SELECT b.*, d.subject, d.body, d.created_at AS drafted_at FROM drafts d JOIN businesses b ON b.id = d.business_id WHERE d.purpose='full_time'" > ~/Documents/site-search-job-leads-export.json
```
Then, only after Logan confirms again, delete:
```bash
npx wrangler d1 execute site-search --remote --command "DELETE FROM drafts WHERE purpose='full_time'"
```
Businesses are deleted only if Logan names them as job targets with no agency value. Confirm each batch with him.

---

### Task 3: Spend cap with fixed costs

**Files:**
- Create: `migrations/0023_fixed_costs.sql`
- Create: `src/worker/db/fixedCosts.ts`, `src/worker/spend.ts`, `src/worker/routes/spend.ts`
- Modify: `src/worker/cost.ts:23-28` (`checkSpend` delegates to `spendStatus`), `src/worker/radar-run.ts` (gate), `src/worker/index.ts` (mount `/api/spend`), `src/worker/db/usage.ts:1` (add `"claude_agent"` to `Service`)
- Test: `test/spend.test.ts`

**Interfaces:**
- Produces:
  - `type SpendLevel = "ok" | "warn" | "capped"`
  - `spendStatus(db: D1Database, now: Date, extraUsd?: number): Promise<{ month: string; variableUsd: number; fixedUsd: number; spentUsd: number; limitUsd: number; level: SpendLevel; ok: boolean }>`
  - `allowOptionalJob(db: D1Database, now: Date): Promise<boolean>`
  - `listFixedCosts(db): Promise<FixedCost[]>`
  - `setFixedCostActive(db, id: string, active: boolean): Promise<void>`
  - `FixedCost = { id: string; name: string; monthly_usd: number; active: 0 | 1 }`
- Consumes: `monthUsage` and `getSettings` (existing).

Migration `0023_fixed_costs.sql`:
```sql
CREATE TABLE fixed_costs (id TEXT PRIMARY KEY, name TEXT NOT NULL, monthly_usd REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
INSERT INTO fixed_costs VALUES
 ('cf-workers-paid','Cloudflare Workers Paid',5,1,datetime('now')),
 ('domains','Domains (sitelineweb.com, hellositeline.com)',2,1,datetime('now')),
 ('google-workspace','Google Workspace (2 seats, from first deposit)',14,0,datetime('now')),
 ('elevenlabs','ElevenLabs Creator (only if local voice fails)',22,0,datetime('now'));
UPDATE settings SET monthly_spend_limit_usd = 150 WHERE monthly_spend_limit_usd = 25;
```

Rules: `spentUsd = variableUsd + fixedUsd(active only)`. `level = "capped"` when `spentUsd + extra > limit`, `"warn"` when `spentUsd >= 0.8 * limit`, else `"ok"`. `ok = level !== "capped"`.

- [ ] **Step 1: Write the failing tests** in `test/spend.test.ts`
  - `inactive fixed cost not counted`: with no usage, `spendStatus(db, now)` returns `fixedUsd === 7` and `limitUsd === 150`.
  - `warn at 80 percent`: record usage of $113 (113 + 7 = 120 = 80%). Expect `level "warn"`, `ok true`.
  - `capped month skips optional radar run`: record $144 of usage. Then `allowOptionalJob(db, now)` returns `false`, and `runDueRadars` with a due radar returns a summary whose `skipped` is `"spend_cap"` and does not start a workflow (spy on `startWorkflow`).
  - `extra pushes over cap`: record $140, then `spendStatus(db, now, 5)` gives `level "capped"`, `ok false`.
  - `GET /api/spend` (authed) returns the status plus `fixedCosts` (4 rows). `PATCH /api/spend/fixed-costs/google-workspace {active:true}` gives 200, and the next status has `fixedUsd === 21`.

- [ ] **Step 2: Run them**

Run: `npx vitest run test/spend.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

Implement the migration, `db/fixedCosts.ts`, `spend.ts`, `routes/spend.ts` (zod `{active: z.boolean()}`; 404 for an unknown id), and the `checkSpend` delegation. `checkSpend` keeps returning `{ ok, spent, limit }` so existing callers in `routes/cro.ts`, `routes/leads.ts`, `routes/searches.ts` and `routes/radar.ts` are untouched. In `runDueRadars`, call `allowOptionalJob` first; when it's false, return early with `skipped: "spend_cap"` and `console.log` the reason.

- [ ] **Step 4: Run tests, typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. The existing `test/spend-limit.test.ts` still passes. If it asserted the $25 default, update it to $150.

- [ ] **Step 5: Commit**

```bash
git add migrations/0023_fixed_costs.sql src/worker test
git commit -m "feat(spend): $150 total cap including fixed costs, warn at 80%, pause optional jobs"
```

---

### Task 4: Approvals core

**Files:**
- Create: `migrations/0024_approvals.sql`
- Create: `src/worker/db/approvals.ts`, `src/worker/approvals/registry.ts`, `src/worker/approvals/decide.ts`, `src/worker/approvals/leadNote.ts`, `src/worker/routes/approvals.ts`
- Modify: `src/worker/index.ts` (mount `/api/approvals`; import `./approvals/leadNote` once so it self-registers)
- Test: `test/approvals.test.ts`

**Interfaces:**
- Produces:
  - `type ApprovalStatus = "pending" | "approved" | "rejected"`
  - `type Drafter = "job" | "mcp" | "logan"`
  - `interface Approval { id: string; kind: string; title: string; preview: string; payload: unknown; record_type: string | null; record_id: string | null; drafted_by: Drafter; status: ApprovalStatus; error: string | null; decision_note: string | null; created_at: string; decided_at: string | null }`
  - `createApproval(db, a: { kind: string; title: string; preview: string; payload: unknown; record_type?: string; record_id?: string; drafted_by: Drafter }): Promise<Approval>`. Throws `UnknownKindError` if the kind isn't registered.
  - `listApprovals(db, o: { status?: ApprovalStatus; limit?: number }): Promise<Approval[]>`, newest first, default `pending`, default limit 100.
  - `interface ApprovalHandler<P> { kind: string; label: string; parse(payload: unknown): P; execute(env: Env, payload: P, a: Approval): Promise<void> }`
  - `registerHandler(h: ApprovalHandler<any>): void`, `getHandler(kind: string): ApprovalHandler<any> | undefined`, `registeredKinds(): string[]`
  - `approve(env: Env, id: string, edited?: unknown): Promise<{ ok: true } | { ok: false; error: string; status: 404 | 409 | 422 | 502 }>`
  - `reject(db, id: string, note?: string): Promise<boolean>`
  - Built-in kind `"lead.note"` with payload `{ businessId: string; text: string }` (1–2000 chars). It writes a note through the same DB call the existing lead-notes route uses (see `test/lead-notes.test.ts` for the path).
- Plan 2 will register `"email.send"`. Plan 5 will register `"document.send"`.

Migration `0024_approvals.sql`:
```sql
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, preview TEXT NOT NULL, payload TEXT NOT NULL,
  record_type TEXT, record_id TEXT, drafted_by TEXT NOT NULL CHECK (drafted_by IN ('job','mcp','logan')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  error TEXT, decision_note TEXT, created_at TEXT NOT NULL, decided_at TEXT);
CREATE INDEX idx_approvals_status ON approvals(status, created_at);
CREATE INDEX idx_approvals_record ON approvals(record_type, record_id);
```

How `approve` must work (this is the double-approve guard; the order matters):
1. Claim the approval: `UPDATE approvals SET status='approved', decided_at=? , error=NULL WHERE id=? AND status='pending' RETURNING *`. No row means 404 if the id is unknown, otherwise 409.
2. `parse(edited ?? payload)`. If that throws, restore the row: `UPDATE ... SET status='pending', decided_at=NULL, error=?`. Return 422.
3. If `edited` was given, store it in `payload`.
4. Run `execute`. If it throws, restore the row as in step 2 and return 502.

Routes:
- `GET /api/approvals?status=` returns `{ items, counts: Record<kind, number> }`, where `counts` covers pending items only. Each item also carries `label` from its handler.
- `POST /api/approvals/:id/approve` takes `{ payload?: unknown }` and maps the `approve` result to an HTTP status.
- `POST /api/approvals/:id/reject` takes `{ note?: string ≤ 500 }`.
- `POST /api/approvals/approve-batch` takes `{ ids: string[] (1–50) }` and returns `{ results: { id, ok, error? }[] }`. The ids run one at a time.

- [ ] **Step 1: Write the failing tests** in `test/approvals.test.ts`. Register a test-only handler with kind `test.ok` (counts calls) and `test.fail` (throws `"smtp down"`).
  - `create then list pending` returns counts `{ "test.ok": 1 }`.
  - `approve twice runs handler once`: `Promise.all([approve(id), approve(id)])` gives one `ok: true`, one 409, and a handler call count of 1.
  - `failed handler leaves approval pending with error`: `test.fail` gives 502, and the row has `status = 'pending'` and `error = 'smtp down'`.
  - `edited payload is validated and stored`: an invalid edit gives 422 and the row stays pending. A valid edit is executed with the edited payload, and the stored payload equals the edit.
  - `reject records note`.
  - `unknown kind cannot be created`: `createApproval` with kind `nope` throws `UnknownKindError`.
  - `lead.note executes`: approving creates a note visible at `GET /api/leads/:id` (or whatever the existing notes read path is).
  - `batch approve reports per id`.
  - `routes require auth` gives 401 without a cookie.

- [ ] **Step 2: Run them** — Run: `npx vitest run test/approvals.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** the migration, the DB helpers, the registry, `decide.ts`, `leadNote.ts` and the routes, per the interfaces above.

- [ ] **Step 4: Run all tests, typecheck** — Run: `npm test && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/0024_approvals.sql src/worker test/approvals.test.ts
git commit -m "feat(approvals): approval inbox core with atomic claim and handler registry"
```

---

### Task 5: Agent action log

**Files:**
- Create: `migrations/0025_agent_actions.sql`, `src/worker/db/agentActions.ts`, `src/worker/routes/agentActions.ts`
- Modify: `src/worker/index.ts` (mount `/api/agent-actions`)
- Test: `test/agent-actions.test.ts`

**Interfaces:**
- Produces:
  - `logAgentAction(db, a: { actor: "mcp" | "job"; tool: string; summary: string; record_type?: string; record_id?: string; cost_usd?: number }): Promise<void>`. When `cost_usd > 0`, it also calls `recordUsage(db, "claude_agent", 1, cost_usd)`.
  - `listAgentActions(db, o: { record_type?: string; record_id?: string; limit?: number }): Promise<AgentAction[]>`, newest first, default limit 50.
  - `GET /api/agent-actions?record_type=&record_id=&limit=`

```sql
CREATE TABLE agent_actions (id TEXT PRIMARY KEY, actor TEXT NOT NULL CHECK (actor IN ('mcp','job')), tool TEXT NOT NULL,
  summary TEXT NOT NULL, record_type TEXT, record_id TEXT, cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX idx_agent_actions_record ON agent_actions(record_type, record_id, created_at);
```

- [ ] **Step 1: Write the failing tests**
  - `logs and lists by record`: two actions on lead A and one on lead B. Filtering by A returns 2, newest first.
  - `cost feeds spend`: logging with `cost_usd: 0.5` makes `spendStatus().variableUsd` rise by 0.5.
  - `summary is truncated to 500 chars`.

- [ ] **Step 2: Run** — Run: `npx vitest run test/agent-actions.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run all** — Run: `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add migrations/0025_agent_actions.sql src/worker test/agent-actions.test.ts
git commit -m "feat: log every Claude action with cost"
```

---

### Task 6: Today shows the approval inbox and spend level

**Files:**
- Create: `src/client/approvalsView.ts`, `src/client/components/home/ApprovalsCard.tsx`
- Modify: `src/client/components/home/useHome.ts` (also load `/approvals` and `/spend`), `src/client/pages/Today.tsx` (render `ApprovalsCard` first in `hm-cols`), `src/client/components/home/SpendCard.tsx` (show level and fixed costs), `src/client/home.css`
- Test: `test/approvals-view.test.ts`

**Interfaces:**
- Consumes: `GET /api/approvals`, `POST /api/approvals/:id/approve|reject`, `POST /api/approvals/approve-batch`, `GET /api/spend` (Tasks 3–4).
- Produces (pure, in `approvalsView.ts`):
  - `groupApprovals(items: ApprovalItem[]): { kind: string; label: string; items: ApprovalItem[] }[]`, with groups ordered by oldest item first
  - `approvalsLine(n: number): string`. Exact copy: `0` → `"Nothing waiting for you."`, `1` → `"1 thing waiting for your OK."`, `n` → `` `${n} things waiting for your OK.` ``
  - `spendLine(s: { spentUsd: number; limitUsd: number; level: SpendLevel }): string`. Exact copy:
    - `ok` → `` `$${spent} of $${limit} this month` ``
    - `warn` → `` `$${spent} of $${limit} — over 80%, optional jobs pause at the cap` ``
    - `capped` → `` `$${spent} of $${limit} — cap reached, optional jobs paused` ``
    - Dollars are rounded to whole numbers.

UI behavior:
- Each group lists its items with title, a short preview, who drafted it, and the time.
- Each item has Approve, Edit-then-approve and Reject (with an optional note).
- Each group has "Approve all N", which calls approve-batch.
- An item that returns an error shows it inline and stays in the list.
- Approved and rejected items leave the list without reloading the page.
- Buttons are keyboard reachable, and errors are announced in an `aria-live="polite"` region.

- [ ] **Step 1: Write the failing tests** for `groupApprovals`, `approvalsLine` (0/1/3) and `spendLine` (each level, with exact strings).
- [ ] **Step 2: Run** — Run: `npx vitest run test/approvals-view.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `approvalsView.ts`, then `ApprovalsCard.tsx` and the wiring.
- [ ] **Step 4: Run all + build** — Run: `npm test && npm run typecheck && npm run build` — Expected: PASS.
- [ ] **Step 5: Check it in the browser**

Run `npm run dev`, sign in, and create a `lead.note` approval through the API. Then confirm:
- it appears on Today
- Approve removes it
- the note shows on the lead
- the spend line reads `$7 of $150 this month` on an empty local DB

- [ ] **Step 6: Commit**

```bash
git add src/client test/approvals-view.test.ts
git commit -m "feat(today): approval inbox and spend level on Today"
```

---

### Task 7: Passkey sign-in

**Files:**
- Create: `migrations/0026_passkeys.sql`, `src/worker/passkeys.ts`, `src/worker/routes/passkeys.ts`, `src/client/pages/settings/Security.tsx`
- Modify:
  - `src/worker/auth.ts:31` (add `/api/passkey/login/options` and `/api/passkey/login/verify` to `PUBLIC`)
  - `src/worker/index.ts` (mount `/api/passkey`)
  - `src/worker/env.ts` (add `WEBAUTHN_RP_ID: string; WEBAUTHN_ORIGIN: string`)
  - `wrangler.jsonc` (`vars`)
  - `vitest.config.ts` (bindings `WEBAUTHN_RP_ID: "x"`, `WEBAUTHN_ORIGIN: "https://x"`)
  - `src/client/pages/Login.tsx` (a "Sign in with passkey" button above the password form)
  - `src/client/App.tsx` (route `/settings/security`)
  - the settings home list
  - `package.json` (`@simplewebauthn/server@^14.1.0`, `@simplewebauthn/browser@^14.0.0`)
- Test: `test/passkeys.test.ts`

**Interfaces:**
- Produces:
  - `createChallenge(db, purpose: "register" | "login", now: Date): Promise<string>`, valid for 5 minutes
  - `consumeChallenge(db, challenge: string, purpose, now: Date): Promise<boolean>`, single use
  - Routes:
    - `POST /api/passkey/register/options` (authed)
    - `POST /api/passkey/register/verify` (authed; body `{ response, nickname? }`)
    - `POST /api/passkey/login/options` (public)
    - `POST /api/passkey/login/verify` (public; on success sets the same `session` cookie as `routes/auth.ts`)
    - `GET /api/passkey` (authed list)
    - `DELETE /api/passkey/:id` (authed)
  - Routes take a `verify` dependency (defaults to `@simplewebauthn/server`'s `verifyRegistrationResponse` / `verifyAuthenticationResponse`), so tests can inject a stub.
- Values:
  - `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` = the app's own host. Until the app moves to its custom domain, that's the current `*.workers.dev` host. **[call]** The app moves to `app.sitelineweb.com` once Logan buys the domain. Passkeys are tied to the host, so he re-registers once after the move.
  - Password login stays as the fallback (spec §5).

```sql
CREATE TABLE passkeys (id TEXT PRIMARY KEY, credential_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
  transports TEXT, nickname TEXT, created_at TEXT NOT NULL, last_used_at TEXT);
CREATE TABLE auth_challenges (challenge TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK (purpose IN ('register','login')), expires_at TEXT NOT NULL);
```

- [ ] **Step 1: Write the failing tests** in `test/passkeys.test.ts`
  - `login options are public and store a challenge`.
  - `register options need a session` gives 401 without a cookie.
  - `expired or reused challenge is rejected`: consume twice returns true then false; consume after 6 minutes returns false.
  - `login verify with stubbed verifier sets session cookie and bumps counter`.
  - `counter regression rejected`: the stub reports `newCounter` ≤ the stored counter, giving 401.
  - `password login still works` (one assertion re-using the auth test flow).

- [ ] **Step 2: Run** — Run: `npx vitest run test/passkeys.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the worker side, then the client (`@simplewebauthn/browser` `startRegistration` / `startAuthentication`).
- [ ] **Step 4: Run all + build** — Run: `npm test && npm run typecheck && npm run build` — Expected: PASS.
- [ ] **Step 5: Real-device check**

On `npm run dev`, with `WEBAUTHN_RP_ID=localhost` and `WEBAUTHN_ORIGIN=http://localhost:5173`, register a passkey with Touch ID in Settings → Security, sign out, and sign in with it.

- [ ] **Step 6: Commit**

```bash
git add migrations/0026_passkeys.sql src test package.json package-lock.json wrangler.jsonc vitest.config.ts
git commit -m "feat(auth): passkey sign-in with password fallback"
```

---

### Task 8: First MCP server (read + propose)

**Files:**
- Create: `src/worker/mcp/server.ts`, `src/worker/mcp/route.ts`
- Modify:
  - `src/worker/index.ts` (handle `/mcp` before the SPA and outside `/api/*`, so the cookie auth middleware does not apply)
  - `src/worker/env.ts` (`MCP_TOKEN: string`)
  - `vitest.config.ts` (binding `MCP_TOKEN: "test-mcp-token"`)
  - `package.json` (`@modelcontextprotocol/sdk@1.26.0`, `agents`)
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes:
  - `listApprovals`, `createApproval`, `registeredKinds` (Task 4)
  - `logAgentAction` (Task 5)
  - existing `getBusiness`, `latestAudit`, and the AllLeads list query in `src/worker/db/businesses.ts`
- Produces: `buildMcpServer(env: Env): McpServer` with exactly these tools (zod input schemas). Every call logs `logAgentAction({ actor: "mcp", tool, summary })`.
  - `search_leads({ query?: string; lead_status?: string; limit?: number ≤ 50 })` returns `{ id, name, website, lead_status, health_score }[]`
  - `get_lead({ id })` returns the business, the latest audit summary (scores and top findings), and the last 20 activity items
  - `list_approvals({ status?: "pending" | "approved" | "rejected" })`
  - `propose_approval({ kind, title, preview, payload, record_type?, record_id? })` calls `createApproval` with `drafted_by: "mcp"`. An unknown kind returns an MCP tool error listing `registeredKinds()`.
  - There is **no** approve/reject/execute tool.
- Auth: header `Authorization: Bearer <MCP_TOKEN>`, compared in constant time (reuse the XOR loop pattern in `src/worker/auth.ts:20-23`). Missing or wrong gives 401 before any MCP handling.
- Transport: stateless Streamable HTTP. Use `createMcpHandler` from `agents/mcp` with the `McpServer` instance. Before writing the route, confirm the export exists in the installed `agents` version (`grep -r "createMcpHandler" node_modules/agents/dist/*.d.ts`). If it's absent, use `@modelcontextprotocol/sdk`'s Streamable HTTP server transport with `sessionIdGenerator: undefined`, driven from the Worker's `Request`.

- [ ] **Step 1: Write the failing tests** in `test/mcp.test.ts`, which post JSON-RPC to `https://x/mcp` via `SELF.fetch`, with `accept: application/json, text/event-stream`:
  - `mcp rejects bad token`: no header gives 401, and a wrong token gives 401.
  - `lists exactly the four tools`.
  - `search_leads finds seeded lead`: seed one business via `upsertBusiness`.
  - `propose with unknown kind fails` returns an error result whose text mentions `lead.note`.
  - `propose lead.note creates pending approval and logs action`.
  - `mcp cannot approve`: `tools/call` with name `approve` returns an unknown-tool error, and the approval stays `pending`.

- [ ] **Step 2: Run** — Run: `npx vitest run test/mcp.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run all + build** — Run: `npm test && npm run typecheck && npm run build` — Expected: PASS.

- [ ] **Step 5: Connect a real client**

Generate a token and set it locally in `.dev.vars` as `MCP_TOKEN=...`, then run `npm run dev`. Add the server to Claude Code:
```bash
claude mcp add --transport http agency-os http://localhost:8787/mcp --header "Authorization: Bearer $TOKEN"
```
Then ask Claude to "find my most promising lead and propose a note on it". Expected: a pending `lead.note` approval appears on Today, and an `mcp` row appears in agent actions.

- [ ] **Step 6: Commit**

```bash
git add src/worker/mcp src/worker/index.ts src/worker/env.ts test/mcp.test.ts package.json package-lock.json vitest.config.ts
git commit -m "feat(mcp): read and propose-only MCP server behind bearer token"
```

---

### Task 9: Ship

- [ ] **Step 1: Full verification** — Run: `npm test && npm run typecheck && npm run build` — Expected: PASS.

- [ ] **Step 2: Secrets and remote migrations (Logan runs or OKs each)**

```bash
npx wrangler secret put MCP_TOKEN
npx wrangler d1 migrations apply site-search --remote
```
Expected: migrations 0023–0026 are applied.

- [ ] **Step 3: Open a PR**

Open a PR from `feat/agency-os-foundations` to `main` that links the spec. Deploy after merge with `npm run deploy`. On production, register a passkey and confirm Today shows `$7 of $150 this month`.

- [ ] **Step 4: Production cleanup**

Run Task 2 Step 7 (job-data export and delete), with Logan's explicit OK at each prompt.
