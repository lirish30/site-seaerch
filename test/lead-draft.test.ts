import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { buildBundle } from "../src/worker/queue/bundle";
import { completeTask, getTask } from "../src/worker/queue/db";
import { getTaskKind } from "../src/worker/queue/registry";
import { LEAD_DRAFT_KIND, createManualDraft, draftTaskState, enqueueDraftFor, requestDraft } from "../src/worker/queue/leadDraft";
import { enqueueDraftIfWanted } from "../src/worker/queue/siteReview";
import { insertAudit, latestAudit } from "../src/worker/db/audits";
import { PLACEHOLDER_BODY, PLACEHOLDER_SUBJECT, draftedIds, isPlaceholderDraft, latestDraft, latestDraftsByBusiness, listDrafts, variantsOf } from "../src/worker/db/drafts";
import { DraftResult } from "../src/worker/drafter/draft";
import { buildSummary } from "../src/worker/todaySummary";
import { createCampaign } from "../src/worker/db/campaigns";
import { startSequence } from "../src/worker/sequence/engine";
import { saveSettings } from "../src/worker/db/settings";
import { addSuppression } from "../src/worker/db/suppression";
import { replaceContacts, listContacts } from "../src/worker/db/contacts";
import { createPerson } from "../src/worker/db/people";
import { getBusiness, listTodayCandidates } from "../src/worker/db/businesses";
import { seedBusiness, seedLeadAudit } from "./fixtures/cro";
import { claimById, three, writeDraft } from "./fixtures/draftTask";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

const tasks = async () => (await env.DB.prepare(`SELECT * FROM claude_tasks WHERE kind = ? ORDER BY created_at, id`).bind(LEAD_DRAFT_KIND).all<Record<string, any>>()).results;
const SIG = "Logan Irish\nIrish Web";
const ADDR = "123 Main St, Boise, ID 83702";
const OPT = "Reply 'no thanks' and I won't follow up.";

beforeEach(async () => {
  await env.DB.batch(["claude_tasks", "agent_actions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await saveSettings(env.DB, { signature: SIG, physical_address: ADDR, opt_out_line: OPT, footer_freelance: 1 });
});

async function lead() {
  const b = await seedBusiness();
  const audit = await seedLeadAudit(b.id);
  return { b, audit };
}
const email = (businessId: string, value: string, o: { person_name?: string | null; role?: string | null; confidence?: number } = {}) => ({
  business_id: businessId, type: "email" as const, value, source_url: "https://ace.com/contact", person_name: o.person_name ?? null, role: o.role ?? null, confidence: o.confidence ?? 0.7,
});

describe("lead.draft is a registered task kind", () => {
  it("is registered, suggests haiku, and takes the existing draft options", () => {
    const def = getTaskKind(LEAD_DRAFT_KIND)!;
    expect(def.suggestedModel).toBe("haiku");
    expect(def.payload.safeParse({ businessId: "b", auditId: "a", options: { steeringNote: "x", focus: [0], tone: "direct", croFocus: ["c"], tweak: "shorter" } }).success).toBe(true);
    expect(def.payload.safeParse({ businessId: "b", auditId: "a", options: { tweak: "louder" } }).success).toBe(false);
  });
});

describe("requestDraft", () => {
  it("request creates one task per lead", async () => {
    const { b, audit } = await lead();
    const other = await lead();
    const first = await requestDraft(env.DB, b.id, { steeringNote: "mention the van" });
    const second = await requestDraft(env.DB, b.id, { steeringNote: "something else" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ taskId: first.taskId, created: false });
    expect((await requestDraft(env.DB, other.b.id)).created).toBe(true);
    const rows = await tasks();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first.taskId)).toMatchObject({ status: "pending", dedupe_key: b.id, target_type: "lead", target_id: b.id });
    // a second click replaces nothing: the queued request keeps its own options
    expect(JSON.parse(rows.find((r) => r.id === first.taskId)!.payload)).toEqual({ businessId: b.id, auditId: audit.id, options: { steeringNote: "mention the van" } });
  });

  it("tweak without a draft throws", async () => {
    const { b } = await lead();
    await expect(requestDraft(env.DB, b.id, { tweak: "warmer" })).rejects.toThrow(/Write a draft first/);
    expect(await tasks()).toHaveLength(0);
  });

  it("a tweak on an unedited placeholder stub throws, and queues nothing", async () => {
    const { b } = await lead();
    await createManualDraft(env.DB, b.id);
    expect(isPlaceholderDraft((await latestDraft(env.DB, b.id))!)).toBe(true);
    await expect(requestDraft(env.DB, b.id, { tweak: "shorter" })).rejects.toThrow(/Write a draft first/);
    expect(await tasks()).toHaveLength(0);
    // a plain (non-tweak) request is still fine: it writes the first real draft
    expect((await requestDraft(env.DB, b.id)).created).toBe(true);
  });

  it("refuses a lead with no audit or no business", async () => {
    const b = await seedBusiness();
    await expect(requestDraft(env.DB, b.id)).rejects.toThrow(/business or audit missing/);
    await expect(requestDraft(env.DB, "nope")).rejects.toThrow(/business or audit missing/);
  });

  it("a tweak of an existing draft is queued", async () => {
    const { b } = await lead();
    await writeDraft(b.id);
    const r = await requestDraft(env.DB, b.id, { tweak: "shorter" });
    expect(r.created).toBe(true);
  });
});

describe("applying a finished draft", () => {
  it("apply inserts variants with the resolved recipient", async () => {
    const { b, audit } = await lead();
    await replaceContacts(env.DB, b.id, [email(b.id, "info@ace.com")]);
    const [c1] = await listContacts(env.DB, b.id);
    const { taskId } = await requestDraft(env.DB, b.id, { steeringNote: "n" });
    await claimById(taskId);
    // the model names an address that is not a contact: the ranking's pick is used instead
    const r = await completeTask(env, taskId, { variants: three().variants.map((v) => ({ ...v, subject: `  ${v.subject}  ` })), to_contact_id: "made-up", recipient_reason: "x" });
    expect(r).toEqual({ ok: true });
    const drafts = await listDrafts(env.DB, b.id);
    const group = await variantsOf(env.DB, drafts[0]);
    expect(group.map((d) => [d.variant_index, d.angle, d.subject, d.purpose, d.include_footer, d.steering_note, d.audit_id, d.offer])).toEqual([
      [0, "Angle 1", "Subject 1", "freelance", true, "n", audit.id, "seo_basics"], [1, "Angle 2", "Subject 2", "freelance", true, "n", audit.id, "seo_basics"],
      [2, "Angle 3", "Subject 3", "freelance", true, "n", audit.id, "seo_basics"]]);
    expect(group.every((d) => d.to_contact_id === c1.id && d.recipient_reason === "Best inbox found on https://ace.com/contact")).toBe(true);
    expect(new Set(group.map((d) => d.created_at)).size).toBe(1);
    expect(new Set(group.map((d) => d.variant_group))).toEqual(new Set([taskId]));
    expect((await getTask(env.DB, taskId))!.status).toBe("done");
  });

  it("the lead's point of contact wins and becomes a contact", async () => {
    const { b } = await lead();
    await createPerson(env.DB, b.id, { name: "Ann Lee", role: "Owner", email: "ann@ace.com", is_poc: true });
    const d = await writeDraft(b.id, {}, { ...three(), to_contact_id: null });
    const to = (await listContacts(env.DB, b.id)).find((c) => c.id === d.to_contact_id)!;
    expect(to.value).toBe("ann@ace.com");
    expect(d.recipient_reason).toBe("Your chosen point of contact");
  });

  it("new drafts take their footer default from the settings", async () => {
    const { b } = await lead();
    await saveSettings(env.DB, { footer_freelance: 0 });
    expect((await writeDraft(b.id)).include_footer).toBe(false);
    await saveSettings(env.DB, { footer_freelance: 1 });
    expect((await writeDraft(b.id)).include_footer).toBe(true);
  });

  it("a tweak writes one new draft, keeps the current draft's footer choice, and shows Claude the draft to revise", async () => {
    const { b } = await lead();
    const first = await writeDraft(b.id);
    await env.DB.prepare(`UPDATE drafts SET include_footer = 0 WHERE id = ?`).bind(first.id).run();
    const before = (await listDrafts(env.DB, b.id)).length;
    let shown = "";
    const d = await writeDraft(b.id, { tweak: "shorter" }, (s) => { shown = s; return { variants: [{ angle: "Shorter", subject: "Tight", body: "Short body" }], to_contact_id: null, recipient_reason: "r" }; });
    expect(shown).toContain("Subject: Subject 1");
    expect(shown).toContain("cut it by about a third");
    expect(shown).toMatch(/exactly 1 variant/);
    expect([d.subject, d.include_footer, d.variant_index]).toEqual(["Tight", false, 0]);
    expect((await listDrafts(env.DB, b.id)).length).toBe(before + 1);
  });

  it("applying the same result twice (a crash-retry) writes the variants once", async () => {
    const { b } = await lead();
    const { taskId } = await requestDraft(env.DB, b.id);
    const task = await claimById(taskId);
    const def = getTaskKind(LEAD_DRAFT_KIND)!;
    await def.apply(env, task.payload, three(), task);
    await def.apply(env, task.payload, three(), task);
    expect(await listDrafts(env.DB, b.id)).toHaveLength(3);
  });

  it("body is stripped of a trailing signature, address and opt-out line", async () => {
    const { b } = await lead();
    const body = `Hi Ace team,\n\nYour site takes about 8 seconds to load.\n\n${SIG}\n${ADDR}\n${OPT}`;
    const d = await writeDraft(b.id, {}, { variants: [{ angle: "A", subject: "s", body }], to_contact_id: null, recipient_reason: "r" });
    expect(d.body).toBe("Hi Ace team,\n\nYour site takes about 8 seconds to load.");
  });

  it("malformed variants are rejected with issues", async () => {
    const { b } = await lead();
    const { taskId } = await requestDraft(env.DB, b.id);
    await claimById(taskId);
    for (const bad of [{ nope: true }, { variants: [], to_contact_id: null, recipient_reason: "r" },
      { variants: [1, 2, 3, 4].map((n) => ({ angle: "", subject: `s${n}`, body: "b" })), to_contact_id: null, recipient_reason: "r" },
      { variants: [{ angle: "", subject: "two\nlines", body: "b" }], to_contact_id: null, recipient_reason: "r" }]) {
      const r = await completeTask(env, taskId, bad);
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining("invalid result") });
    }
    expect(await completeTask(env, taskId, { variants: [], to_contact_id: null, recipient_reason: "r" })).toMatchObject({ error: expect.stringMatching(/variants/) });
    expect((await getTask(env.DB, taskId))!.status).toBe("claimed");
    expect(await listDrafts(env.DB, b.id)).toHaveLength(0);
  });

  it("one flat email is still one usable variant", async () => {
    const { b } = await lead();
    const d = await writeDraft(b.id, {}, { subject: "Flat", body: "Hello", to_contact_id: null, recipient_reason: "x" });
    expect([d.subject, d.body]).toEqual(["Flat", "Hello"]);
    expect(await listDrafts(env.DB, b.id)).toHaveLength(1);
  });

  it("logs a draft entry on the lead's activity", async () => {
    const { b } = await lead();
    await writeDraft(b.id);
    await writeDraft(b.id, { tweak: "warmer" }, three());
    const rows = (await env.DB.prepare(`SELECT detail FROM activity WHERE business_id = ? AND kind = 'draft' ORDER BY id`).bind(b.id).all<{ detail: string }>()).results.map((r) => r.detail);
    expect(rows.sort()).toEqual(["Rewrote the draft (warmer)", "Wrote the draft"]);
  });
});

describe("a draft that no longer makes sense", () => {
  it("lead suppressed after enqueue gets no draft and the task is stale", async () => {
    const { b } = await lead();
    const { taskId } = await requestDraft(env.DB, b.id);
    const task = await claimById(taskId);
    await addSuppression(env.DB, { kind: "place_id", value: (await getBusiness(env.DB, b.id))!.place_id!, reason: "opt_out" });
    expect(await buildBundle(env, task)).toEqual({ stale: "lead suppressed" });
    expect(await completeTask(env, taskId, three())).toEqual({ ok: true });
    expect((await getTask(env.DB, taskId))).toMatchObject({ status: "stale", error: "lead suppressed" });
    expect(await listDrafts(env.DB, b.id)).toHaveLength(0);
  });

  it("newer audit makes the task stale", async () => {
    const { b, audit } = await lead();
    const { taskId } = await requestDraft(env.DB, b.id);
    const task = await claimById(taskId);
    await new Promise((r) => setTimeout(r, 5)); // audits are ordered by their creation time
    const next = await seedLeadAudit(b.id);
    expect((await latestAudit(env.DB, b.id))!.id).toBe(next.id);
    expect(await buildBundle(env, task)).toMatchObject({ stale: expect.stringMatching(/newer audit/) });
    expect(await completeTask(env, taskId, three())).toEqual({ ok: true });
    expect((await getTask(env.DB, taskId))!.status).toBe("stale");
    expect(await listDrafts(env.DB, b.id)).toHaveLength(0);
    expect((await getTask(env.DB, taskId))!.payload).toMatchObject({ auditId: audit.id });
  });

  it("a deleted lead is stale", async () => {
    const { b } = await lead();
    const { taskId } = await requestDraft(env.DB, b.id);
    await claimById(taskId);
    await env.DB.prepare(`DELETE FROM businesses WHERE id = ?`).bind(b.id).run();
    expect(await completeTask(env, taskId, three())).toEqual({ ok: true });
    expect((await getTask(env.DB, taskId))!.status).toBe("stale");
  });

  it("a new audit's draft is not blocked by an older audit's open request", async () => {
    const { b, audit } = await lead();
    const old = await requestDraft(env.DB, b.id);
    await new Promise((r) => setTimeout(r, 5));
    const next = await seedLeadAudit(b.id);
    expect(await enqueueDraftFor(env.DB, { businessId: b.id, auditId: next.id })).toEqual({ created: true });
    expect((await getTask(env.DB, old.taskId))).toMatchObject({ status: "stale", payload: { auditId: audit.id } });
    const open = (await tasks()).filter((t) => t.status === "pending");
    expect(open.map((t) => JSON.parse(t.payload).auditId)).toEqual([next.id]);
  });
});

describe("what Claude is shown", () => {
  it("bundle's untrusted block holds site text only", async () => {
    const b = await seedBusiness({ name: "Zed Plumbing Co" });
    const audit = await seedLeadAudit(b.id);
    await replaceContacts(env.DB, b.id, [email(b.id, "zed-owner@zedplumbing.test", { person_name: "Zed Zane", role: "Owner" })]);
    const first = await writeDraft(b.id);
    const { taskId } = await requestDraft(env.DB, b.id, { steeringNote: "mention the red van", tweak: "warmer" });
    const bundle = await buildBundle(env, await claimById(taskId));
    if ("stale" in bundle) throw new Error(bundle.stale);
    const [trusted, untrusted] = bundle.text.split("## Untrusted content");
    // scraped: the business, the findings, the contacts, and the draft being revised
    for (const s of ["Zed Plumbing Co", "Not secure", "zed-owner@zedplumbing.test", "Zed Zane", first.body]) {
      expect(untrusted, s).toContain(s);
      expect(trusted, s).not.toContain(s);
    }
    // fixed text and what the user typed: the rules, the steering note, the tweak
    for (const s of ["mention the red van", "Make it warmer", "Do NOT write a full signature, address or opt-out line", "lead.draft"]) {
      expect(trusted, s).toContain(s);
      expect(untrusted, s).not.toContain(s);
    }
    expect(untrusted).not.toContain(audit.id);
    expect(bundle.text).toContain("complete_claude_task");
    expect(trusted).not.toContain("write_email");
    expect(trusted).toContain("must not contain the signature, the address or the opt-out line");
  });

  it("keeps work samples out of what Claude is shown", async () => {
    const { b } = await lead();
    const { createWorkSample } = await import("../src/worker/db/workSamples");
    await createWorkSample(env.DB, { title: "Secret Sample", url: "https://logan.dev/secret", result_line: "", tags: "" });
    let shown = "";
    await writeDraft(b.id, {}, (s) => { shown = s; return three(); });
    expect(shown).toContain("mini proposal");
    expect(shown).not.toContain("Secret Sample");
    await env.DB.prepare(`DELETE FROM work_samples`).run();
  });
});

describe("queued by the pipeline", () => {
  it("enqueueDraftFor queues one task per lead and reports whether it queued a new one", async () => {
    const { b, audit } = await lead();
    expect(await enqueueDraftFor(env.DB, { businessId: b.id, auditId: audit.id, steeringNote: "n" })).toEqual({ created: true });
    expect(await enqueueDraftFor(env.DB, { businessId: b.id, auditId: audit.id })).toEqual({ created: false });
    const rows = await tasks();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toEqual({ businessId: b.id, auditId: audit.id, options: { steeringNote: "n" } });
    expect(rows[0]).toMatchObject({ dedupe_key: b.id, target_type: "lead", target_id: b.id });
  });

  it("enqueueDraftIfWanted reports what was really queued", async () => {
    const { b, audit } = await lead();
    const ask = { businessId: b.id, auditId: audit.id, lowPriority: false };
    expect(await enqueueDraftIfWanted(env.DB, ask)).toBe(true);
    expect(await enqueueDraftIfWanted(env.DB, ask)).toBe(false); // already queued
    expect(await enqueueDraftIfWanted(env.DB, { ...ask, businessId: "gone" })).toBe(false);
    expect(await tasks()).toHaveLength(1);
  });
});

describe("routes", () => {
  it("route returns 202 and draft-status reflects the task", async () => {
    const { b } = await lead();
    expect(await (await api(`/api/leads/${b.id}/draft-status`)).json()).toEqual({ state: "idle", since: null });

    const post = await api(`/api/leads/${b.id}/regenerate`, { method: "POST", body: JSON.stringify({ steeringNote: " mention the van ", tone: "direct", focus: [0] }) });
    expect(post.status).toBe(202);
    const { queued, taskId } = await post.json<any>();
    expect(queued).toBe(true);
    expect((await getTask(env.DB, taskId))!.payload).toMatchObject({ businessId: b.id, options: { steeringNote: "mention the van", tone: "direct", focus: [0] } });

    const queuedState = await (await api(`/api/leads/${b.id}/draft-status`)).json<any>();
    expect(queuedState.state).toBe("queued");
    expect(Date.parse(queuedState.since)).not.toBeNaN();

    // a second click returns the open task
    const again = await api(`/api/leads/${b.id}/regenerate`, { method: "POST", body: "{}" });
    expect([again.status, (await again.json<any>()).taskId]).toEqual([202, taskId]);

    await claimById(taskId);
    expect((await (await api(`/api/leads/${b.id}/draft-status`)).json<any>()).state).toBe("claimed");
    expect(await completeTask(env, taskId, three())).toEqual({ ok: true });
    expect(await (await api(`/api/leads/${b.id}/draft-status`)).json()).toEqual({ state: "idle", since: null });
    const detail = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(detail.variants).toHaveLength(3);
  });

  it("a tweak with no draft is a 400, and a bad one never reaches the queue", async () => {
    const { b } = await lead();
    const r = await api(`/api/leads/${b.id}/regenerate`, { method: "POST", body: JSON.stringify({ tweak: "warmer" }) });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "Write a draft first" });
    expect((await api(`/api/leads/${b.id}/regenerate`, { method: "POST", body: JSON.stringify({ tweak: "louder" }) })).status).toBe(400);
    expect(await tasks()).toHaveLength(0);
  });

  it("a suppressed lead gets a 409 and no task; draft-status of an unknown lead is 404", async () => {
    const { b } = await lead();
    await addSuppression(env.DB, { kind: "place_id", value: (await getBusiness(env.DB, b.id))!.place_id!, reason: "opt_out" });
    expect((await api(`/api/leads/${b.id}/regenerate`, { method: "POST", body: "{}" })).status).toBe(409);
    expect(await tasks()).toHaveLength(0);
    expect((await api(`/api/leads/nope/draft-status`)).status).toBe(404);
  });

  it("write it myself creates an editable draft addressed like a written one, with nothing from Claude in it", async () => {
    const { b } = await lead();
    await replaceContacts(env.DB, b.id, [email(b.id, "info@ace.com")]);
    const r = await api(`/api/leads/${b.id}/draft/manual`, { method: "POST", body: "{}" });
    expect(r.status).toBe(201);
    const d = await r.json<any>();
    expect([d.subject, d.body, d.purpose, d.include_footer, d.to_contact_id]).toEqual(["A quick note about your website", "Hi,", "freelance", true, (await listContacts(env.DB, b.id))[0].id]);
    expect(await tasks()).toHaveLength(0);
    const save = await api(`/api/leads/${b.id}/draft`, { method: "PATCH", body: JSON.stringify({ subject: "Mine", body: "My own words" }) });
    expect(save.status).toBe(200);
    // a lead with no audit has nothing to address it from, and a suppressed lead gets none
    const bare = await seedBusiness();
    expect((await api(`/api/leads/${bare.id}/draft/manual`, { method: "POST", body: "{}" })).status).toBe(400);
    await addSuppression(env.DB, { kind: "place_id", value: (await getBusiness(env.DB, b.id))!.place_id!, reason: "opt_out" });
    expect((await api(`/api/leads/${b.id}/draft/manual`, { method: "POST", body: "{}" })).status).toBe(409);
  });

  it("deleting the lead through the API closes its queued draft", async () => {
    const { b } = await lead();
    const { taskId } = await requestDraft(env.DB, b.id);
    expect((await api(`/api/leads/${b.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await getTask(env.DB, taskId))!.status).toBe("stale");
  });

  it("draftTaskState reports the open task and its time", async () => {
    const { b } = await lead();
    expect(await draftTaskState(env.DB, b.id)).toEqual({ state: "idle", since: null });
    const { taskId } = await requestDraft(env.DB, b.id);
    expect(await draftTaskState(env.DB, b.id)).toMatchObject({ state: "queued", since: (await getTask(env.DB, taskId))!.created_at });
    const t = await claimById(taskId);
    expect(await draftTaskState(env.DB, b.id)).toEqual({ state: "claimed", since: t.claimed_at });
  });
});


describe("the \"Write it myself\" placeholder is not a draft until it is written", () => {
  const manual = async (id: string) => api(`/api/leads/${id}/draft/manual`, { method: "POST", body: "{}" });
  /** The outreach "drafts" queue and the Home counter; other tests' leads share the database, so they are compared against a baseline. */
  const queues = async () => ({
    outreach: (await (await api(`/api/outreach?counts=1`)).json<any>()).counts.drafts as number,
    home: (await buildSummary(env.DB, new Date())).drafts.ready,
  });

  it("manual route returns the existing draft and inserts nothing when the lead has one", async () => {
    const { b } = await lead();
    const written = await writeDraft(b.id); // Claude's draft landed before the composer reloaded
    const r = await manual(b.id);
    expect(r.status).toBe(200);
    expect((await r.json<any>()).id).toBe(written.id);
    expect(await listDrafts(env.DB, b.id)).toHaveLength(3);
    expect((await latestDraft(env.DB, b.id))!.id).toBe(written.id);
    // and a second click on a lead whose only draft is the placeholder gives that one back
    const other = await lead();
    const first = await (await manual(other.b.id)).json<any>();
    const again = await manual(other.b.id);
    expect([again.status, (await again.json<any>()).id]).toEqual([200, first.id]);
    expect(await listDrafts(env.DB, other.b.id)).toHaveLength(1);
  });

  it("an untouched placeholder is flagged, and counts in no queue, list or counter", async () => {
    const { b } = await lead();
    const base = await queues();
    const d = await (await manual(b.id)).json<any>();
    expect([d.subject, d.body]).toEqual([PLACEHOLDER_SUBJECT, PLACEHOLDER_BODY]);
    expect(isPlaceholderDraft(d)).toBe(true);
    expect((await (await api(`/api/leads/${b.id}`)).json<any>()).draftPlaceholder).toBe(true);
    expect((await draftedIds(env.DB, [b.id])).size).toBe(0);
    expect((await latestDraftsByBusiness(env.DB)).has(b.id)).toBe(false);
    expect(await queues()).toEqual(base);
    expect((await listTodayCandidates(env.DB, new Date().toISOString(), 101)).some((c) => c.id === b.id)).toBe(false);
    const row = (await (await api(`/api/leads`)).json<any[]>()).find((r) => r.business.id === b.id);
    expect(row.hasDraft).toBe(false);
  });

  it("startSequence rejects a lead whose only draft is the placeholder", async () => {
    const { b } = await lead();
    await replaceContacts(env.DB, b.id, [email(b.id, "info@ace.com")]);
    await manual(b.id);
    const campaign = await createCampaign(env.DB, { name: "C", niche: "plumber", region: "Boise", towns: ["Boise, ID"] });
    const r = await startSequence(env, { businessId: b.id, campaignId: campaign.id });
    expect(r).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/only the empty starter/) });
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM enrollments WHERE business_id = ?`).bind(b.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("once edited it counts normally", async () => {
    const { b } = await lead();
    const base = await queues();
    await manual(b.id);
    // the footer switch alone leaves it a placeholder
    expect((await api(`/api/leads/${b.id}/draft`, { method: "PATCH", body: JSON.stringify({ subject: PLACEHOLDER_SUBJECT, body: PLACEHOLDER_BODY, include_footer: false }) })).status).toBe(200);
    expect(isPlaceholderDraft((await latestDraft(env.DB, b.id))!)).toBe(true);
    expect((await draftedIds(env.DB, [b.id])).size).toBe(0);
    // writing it makes it a draft
    expect((await api(`/api/leads/${b.id}/draft`, { method: "PATCH", body: JSON.stringify({ subject: "My own subject", body: "Hi Ann, my own words." }) })).status).toBe(200);
    const d = (await latestDraft(env.DB, b.id))!;
    expect([isPlaceholderDraft(d), d.edited]).toEqual([false, true]);
    expect((await draftedIds(env.DB, [b.id])).has(b.id)).toBe(true);
    expect((await latestDraftsByBusiness(env.DB)).get(b.id)!.id).toBe(d.id);
    expect(await queues()).toEqual({ outreach: base.outreach + 1, home: base.home + 1 });
    expect((await (await api(`/api/leads/${b.id}`)).json<any>()).draftPlaceholder).toBe(false);
  });

  it("an edit back to the placeholder text still counts as written (edited stays set)", async () => {
    const { b } = await lead();
    await manual(b.id);
    await api(`/api/leads/${b.id}/draft`, { method: "PATCH", body: JSON.stringify({ subject: "Other", body: "Other body" }) });
    await api(`/api/leads/${b.id}/draft`, { method: "PATCH", body: JSON.stringify({ subject: PLACEHOLDER_SUBJECT, body: PLACEHOLDER_BODY }) });
    expect(isPlaceholderDraft((await latestDraft(env.DB, b.id))!)).toBe(false);
  });
});

describe("the draft result's size limits match the editor's", () => {
  const one = (body: string) => ({ variants: [{ angle: "", subject: "s", body }], to_contact_id: null, recipient_reason: "r" });
  it("accepts a body of 5000 characters and refuses 5001, with the issue listed", async () => {
    expect(DraftResult.safeParse(one("a".repeat(5000))).success).toBe(true);
    expect(DraftResult.safeParse(one("a".repeat(5001))).success).toBe(false);
    const { b } = await lead();
    const { taskId } = await requestDraft(env.DB, b.id);
    await claimById(taskId);
    expect(await completeTask(env, taskId, one("a".repeat(5001)))).toMatchObject({ ok: false, error: expect.stringMatching(/invalid result[\s\S]*variants\.0\.body/) });
    expect(await completeTask(env, taskId, one("a".repeat(5000)))).toEqual({ ok: true });
  });
});
