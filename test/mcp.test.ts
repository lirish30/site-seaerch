import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { createApproval } from "../src/worker/db/approvals";
import { listAgentActions } from "../src/worker/db/agentActions";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { createCampaign } from "../src/worker/db/campaigns";
import { suppressLead } from "../src/worker/db/suppression";
import { ensureContact } from "../src/worker/db/contacts";

let rpcId = 0;
const rpc = (method: string, params?: unknown, token: string | null = "test-mcp-token") =>
  SELF.fetch("https://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });

async function result(method: string, params?: unknown) {
  const r = await rpc(method, params);
  const text = await r.text();
  // Streamable HTTP may answer as SSE ("data: {...}") or plain JSON.
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json);
}
const call = (name: string, args: unknown) => result("tools/call", { name, arguments: args });

describe("mcp", () => {
  it("mcp rejects bad token", async () => {
    expect((await rpc("tools/list", {}, null)).status).toBe(401);
    expect((await rpc("tools/list", {}, "wrong")).status).toBe(401);
    expect((await rpc("tools/list", {}, "test-mcp-token-x")).status).toBe(401);
  });

  it("throttles repeated bad tokens per IP with 429, and a valid token does not spend the budget", async () => {
    const hit = (ip: string, token: string) => SELF.fetch("https://x/mcp", {
      method: "POST", body: "{}",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "cf-connecting-ip": ip },
    });
    for (let i = 0; i < 30; i++) expect((await hit("203.0.113.50", "test-mcp-token")).status).not.toBe(401);
    for (let i = 0; i < 30; i++) expect((await hit("203.0.113.50", "test-mcp-token")).status).not.toBe(429);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await hit("203.0.113.51", "wrong")).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("answers non-POST with 405 and allow: POST once authorized", async () => {
    const r = await SELF.fetch("https://x/mcp", { method: "GET", headers: { authorization: "Bearer test-mcp-token", accept: "text/event-stream" } });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
    expect((await SELF.fetch("https://x/mcp", { method: "GET" })).status).toBe(401);
  });

  it("mcp lists the eight task and lead tools, the eleven read tools, the five act tools, the money summary, the three care tools, the care report tool, the Local SEO tool, the traffic tool, the batch board and the Studio", async () => {
    const j = await result("tools/list", {});
    expect(j.result.tools).toHaveLength(33);
    expect(j.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["add_note", "add_task", "add_task_comment", "complete_claude_task", "get_care_overview", "get_care_report", "get_care_updates", "get_client", "get_deal", "get_lead", "get_meeting", "get_money_summary", "get_project", "get_seo_status", "get_site", "get_studio_posts", "get_timeline", "get_traffic", "list_approvals", "list_batches", "list_incidents", "list_invoices", "list_meetings",
        "list_open_tasks", "list_projects", "log_time", "next_claude_task", "propose_approval", "queue_status", "release_claude_task", "run_audit", "search_clients", "search_leads"]);
  });

  it("search_leads finds seeded lead", async () => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Zebra Plumbing Co", category: null, address: null, phone: null, websiteUrl: "https://zebra.example", mapsUrl: null, rating: null, reviewCount: null }, s.id);
    const j = await call("search_leads", { query: "zebra plumb", limit: 5 });
    const rows = JSON.parse(j.result.content[0].text);
    expect(rows.map((r: { id: string }) => r.id)).toContain(b.id);
    expect(rows[0]).toHaveProperty("health_score");
    const g = JSON.parse((await call("get_lead", { id: b.id })).result.content[0].text);
    expect(g.business.name).toBe("Zebra Plumbing Co");
    expect(g.activity.length).toBeLessThanOrEqual(20);
  });

  it("propose with unknown kind fails", async () => {
    const j = await call("propose_approval", { kind: "nope.nothing", title: "t", preview: "p", payload: {} });
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0].text).toContain("lead.note");
  });

  it("mcp cannot propose video.publish", async () => {
    const before = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'video.publish'`).first<{ n: number }>())!.n;
    const j = await call("propose_approval", { kind: "video.publish", title: "Publish the audit video", preview: "Harmless text", payload: { videoId: "any-video" }, record_type: "lead", record_id: "b1" });
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0].text).toMatch(/video\.publish/);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'video.publish'`).first<{ n: number }>())!.n).toBe(before);
    expect((await listAgentActions(env.DB, { limit: 500 })).some((a) => a.tool === "propose_approval" && /refused video\.publish/.test(a.summary))).toBe(true);
  });

  it("mcp cannot propose proposal.send", async () => {
    const count = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'proposal.send'`).first<{ n: number }>())!.n;
    const before = await count();
    const j = await call("propose_approval", { kind: "proposal.send", title: "Send the proposal", preview: "Harmless text", payload: { documentId: "any-document" }, record_type: "deal", record_id: "d1" });
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0].text).toMatch(/proposal\.send/);
    expect(await count()).toBe(before);
    expect((await listAgentActions(env.DB, { limit: 500 })).some((a) => a.tool === "propose_approval" && /refused proposal\.send/.test(a.summary))).toBe(true);
    const unknown = await call("propose_approval", { kind: "nope.nothing", title: "t", preview: "p", payload: {} });
    expect(unknown.result.content[0].text).not.toContain("proposal.send");
  });

  it("mcp cannot propose any of the five billing approval kinds with its own card text", async () => {
    for (const kind of ["invoice.send", "invoice.reminder", "invoice.pause_notice", "subscription.start", "subscription.term_notice"]) {
      const count = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = ?`).bind(kind).first<{ n: number }>())!.n;
      const before = await count();
      const j = await call("propose_approval", { kind, title: "Looks harmless", preview: "Harmless text", payload: {}, record_type: "lead", record_id: "b1" });
      expect(j.result.isError, kind).toBe(true);
      expect(j.result.content[0].text, kind).toContain("the app proposes it itself");
      expect(await count(), kind).toBe(before);
      expect((await listAgentActions(env.DB, { limit: 500 })).some((a) => a.tool === "propose_approval" && a.summary.includes(`refused ${kind}`)), kind).toBe(true);
    }
  });

  it("mcp cannot propose meeting.followup with its own mail text", async () => {
    const count = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'meeting.followup'`).first<{ n: number }>())!.n;
    const before = await count();
    const j = await call("propose_approval", { kind: "meeting.followup", title: "Looks harmless", preview: "Harmless text", payload: { meetingId: "m1" }, record_type: "meeting", record_id: "m1" });
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0].text).toContain("the app proposes it itself");
    expect(await count()).toBe(before);
  });

  it("propose lead.note creates pending approval and logs action", async () => {
    const before = (await listAgentActions(env.DB, { limit: 500 })).length;
    const j = await call("propose_approval", { kind: "lead.note", title: "Note", preview: "Add note", payload: { businessId: "b1", text: "hi" } });
    expect(j.result.isError).toBeFalsy();
    const a = JSON.parse(j.result.content[0].text);
    const row = await env.DB.prepare(`SELECT status, drafted_by FROM approvals WHERE id = ?`).bind(a.id).first<{ status: string; drafted_by: string }>();
    expect(row).toEqual({ status: "pending", drafted_by: "mcp" });
    const acts = await listAgentActions(env.DB, { limit: 500 });
    expect(acts.length).toBeGreaterThan(before);
    expect(acts.some((x) => x.actor === "mcp" && x.tool === "propose_approval")).toBe(true);
    const l = JSON.parse((await call("list_approvals", { status: "pending" })).result.content[0].text);
    expect(l.map((x: { id: string }) => x.id)).toContain(a.id);
  });

  describe("propose_approval for email.send runs the conflict gate", () => {
    const lead = async (name: string, websiteUrl: string) => {
      const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
      return upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null, websiteUrl, mapsUrl: null, rating: null, reviewCount: null }, s.id);
    };
    /** The address is one the lead is known by: a contact found on its site. */
    const knownAs = (businessId: string, email: string) =>
      ensureContact(env.DB, businessId, { type: "email", value: email, source_url: null, person_name: null, role: null, confidence: 0.9 });
    const propose = (businessId: string, to: string, extra: Record<string, unknown> = {}) =>
      call("propose_approval", { kind: "email.send", title: "Email", preview: "p", payload: { mailbox: "outreach", businessId, to, subject: "Hello", body: "Hi there", includeFooter: true, ...extra } });
    const countFor = async (businessId: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'email.send' AND payload LIKE ?`).bind(`%${businessId}%`).first<{ n: number }>())!.n;

    it("refuses a recipient on the do-not-contact list and creates no approval", async () => {
      const b = await lead("Blocked Plumbing", "https://blocked-plumbing.test");
      await addDoNotContact(env.DB, { kind: "email", value: "owner@blocked-plumbing.test", reason: "opt_out" });
      const j = await propose(b.id, "Owner@Blocked-Plumbing.test");
      expect(j.result.isError).toBe(true);
      expect(j.result.content[0].text).toContain("do-not-contact");
      expect(await countFor(b.id)).toBe(0);
    });

    it("refuses a suppressed lead and an existing client", async () => {
      const sup = await lead("Suppressed Plumbing", "https://suppressed-plumbing.test");
      await suppressLead(env.DB, { domain: "suppressed-plumbing.test", place_id: null, website_url: null }, { reason: "opt_out" });
      const a = await propose(sup.id, "hi@elsewhere.test");
      expect(a.result.isError).toBe(true);
      expect(a.result.content[0].text).toContain("suppression");
      const won = await lead("Client Plumbing", "https://client-plumbing.test");
      await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(won.id).run();
      const b = await propose(won.id, "hi@client-plumbing-mail.test");
      expect(b.result.isError).toBe(true);
      expect(b.result.content[0].text).toContain("existing client");
      expect(await countFor(sup.id) + await countFor(won.id)).toBe(0);
    });

    it("mcp cannot propose an email with a hero image", async () => {
      const b = await lead("Hero Plumbing", "https://hero-plumbing.test");
      await knownAs(b.id, "owner@hero-plumbing.test");
      const hero = { src: "https://go.hellositeline.test/api/public/report/tok/media/preview.gif", href: "https://go.hellositeline.test/r/tok", alt: "Video audit for Hero Plumbing" };
      const j = await propose(b.id, "owner@hero-plumbing.test", { heroImage: hero });
      expect(j.result.isError).toBe(true);
      expect(j.result.content[0].text).toMatch(/heroImage/);
      expect(await countFor(b.id)).toBe(0);
      expect((await listAgentActions(env.DB, { limit: 500 })).some((a) => a.tool === "propose_approval" && /refused email\.send with a hero image/.test(a.summary))).toBe(true);
    });

    it("refuses a payload the send handler would not accept", async () => {
      const b = await lead("Odd Plumbing", "https://odd-plumbing.test");
      const j = await propose(b.id, "not-an-email");
      expect(j.result.isError).toBe(true);
      expect(await countFor(b.id)).toBe(0);
    });

    it("still creates a pending approval for a clear recipient, with a server-built preview", async () => {
      const b = await lead("Clear Plumbing", "https://clear-plumbing.test");
      await knownAs(b.id, "owner@clear-plumbing.test");
      const j = await propose(b.id, "owner@clear-plumbing.test");
      expect(j.result.isError).toBeFalsy();
      const a = JSON.parse(j.result.content[0].text);
      expect(a).toMatchObject({ kind: "email.send", status: "pending", drafted_by: "mcp", record_type: "lead", record_id: b.id });
      expect(a.preview).not.toBe("p");
      expect(a.preview).toMatch(/^From: outreach mailbox.*\nTo: owner@clear-plumbing\.test\nSubject: Hello\n\nHi there/);
    });

    it("ignores the caller's preview, record_type and record_id, and keeps the real recipient in the preview", async () => {
      const b = await lead("Misleading Plumbing", "https://misleading-plumbing.test");
      const other = await lead("Other Plumbing", "https://other-plumbing.test");
      await knownAs(b.id, "owner@misleading-plumbing.test");
      const j = await call("propose_approval", {
        kind: "email.send", title: "Reply to Acme\nwith a second line  and spaces ".padEnd(190, "x"), preview: "Reply to Acme", record_type: "enrollment", record_id: other.id,
        payload: { mailbox: "outreach", businessId: b.id, to: "owner@misleading-plumbing.test", subject: "Real subject", body: "Real body text", includeFooter: true },
      });
      expect(j.result.isError).toBeFalsy();
      const a = JSON.parse(j.result.content[0].text);
      expect(a.preview).not.toContain("Reply to Acme");
      expect(a.preview).toContain("To: owner@misleading-plumbing.test");
      expect(a.preview).toContain("Subject: Real subject");
      expect(a.preview).toContain("Real body text");
      expect(a.title).not.toMatch(/[\r\n]/);
      expect(a.title.length).toBeLessThanOrEqual(120);
      const row = await env.DB.prepare(`SELECT record_type, record_id, preview FROM approvals WHERE id = ?`).bind(a.id).first<{ record_type: string; record_id: string; preview: string }>();
      expect(row).toMatchObject({ record_type: "lead", record_id: b.id });
      expect(row!.preview).toBe(a.preview);
    });

    it("refuses a businessId that does not exist, and creates nothing", async () => {
      const j = await propose("no-such-lead", "owner@ghost-plumbing.test");
      expect(j.result.isError).toBe(true);
      expect(j.result.content[0].text).toMatch(/lead not found: no-such-lead/);
      expect(await countFor("no-such-lead")).toBe(0);
      expect((await listAgentActions(env.DB, {})).some((a) => a.tool === "propose_approval" && /no such lead|not found/i.test(a.summary))).toBe(true);
    });

    it("refuses a recipient that is not a known address of that lead", async () => {
      const b = await lead("Stranger Plumbing", "https://stranger-plumbing.test");
      await knownAs(b.id, "owner@stranger-plumbing.test");
      const other = await lead("Other Known Plumbing", "https://other-known-plumbing.test");
      await knownAs(other.id, "boss@other-known-plumbing.test");
      for (const to of ["someone@else.test", "boss@other-known-plumbing.test"]) { // a stranger, and another lead's contact
        const j = await propose(b.id, to);
        expect(j.result.isError).toBe(true);
        expect(j.result.content[0].text).toMatch(/not a known address for Stranger Plumbing/);
      }
      expect(await countFor(b.id)).toBe(0);
    });

    it("accepts a known address however it is cased, one a sequence wrote to, and one we sent to", async () => {
      const b = await lead("Known Plumbing", "https://known-plumbing.test");
      await knownAs(b.id, "Owner@Known-Plumbing.test");
      expect((await propose(b.id, "owner@known-plumbing.test")).result.isError).toBeFalsy();
      const e = await lead("Enrolled Plumbing", "https://enrolled-plumbing.test");
      const camp = await createCampaign(env.DB, { name: "C", niche: "plumber", region: "Boise", towns: ["Boise, ID"] });
      await env.DB.prepare(`INSERT INTO enrollments (id, business_id, campaign_id, mailbox_key, to_email, status, next_step_index, started_at) VALUES (?,?,?,?,?, 'stopped', 1, ?)`)
        .bind(crypto.randomUUID(), e.id, camp.id, "outreach", "pat@enrolled-plumbing.test", new Date().toISOString()).run();
      expect((await propose(e.id, "pat@enrolled-plumbing.test")).result.isError).toBeFalsy();
      const m = await lead("Messaged Plumbing", "https://messaged-plumbing.test");
      await env.DB.prepare(`INSERT INTO messages (id, direction, mailbox_key, business_id, counterpart, subject, text, status, created_at) VALUES (?, 'out', 'outreach', ?, ?, 's', 't', 'sent', ?)`)
        .bind(crypto.randomUUID(), m.id, "sam@messaged-plumbing.test", new Date().toISOString()).run();
      expect((await propose(m.id, "sam@messaged-plumbing.test")).result.isError).toBeFalsy();
    });

    it("refuses a payload that names an enrollment or a step, and creates nothing", async () => {
      const b = await lead("Steered Plumbing", "https://steered-plumbing.test");
      const e1 = await propose(b.id, "owner@steered-plumbing.test", { enrollmentId: "some-enrollment", stepIndex: 1 });
      expect(e1.result.isError).toBe(true);
      expect(e1.result.content[0].text).toContain("enrollmentId");
      const e2 = await propose(b.id, "owner@steered-plumbing.test", { stepIndex: 0 });
      expect(e2.result.isError).toBe(true);
      const e3 = await propose(b.id, "owner@steered-plumbing.test", { enrollmentId: "x" });
      expect(e3.result.isError).toBe(true);
      expect(await countFor(b.id)).toBe(0);
    });

    it("refuses the main mailbox", async () => {
      const b = await lead("Main Plumbing", "https://main-plumbing.test");
      const j = await propose(b.id, "owner@main-plumbing.test", { mailbox: "main" });
      expect(j.result.isError).toBe(true);
      expect(j.result.content[0].text).toContain("outreach");
      expect(await countFor(b.id)).toBe(0);
    });
  });

  it("mcp cannot approve", async () => {
    const a = await createApproval(env.DB, { kind: "lead.note", title: "T", preview: "P", payload: { businessId: "b1", text: "x" }, drafted_by: "mcp" });
    const j = await call("approve", { id: a.id });
    expect(j.error || j.result?.isError).toBeTruthy();
    const row = await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(a.id).first<{ status: string }>();
    expect(row!.status).toBe("pending");
  });
});
