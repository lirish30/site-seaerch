# Agency OS — Plan 1 handoff (carry into Plan 2)

Plan 1 (Foundations) shipped on `feat/agency-os-foundations` (c1b9dba..3f2bb1b): job hunting removed, a $150 total cap that includes fixed costs, approvals core and inbox, agent action log, passkeys, and a propose-only MCP server. Every task passed its own review, and the whole branch passed a final review after one fix wave.

## Logan's manual checks (not automatable)
- [ ] Today page in the browser: create a `lead.note` approval, approve it, and confirm the note appears on the lead. On an empty database the spend line reads `$7 of $150 this month`.
- [ ] Settings → Security: register a passkey with Touch ID, sign out, then sign back in with it. This is the only test of the real WebAuthn verifier.
- [ ] Connect Claude Code to `/mcp` (see README "Agency OS setup") and ask it to propose a note on a lead. The note should appear on Today.
- [ ] Production, each step needing Logan's OK:
  - `npx wrangler secret put MCP_TOKEN`
  - `npx wrangler d1 migrations apply site-search --remote`
  - deploy
  - export and then delete the job-hunting drafts (plan Task 2 Step 7)

## Decision since Plan 1 shipped (2026-11-18)
- **Claude runs only through Logan's Claude subscription, never the paid API.** Plan 2 must add a Claude task queue with MCP tools such as `next_claude_task` and `complete_claude_task`. It must also move today's API callers onto that queue and then remove `ANTHROPIC_API_KEY`:
  - `src/worker/drafter/draft.ts` (`anthropicCaller`)
  - `src/worker/audit/review.ts`
  - `src/worker/cro/ai.ts` (`anthropicCroCaller`)
  - the wiring in `src/worker/workflows.ts`

  Until then, the existing audit, draft and CRO pipelines still bill the API.
- Job-watch was also removed when merging into main. Its tables and data remain until Logan approves deleting them.

## Plan 2 must (before any outbound approval kind such as `email.send`)
- The inbox must render the approval from its **payload** (recipient, subject, body), or the handler must build the preview. Preview and payload are independent today, so a prompt-injected agent could pair a harmless preview with a harmful payload.
- Validate the payload with the kind's `parse` at `createApproval` / `propose_approval` time, not only at approve time.
- Handlers must be idempotent, or record the send durably before any step that can throw (see the contract comment on `ApprovalHandler`).
- Sanitize or truncate handler error text before storing it in `approvals.error`. SMTP and Stripe errors can leak host or user details.
- Replace the raw-JSON "edit then approve" box with an editor specific to each kind.
- Add per-service spend sub-caps (spec §9.13) once scheduled Claude jobs exist.
- Consider an Origin check on `/mcp`, and limiting `list_approvals` payload exposure once payloads carry recipient data.

## Deferred minors worth folding into later work
- Today: focus is lost after a row is removed; `rejectOne` doesn't refresh counts; the `created_at` sort assumes a single timestamp format.
- `Usage.tsx` swallows `/spend` errors.
- `listAgentActions` doesn't clamp its limit when called directly.
- Agent-action insert and `recordUsage` aren't batched.
- MCP doesn't log auth or validation failures. Its lead search is bespoke SQL rather than the shared AllLeads query.
- Leftover settings from the job-hunting removal: the Footer chip copy, unused profile fields and the unused `matchSamples`.
- After the domain moves to app.sitelineweb.com, pin `WEBAUTHN_RP_ID` in production vars.
