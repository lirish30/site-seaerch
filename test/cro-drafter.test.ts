import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { regenerateDraft, type LeadDeps } from "../src/worker/pipeline/lead";
import { createCroAudit, listCroItems, replaceCroItems, updateCroItem } from "../src/worker/db/cro";
import { seedBusiness, seedLeadAudit, ranked } from "./fixtures/cro";

function leadDeps(onPrompt: (user: string) => void): LeadDeps {
  return { db: env.DB, raw: env.RAW, pagespeedKey: "K", fetch: async () => new Response(""), now: () => new Date(),
    claude: async (p: { system: string; user: string }) => { onPrompt(p.user); return { subject: "Hi", body: "Body", to_contact_id: null, recipient_reason: "r" }; } } as unknown as LeadDeps;
}

async function setup() {
  const b = await seedBusiness();
  await seedLeadAudit(b.id);
  const a = await createCroAudit(env.DB, b.id);
  await replaceCroItems(env.DB, a.id, [ranked({ title: "Header button", observation: "Your header has no quote button", change: "Add a Get a Quote button" })]);
  const [item] = await listCroItems(env.DB, a.id);
  return { b, item };
}

describe("CRO focus in drafts", () => {
  it("leads the prompt with picked CRO items and switches the offer to conversion; ignores other leads' ids", async () => {
    const { b, item } = await setup();
    const other = await setup();
    let user = "";
    const d = await regenerateDraft(leadDeps((u) => { user = u; }), b.id, { croFocus: [item.id, other.item.id] });
    expect(user).toContain("Lead with these issues (the sender chose them):");
    expect(user).toContain("- Your header has no quote button (fix: Add a Get a Quote button)");
    expect(user.match(/Your header has no quote button/g)).toHaveLength(1);
    expect(user).toContain("Offer to lead with: conversion");
    expect(d.offer).toBe("conversion");
  });

  it("ignores items excluded from sharing", async () => {
    const { b, item } = await setup();
    await updateCroItem(env.DB, item.id, { included: false });
    let user = "";
    const d = await regenerateDraft(leadDeps((u) => { user = u; }), b.id, { croFocus: [item.id] });
    expect(user).not.toContain("Your header has no quote button");
    expect(d.offer).toBe("seo_basics");
  });
});
