import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { insertMeetingIfNew, saveSummary } from "../src/worker/db/meetings";
import { createSite, setAccess } from "../src/worker/db/sites";
import { insertTasks } from "../src/worker/db/tasks";
import { reachMilestone } from "../src/worker/db/projects";
import { logAgentAction } from "../src/worker/db/agentActions";
import { logActivity } from "../src/worker/db/activity";
import { saveOptions } from "../src/worker/db/deals";
import { addChangeOrder, seedClient } from "./fixtures/clients";
import { seedDeal } from "./fixtures/documents";
import { newTask, resetProjectWork, seedProject, seedSteps } from "./fixtures/projects";
import { actionCount, mcp, ok, tool } from "./fixtures/mcp";

const rename = (id: string, name: string) => env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind(name, id).run();
beforeEach(async () => {
  await env.DB.batch(["meetings", "invoices", "subscriptions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await resetProjectWork();
});

/** Every read tool must write exactly one row, found or not. */
async function oneAction(name: string, args: unknown) {
  const before = await actionCount(name);
  await tool(name, args);
  expect(await actionCount(name)).toBe(before + 1);
}

describe("the tool list", () => {
  it("adds the eleven read tools", async () => {
    const names = (await mcp("tools/list", {})).result.tools.map((t: { name: string }) => t.name);
    for (const n of ["search_clients", "get_client", "get_site", "list_projects", "get_project", "list_open_tasks", "get_deal", "get_timeline", "list_invoices", "list_meetings", "get_meeting"]) expect(names).toContain(n);
  });
});

describe("search_clients", () => {
  it("finds a client by name and by site domain, and leaves out a test client", async () => {
    const real = await seedClient();
    await rename(real.businessId, "Quokka Plumbing");
    const rehearsal = await seedClient({ test: true });
    await rename(rehearsal.businessId, "Quokka Rehearsal");
    const byName = await ok<{ id: string; domains: string[] }[]>("search_clients", { query: "quokka" });
    expect(byName.map((c) => c.id)).toEqual([real.businessId]);
    expect(byName[0].domains).toEqual(["ace.com"]);
    const byDomain = await ok<{ id: string }[]>("search_clients", { query: "ace.com" });
    expect(byDomain.map((c) => c.id)).toContain(real.businessId);
    expect(byDomain.map((c) => c.id)).not.toContain(rehearsal.businessId);
    expect((await ok<{ id: string }[]>("search_clients", {})).map((c) => c.id)).not.toContain(rehearsal.businessId);
  });

  it("refuses a limit over 50 and logs one action", async () => {
    expect((await tool("search_clients", { limit: 51 })).isError).toBe(true);
    await oneAction("search_clients", { query: "x" });
  });
});

describe("get_client", () => {
  it("returns the client with sites, access as key label status, subscriptions and projects", async () => {
    const s = await seedClient({ subs: [{ monthlyCents: 12900, key: "care" }], invoice: { cents: 50000 } });
    await rename(s.businessId, "Ace Plumbing");
    const c = await ok<any>("get_client", { id: s.businessId });
    expect(c).toMatchObject({ id: s.businessId, name: "Ace Plumbing", mrrCents: 12900, careLabel: "Care $129/mo" });
    expect(c.people[0]).toMatchObject({ name: "Pat Jones", isPoc: true });
    expect(c.sites[0].access).toHaveLength(6);
    expect(c.sites[0].access[0]).toEqual({ key: "hosting", label: "Hosting", status: "needed" });
    expect(c.projects[0]).toMatchObject({ name: "Website build" });
    expect(c.invoices.openCents).toBe(50000);
    await oneAction("get_client", { id: s.businessId });
  });

  it("says client not found for a missing id and for a lead that is not a client yet", async () => {
    const r = await tool("get_client", { id: "nope" });
    expect(r).toEqual({ isError: true, text: "client not found: nope" });
    const lead = await seedDeal();
    expect((await tool("get_client", { id: lead.businessId })).text).toBe(`client not found: ${lead.businessId}`);
    await oneAction("get_client", { id: "nope" });
  });
});

describe("get_site", () => {
  it("returns the site and its six access items without the vault name or note", async () => {
    const s = await seedClient();
    await setAccess(env.DB, s.site!.id, "hosting", { status: "received", vaultItem: "Bluehost login", note: "owner is Pat" }, "2026-12-05T10:00:00.000Z");
    const site = await ok<any>("get_site", { id: s.site!.id });
    expect(site).toMatchObject({ id: s.site!.id, domain: "ace.com", businessId: s.businessId });
    expect(site.access).toHaveLength(6);
    expect(site.access[0]).toEqual({ key: "hosting", label: "Hosting", status: "received" });
    expect(JSON.stringify(site)).not.toMatch(/Bluehost login|owner is Pat/);
    await oneAction("get_site", { id: s.site!.id });
  });
  it("says site not found", async () => {
    expect(await tool("get_site", { id: "nope" })).toEqual({ isError: true, text: "site not found: nope" });
    await oneAction("get_site", { id: "nope" });
  });
});

describe("list_projects", () => {
  it("lists a business's projects, filters by status and leaves out test projects", async () => {
    const real = await seedProject({ name: "Real build" });
    const other = await seedProject({ name: "Rehearsal", test: true });
    const all = await ok<any[]>("list_projects", {});
    expect(all.map((p) => p.id)).toContain(real.project.id);
    expect(all.map((p) => p.id)).not.toContain(other.project.id);
    expect((await ok<any[]>("list_projects", { business_id: real.businessId }))[0]).toMatchObject({ id: real.project.id, status: "active", openTasks: 0 });
    expect(await ok<any[]>("list_projects", { business_id: real.businessId, status: "done" })).toEqual([]);
    await oneAction("list_projects", {});
  });
});

describe("get_project", () => {
  it("returns tasks, milestones and change orders as id, title and status", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "a", title: "Write copy" }]);
    await reachMilestone(env.DB, s.project.id, "design_approved", "2026-12-04T10:00:00.000Z");
    const co = await addChangeOrder({ businessId: s.businessId, dealId: s.dealId }, s.project.id);
    const p = await ok<any>("get_project", { id: s.project.id });
    expect(p).toMatchObject({ id: s.project.id, name: "Website build", kind: "build" });
    expect(p.tasks).toEqual([{ id: t.id, title: "Write copy", status: "todo" }]);
    expect(p.milestones[0]).toMatchObject({ id: "design_approved", status: "reached" });
    expect(p.changeOrders).toEqual([{ id: co.id, title: "Add a gallery", status: "draft" }]);
    await oneAction("get_project", { id: s.project.id });
  });
  it("says project not found", async () => {
    expect(await tool("get_project", { id: "nope" })).toEqual({ isError: true, text: "project not found: nope" });
    await oneAction("get_project", { id: "nope" });
  });
});

describe("list_open_tasks", () => {
  it("lists by owner, leaves out test projects and caps at 50", async () => {
    const s = await seedProject();
    await insertTasks(env.DB, Array.from({ length: 55 }, (_, i) => newTask(s.project.id, s.businessId, { stepKey: `s${i}`, position: i, title: `Logan ${i}`, owner: "logan" })));
    await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { stepKey: "c", position: 99, title: "Claude job", owner: "claude" }),
      newTask(s.project.id, s.businessId, { stepKey: "w", position: 100, title: "Waiting on Pat", owner: "logan", status: "waiting_client" })]);
    const t = await seedProject({ test: true });
    await insertTasks(env.DB, [newTask(t.project.id, t.businessId, { stepKey: "x", title: "Rehearsal task", owner: "logan" })]);
    const logan = await ok<any[]>("list_open_tasks", { owner: "logan" });
    expect(logan).toHaveLength(50);
    expect(logan.every((x) => x.owner === "logan" && x.projectName === "Website build")).toBe(true);
    expect((await ok<any[]>("list_open_tasks", { owner: "claude" })).map((x) => x.title)).toEqual(["Claude job"]);
    expect((await ok<any[]>("list_open_tasks", { owner: "client" })).map((x) => x.title)).toEqual(["Waiting on Pat"]);
    expect(JSON.stringify(await ok<any[]>("list_open_tasks", {}))).not.toContain("Rehearsal task");
    await oneAction("list_open_tasks", {});
  });
});

describe("get_deal", () => {
  it("returns the stage, recap and options", async () => {
    const s = await seedDeal();
    await saveOptions(env.DB, s.dealId, {
      options: [{ id: "a", label: "Starter", tagline: "Small", items: [{ key: "starter" as never }], recommended: false }, { id: "b", label: "Growth", tagline: "Middle", items: [{ key: "growth" as never, setupDiscountCents: 100 }], recommended: true },
        { id: "c", label: "Full", tagline: "Big", items: [], recommended: false }],
      recommendedOptionId: "b", priceSnapshot: [], valueCents: 123400,
    });
    await env.DB.prepare(`UPDATE deals SET recap = ? WHERE id = ?`).bind(JSON.stringify({ playback: "You want more calls.", recommendation: "Option B", leadType: "established", goals: ["More calls"], currentState: ["Old site"], generatedAt: "2026-12-01T00:00:00.000Z" }), s.dealId).run();
    const d = await ok<any>("get_deal", { id: s.dealId });
    expect(d).toMatchObject({ id: s.dealId, stage: "booked", valueCents: 123400, recommendedOptionId: "b" });
    expect(d.options).toHaveLength(3);
    expect(d.options[1]).toMatchObject({ label: "Growth", recommended: true, items: [{ key: "growth", setupDiscountCents: 100 }] });
    expect(d.recap).toMatchObject({ playback: "You want more calls.", goals: ["More calls"] });
    await oneAction("get_deal", { id: s.dealId });
  });
  it("says deal not found", async () => {
    expect(await tool("get_deal", { id: "nope" })).toEqual({ isError: true, text: "deal not found: nope" });
    await oneAction("get_deal", { id: "nope" });
  });
});

describe("get_timeline", () => {
  it("for a business gives its activity and its agent actions, newest first", async () => {
    const s = await seedProject();
    await logActivity(env.DB, s.businessId, "note" as never, "Called Pat");
    await logAgentAction(env.DB, { actor: "mcp", tool: "get_lead", summary: "get_lead Ace", record_type: "business", record_id: s.businessId });
    const t = await ok<any>("get_timeline", { record_type: "business", record_id: s.businessId });
    expect(t.activity.map((a: any) => a.detail)).toContain("Called Pat");
    expect(t.agentActions.map((a: any) => a.summary)).toEqual(["get_lead Ace"]);
    await oneAction("get_timeline", { record_type: "business", record_id: s.businessId });
  });
  it("for a project gives the project's agent actions and its business's activity", async () => {
    const s = await seedProject();
    await logActivity(env.DB, s.businessId, "note" as never, "Business note");
    await logAgentAction(env.DB, { actor: "mcp", tool: "get_project", summary: "on the project", record_type: "project", record_id: s.project.id });
    await logAgentAction(env.DB, { actor: "mcp", tool: "get_lead", summary: "on the business", record_type: "business", record_id: s.businessId });
    const t = await ok<any>("get_timeline", { record_type: "project", record_id: s.project.id });
    expect(t.activity.map((a: any) => a.detail)).toContain("Business note");
    expect(t.agentActions.map((a: any) => a.summary)).toEqual(["on the project"]);
  });
  it("caps both lists at 50 and says what is not found", async () => {
    const s = await seedProject();
    for (let i = 0; i < 55; i++) await logActivity(env.DB, s.businessId, "note" as never, `n${i}`);
    for (let i = 0; i < 55; i++) await logAgentAction(env.DB, { actor: "mcp", tool: "x", summary: `a${i}`, record_type: "business", record_id: s.businessId });
    const t = await ok<any>("get_timeline", { record_type: "business", record_id: s.businessId });
    expect([t.activity.length, t.agentActions.length]).toEqual([50, 50]);
    expect(await tool("get_timeline", { record_type: "project", record_id: "nope" })).toEqual({ isError: true, text: "project not found: nope" });
    expect(await tool("get_timeline", { record_type: "business", record_id: "nope" })).toEqual({ isError: true, text: "business not found: nope" });
  });
});

describe("list_invoices", () => {
  it("lists invoices without Stripe ids or links, filters, and leaves out test invoices", async () => {
    const s = await seedClient({ invoice: { cents: 75000, dueOn: "2027-01-20" } });
    await seedClient({ test: true, invoice: { cents: 1111 } });
    const all = await ok<any[]>("list_invoices", {});
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: s.invoice!.id, businessId: s.businessId, amountCents: 75000, status: "open", dueOn: "2027-01-20", kind: "milestone" });
    expect(JSON.stringify(all)).not.toMatch(/stripe|hosted|in_|cus_/i);
    expect(await ok<any[]>("list_invoices", { business_id: s.businessId, status: "paid" })).toEqual([]);
    expect(await ok<any[]>("list_invoices", { business_id: s.businessId, status: "open" })).toHaveLength(1);
    await oneAction("list_invoices", {});
  });
});

const SUMMARY = {
  summary: "We agreed the scope.", decisions: ["Start in January"], actionItems: [{ title: "Send logos", owner: "client" as const, dueOn: null }],
  possibleChangeOrders: [], followUp: { subject: "Recap", body: "Thanks." }, generatedAt: "2026-12-01T20:00:00.000Z",
};
async function seedMeeting(businessId: string, o: { id?: string; text?: string; startedAt?: string } = {}) {
  const id = o.id ?? crypto.randomUUID();
  const key = `meetings/${id}/transcript.json`;
  await env.RAW.put(key, JSON.stringify({ lines: [{ speaker: "Pat", atSec: 1, text: o.text ?? "We want a store." }] }));
  const { meeting } = await insertMeetingIfNew(env.DB, {
    id, meetilyId: `m-${id}`, businessId, bookingId: null, windowKey: "w", title: "Kickoff call", startedAt: o.startedAt ?? "2026-12-01T17:00:00.000Z",
    endedAt: "2026-12-01T17:30:00.000Z", transcriptKey: key, notes: "Meetily notes",
  });
  return meeting;
}

describe("list_meetings and get_meeting", () => {
  it("lists meetings newest first with summaries, never the transcript, notes or key, and leaves out test clients", async () => {
    const s = await seedClient();
    const m = await seedMeeting(s.businessId);
    await saveSummary(env.DB, m.id, SUMMARY, "2026-12-01T20:00:00.000Z");
    const rehearsal = await seedClient({ test: true });
    await seedMeeting(rehearsal.businessId);
    const list = await ok<any[]>("list_meetings", {});
    expect(list.map((x) => x.id)).toEqual([m.id]);
    expect(list[0]).toMatchObject({ title: "Kickoff call", status: "summarized", summary: { summary: "We agreed the scope.", actionItems: [{ title: "Send logos", owner: "client", dueOn: null }] } });
    expect(JSON.stringify(list)).not.toMatch(/We want a store|Meetily notes|transcript\.json|transcriptKey/);
    expect((await ok<any[]>("list_meetings", { business_id: s.businessId })).map((x) => x.id)).toEqual([m.id]);
    expect(await ok<any[]>("list_meetings", { business_id: rehearsal.businessId })).toEqual([]);
    await oneAction("list_meetings", {});
  });
  it("caps the list at 50", async () => {
    const s = await seedClient();
    for (let i = 0; i < 52; i++) await seedMeeting(s.businessId, { startedAt: new Date(Date.UTC(2026, 11, 1, 0, i)).toISOString() });
    expect(await ok<any[]>("list_meetings", {})).toHaveLength(50);
  });
  it("get_meeting gives the summary and notes, and the transcript only on request, cut at 20 000 characters", async () => {
    const s = await seedClient();
    const m = await seedMeeting(s.businessId, { text: "x".repeat(25_000) });
    const plain = await ok<any>("get_meeting", { id: m.id });
    expect(plain).toMatchObject({ id: m.id, notes: "Meetily notes" });
    expect(plain).not.toHaveProperty("transcript");
    expect(JSON.stringify(plain)).not.toContain("transcript.json");
    const full = await ok<any>("get_meeting", { id: m.id, include_transcript: true });
    expect(full.transcript.length).toBe(20_000);
    expect(full.transcriptTruncated).toBe(true);
    expect(full.transcript.startsWith("Pat: xxx")).toBe(true);
    await oneAction("get_meeting", { id: m.id });
  });
  it("says meeting not found", async () => {
    expect(await tool("get_meeting", { id: "nope" })).toEqual({ isError: true, text: "meeting not found: nope" });
    await oneAction("get_meeting", { id: "nope" });
  });
});
