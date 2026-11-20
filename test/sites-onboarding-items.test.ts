import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/worker/index";
import { getClientRecord } from "../src/worker/clients/record";
import { createDeal } from "../src/worker/db/deals";
import { createOnboarding, listItems, markWelcomeSent } from "../src/worker/db/onboardings";
import type { PackageKey } from "../src/worker/db/packages";
import { setAccess } from "../src/worker/db/sites";
import { ITEM_TEMPLATES, itemsFor } from "../src/worker/onboarding/templates";
import { seedClient } from "./fixtures/clients";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const NOW = new Date("2027-02-01T18:00:00.000Z");
const ACCESS_KEYS = ["access_hosting", "access_dns", "access_registrar", "access_admin", "access_gbp", "access_analytics"];
const keysOf = (k: PackageKey[]) => itemsFor(k).map((i) => i.key);
const accessOf = (k: PackageKey[]) => itemsFor(k).filter((i) => i.key.startsWith("access_"));

const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://x/api${path}`, init), env, ctx);
const putText = (token: string, itemId: string, text: unknown) =>
  call(`/public/o/${token}/items/${itemId}/text`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });

/** A client with a site, and an onboarding for it carrying the six access items (plus, optionally, an extra onboarding made later). */
async function seed(o: { keys?: PackageKey[]; kind?: "build" | "light" } = {}) {
  const s = await seedClient();
  const { onboarding } = await createOnboarding(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, kind: o.kind ?? "build", test: false, items: itemsFor(o.keys ?? ["starter_site", "care"]),
  });
  const sentAt = new Date(Date.now() - 86_400_000).toISOString();
  await markWelcomeSent(env.DB, onboarding.id, { sentAt, questionnaireDueAt: sentAt, phaseDue: { 1: sentAt, 2: sentAt } });
  return { ...s, onboardingId: onboarding.id, token: onboarding.token };
}
const itemId = async (onboardingId: string, key: string) => (await listItems(env.DB, onboardingId)).find((i) => i.key === key)!.id;

describe("the six access items", () => {
  it("a starter site includes them after the phase-1 content items", () => {
    const items = itemsFor(["starter_site", "care"]);
    const keys = items.map((i) => i.key);
    expect(keys.filter((k) => k.startsWith("access_"))).toEqual(ACCESS_KEYS);
    const firstAccess = keys.indexOf("access_hosting");
    const lastContent1 = Math.max(...items.filter((i) => i.phase === 1 && !i.key.startsWith("access_")).map((i) => keys.indexOf(i.key)));
    expect(firstAccess).toBeGreaterThan(lastContent1);
    expect(items.filter((i) => i.key.startsWith("access_")).every((i) => i.kind === "text" && i.phase === 1)).toBe(true);
    // Contiguous, and the phase-1 block comes before every phase-2 item.
    expect(keys.slice(firstAccess, firstAccess + 6)).toEqual(ACCESS_KEYS);
    expect(items.findIndex((i) => i.phase === 2)).toBeGreaterThan(firstAccess + 5);
  });

  it("care alone, quick fix and every job package include them; hourly alone and the surcharge alone do not", () => {
    for (const k of ["care", "care_plus", "care_fallback", "quick_fix", "local_seo", "local_seo_growth", "reviews_addon", "starter_site", "growth_site", "website_subscription"] as PackageKey[]) {
      expect(keysOf([k]).filter((x) => x.startsWith("access_")), k).toEqual(ACCESS_KEYS);
    }
    expect(keysOf(["quick_fix", "care"])).toEqual(ACCESS_KEYS);
    expect(itemsFor(["hourly"])).toEqual([]);
    expect(itemsFor(["client_hosted_surcharge"])).toEqual([]);
    expect(itemsFor(["hourly", "client_hosted_surcharge"])).toEqual([]);
    expect(keysOf(["hourly", "care"])).toEqual(ACCESS_KEYS);
  });

  it("the instructions name the provider, ask about adding Logan, and say never to send a password", () => {
    const items = accessOf(["care"]);
    expect(items.map((i) => i.key)).toEqual(ACCESS_KEYS);
    for (const i of items) {
      expect(i.instructions.endsWith("Do not send any password."), i.key).toBe(true);
      expect(i.instructions, i.key).toMatch(/add Logan/);
      expect(i.instructions, i.key).toMatch(/provider|company|Google|name/i);
      expect(i.label, i.key).not.toMatch(/\bDNS\b|zone|registrar/i);
      expect(i.instructions, i.key).not.toMatch(/\bDNS zone\b|nameserver/i);
    }
    expect(items[0].label).toBe("Who hosts your website?");
  });

  it("the templates stay unique by key", () => {
    const k = ITEM_TEMPLATES.map((t) => t.key);
    expect(new Set(k).size).toBe(k.length);
  });
});

describe("what the client types", () => {
  it('"password: abc" is refused by the existing answer check and nothing is stored', async () => {
    const s = await seed();
    const id = await itemId(s.onboardingId, "access_hosting");
    const res = await putText(s.token, id, "GoDaddy, password: abc");
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toContain("abc");
    expect((await listItems(env.DB, s.onboardingId)).find((i) => i.id === id)!.textValue).toBeNull();
  });

  it("the stronger secret shapes (a JWT, a key prefix) are refused for an access item", async () => {
    const s = await seed();
    const id = await itemId(s.onboardingId, "access_admin");
    for (const bad of [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP",
      "AKIAABCDEFGHIJKLMNOP",
      "sk_live_abcdefghijklmnop",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "https://admin:hunter2@example.com/wp-admin",
    ]) {
      const res = await putText(s.token, id, `Our site ${bad}`);
      expect(res.status, bad).toBe(422);
      expect(JSON.stringify(await res.json()), bad).not.toContain(bad);
    }
    expect((await listItems(env.DB, s.onboardingId)).find((i) => i.id === id)!.textValue).toBeNull();
    // A plain answer still saves.
    expect((await putText(s.token, id, "WordPress, wp-admin, I am the only admin")).status).toBe(200);
  });

  it("a content item keeps its old rules (only the access items get the stronger check)", async () => {
    const s = await seed();
    const id = await itemId(s.onboardingId, "homepage_text");
    expect((await putText(s.token, id, "We started in 1998. Call 208-555-0100 or see ghp_notreallyakeyxxxxxxxxxxxxxxxx")).status).toBe(200);
  });
});

describe("the client record", () => {
  it("shows the client's answer beside the matching access row, and null elsewhere", async () => {
    const s = await seed();
    await putText(s.token, await itemId(s.onboardingId, "access_hosting"), "  Bluehost, I can add you  ");
    await putText(s.token, await itemId(s.onboardingId, "access_gbp"), "<b>Ace</b> Plumbing profile");
    const rec = (await getClientRecord(env.DB, s.businessId, NOW))!;
    const access = rec.sites[0].access;
    expect(access.map((a) => a.key)).toEqual(["hosting", "dns", "registrar", "admin", "gbp", "analytics"]);
    const by = Object.fromEntries(access.map((a) => [a.key, a.clientAnswer]));
    expect(by).toEqual({ hosting: "Bluehost, I can add you", dns: null, registrar: null, admin: null, gbp: "<b>Ace</b> Plumbing profile", analytics: null });
  });

  it("uses the most recent onboarding when a business has several, and a client with no onboarding gets null everywhere", async () => {
    const none = await seedClient();
    expect((await getClientRecord(env.DB, none.businessId, NOW))!.sites[0].access.every((a) => a.clientAnswer === null)).toBe(true);

    const s = await seed();
    await putText(s.token, await itemId(s.onboardingId, "access_dns"), "old answer");
    // A later onboarding for the same business (one per deal, so a second deal).
    const deal2 = await createDeal(env.DB, { businessId: s.businessId, source: "manual" });
    const { onboarding: later } = await createOnboarding(env.DB, { businessId: s.businessId, dealId: deal2.id, documentId: s.documentId, kind: "light", test: false, items: itemsFor(["care"]) });
    await env.DB.prepare(`UPDATE onboardings SET created_at = '2999-01-01T00:00:00.000Z' WHERE id = ?`).bind(later.id).run();
    await env.DB.prepare(`UPDATE onboarding_items SET text_value = 'new answer' WHERE onboarding_id = ? AND key = 'access_dns'`).bind(later.id).run();
    const dns = (await getClientRecord(env.DB, s.businessId, NOW))!.sites[0].access.find((a) => a.key === "dns")!;
    expect(dns.clientAnswer).toBe("new answer");
  });

  it("an empty answer is null, and the stored status and vault fields are unchanged", async () => {
    const s = await seed();
    await putText(s.token, await itemId(s.onboardingId, "access_dns"), "   ");
    await setAccess(env.DB, s.site!.id, "dns", { vaultItem: "Cloudflare - ace", note: "n" }, NOW.toISOString());
    const dns = (await getClientRecord(env.DB, s.businessId, NOW))!.sites[0].access.find((a) => a.key === "dns")!;
    expect(dns).toMatchObject({ clientAnswer: null, vaultItem: "Cloudflare - ace", note: "n", status: "needed" });
  });
});

describe("the client's public page", () => {
  it("never carries a vault item name or an owner note", async () => {
    const s = await seed();
    await setAccess(env.DB, s.site!.id, "hosting", { vaultItem: "VAULT-NAME-Ace-Bluehost-7731", note: "OWNER-NOTE: they pay late, be careful" }, NOW.toISOString());
    await putText(s.token, await itemId(s.onboardingId, "access_hosting"), "Bluehost");
    const res = await call(`/public/o/${s.token}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Bluehost");
    expect(text).not.toContain("VAULT-NAME-Ace-Bluehost-7731");
    expect(text).not.toContain("OWNER-NOTE");
    expect(text).not.toContain("they pay late");
  });
});
