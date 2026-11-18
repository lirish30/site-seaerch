import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createCroAudit, listCroItems, replaceCroItems, updateCroItem } from "../src/worker/db/cro";
import { seedBusiness, seedLeadAudit, ranked } from "./fixtures/cro";
import { three, writeDraft } from "./fixtures/draftTask";

async function setup() {
  const b = await seedBusiness();
  await seedLeadAudit(b.id);
  const a = await createCroAudit(env.DB, b.id);
  await replaceCroItems(env.DB, a.id, [ranked({ title: "Header button", observation: "Your header has no quote button", change: "Add a Get a Quote button" })]);
  const [item] = await listCroItems(env.DB, a.id);
  return { b, item };
}

beforeEach(async () => { await env.DB.prepare(`DELETE FROM claude_tasks`).run(); });

describe("CRO focus in drafts", () => {
  it("leads the prompt with picked CRO items and switches the offer to conversion; ignores other leads' ids", async () => {
    const { b, item } = await setup();
    const other = await setup();
    let user = "";
    const d = await writeDraft(b.id, { croFocus: [item.id, other.item.id], purpose: "freelance" }, (shown) => { user = shown; return three(); });
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
    const d = await writeDraft(b.id, { croFocus: [item.id], purpose: "freelance" }, (shown) => { user = shown; return three(); });
    expect(user).not.toContain("Your header has no quote button");
    expect(d.offer).toBe("seo_basics");
  });
});
