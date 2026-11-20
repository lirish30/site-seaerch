import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { milestoneHook, milestoneInvoice, milestoneRef, reconcileMilestones } from "../src/worker/billing/milestones";
import { getInvoiceByRef, listInvoices } from "../src/worker/db/invoices";
import { getPackage, savePackage } from "../src/worker/db/packages";
import { reachMilestone, setProjectStatus } from "../src/worker/db/projects";
import type { Env } from "../src/worker/env";
import { clearProjectHooksForTests, onMilestone, runMilestone } from "../src/worker/projects/hooks";
import { seedSignedProject } from "./fixtures/billing";

const e = env as Env;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { clearProjectHooksForTests(); errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); });

const pending = async (invoiceId: string) => (await env.DB.prepare(`SELECT id FROM approvals WHERE kind = 'invoice.send' AND status = 'pending' AND json_extract(payload, '$.invoiceId') = ?`).bind(invoiceId).all<{ id: string }>()).results;
const forDocument = async (documentId: string) => (await listInvoices(env.DB, { kinds: ["milestone"] })).filter((i) => i.documentId === documentId);

describe("milestone invoices", () => {
  it("starter site: site_finished drafts the second 50 percent from the signed schedule", async () => {
    const s = await seedSignedProject({ option: "b" });
    const starter = (await getPackage(env.DB, "starter_site"))!;
    const net = starter.priceCents + starter.setupCents;
    const inv = (await milestoneInvoice(e, s.project, "site_finished"))!;
    expect(inv).toMatchObject({
      kind: "milestone", status: "draft", ref: `milestone:${s.documentId}:site_finished`, projectId: s.project.id, documentId: s.documentId, businessId: s.businessId, dealId: s.dealId,
      test: false, stripeInvoiceId: null, amountCents: net - Math.floor(net / 2), lines: [{ description: "Site finished (SL-ABCDEF)", amountCents: net - Math.floor(net / 2) }],
    });
    expect(inv.ref).toBe(milestoneRef(s.documentId, "site_finished"));
    // The Starter has no design-approved payment: nothing is due there.
    expect(await milestoneInvoice(e, s.project, "design_approved")).toBeNull();
    expect(await forDocument(s.documentId)).toHaveLength(1);
  });

  it("growth: design_approved drafts the 30 and site_finished the last 30", async () => {
    const s = await seedSignedProject({ option: "c" });
    const growth = (await getPackage(env.DB, "growth_site"))!;
    const net = growth.priceCents + growth.setupCents;
    const signing = Math.floor(net * 0.4), design = Math.floor(net * 0.3), last = net - signing - design;
    const a = (await milestoneInvoice(e, s.project, "design_approved"))!;
    const b = (await milestoneInvoice(e, s.project, "site_finished"))!;
    expect(a).toMatchObject({ amountCents: design, lines: [{ description: "Design approved (SL-ABCDEF)", amountCents: design }] });
    expect(b).toMatchObject({ amountCents: last, lines: [{ description: "Site finished (SL-ABCDEF)", amountCents: last }] });
    expect(a.ref).not.toBe(b.ref);
  });

  it("a test project drafts nothing", async () => {
    const s = await seedSignedProject({ test: true });
    expect(await milestoneInvoice(e, s.project, "site_finished")).toBeNull();
    onMilestone(milestoneHook);
    await runMilestone(e, s.project, "site_finished");
    expect(await getInvoiceByRef(env.DB, milestoneRef(s.documentId, "site_finished"))).toBeNull();
    await reachMilestone(env.DB, s.project.id, "site_finished", "2027-01-05T10:00:00.000Z");
    expect(await reconcileMilestones(e)).toBe(0);
  });

  it("a cancelled project drafts nothing", async () => {
    const s = await seedSignedProject();
    const cancelled = await setProjectStatus(env.DB, s.project.id, "cancelled");
    expect(cancelled.status).toBe("cancelled");
    expect(await milestoneInvoice(e, cancelled, "site_finished")).toBeNull();
    await reachMilestone(env.DB, s.project.id, "site_finished", "2027-01-05T10:00:00.000Z");
    expect(await reconcileMilestones(e)).toBe(0);
    expect(await forDocument(s.documentId)).toHaveLength(0);
  });

  it("nothing is drafted for a document that is not signed and paid, or a project with no document", async () => {
    const unpaid = await seedSignedProject({ paid: false });
    expect(await milestoneInvoice(e, unpaid.project, "site_finished")).toBeNull();
    const unsigned = await seedSignedProject({ signed: false, paid: false });
    expect(await milestoneInvoice(e, unsigned.project, "site_finished")).toBeNull();
    expect(await milestoneInvoice(e, { ...unpaid.project, documentId: null }, "site_finished")).toBeNull();
  });

  it("a replayed hook and reconcileMilestones make one invoice and one approval", async () => {
    const s = await seedSignedProject();
    onMilestone(milestoneHook);
    await runMilestone(e, s.project, "site_finished");
    await runMilestone(e, s.project, "site_finished");
    await reachMilestone(env.DB, s.project.id, "site_finished", "2027-01-05T10:00:00.000Z");
    expect(await reconcileMilestones(e)).toBe(0);
    const all = await forDocument(s.documentId);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("draft");
    const waiting = await pending(all[0].id);
    expect(waiting).toHaveLength(1);
    expect(await env.DB.prepare(`SELECT record_type, record_id FROM approvals WHERE id = ?`).bind(waiting[0].id).first()).toMatchObject({ record_type: "project", record_id: s.project.id });
  });

  it("reconcileMilestones makes the invoice a hook never made, once", async () => {
    const s = await seedSignedProject({ option: "c" });
    await reachMilestone(env.DB, s.project.id, "design_approved", "2027-01-01T10:00:00.000Z");
    await reachMilestone(env.DB, s.project.id, "site_finished", "2027-01-05T10:00:00.000Z");
    expect(await reconcileMilestones(e)).toBe(2);
    expect(await reconcileMilestones(e)).toBe(0);
    const all = await forDocument(s.documentId);
    expect(all).toHaveLength(2);
    for (const i of all) expect(await pending(i.id)).toHaveLength(1);
  });

  it("the amount is the signed document's even after the catalog price changed", async () => {
    const s = await seedSignedProject();
    const frozen = s.schedule.milestones.find((m) => m.dueOn === "site_finished")!.amountCents;
    const starter = (await getPackage(env.DB, "starter_site"))!;
    try {
      await savePackage(env.DB, "starter_site", { priceCents: starter.priceCents + 250000 });
      const inv = (await milestoneInvoice(e, s.project, "site_finished"))!;
      expect(inv.amountCents).toBe(frozen);
      expect(inv.lines).toEqual([{ description: "Site finished (SL-ABCDEF)", amountCents: frozen }]);
    } finally {
      await savePackage(env.DB, "starter_site", { priceCents: starter.priceCents });
    }
  });
});
