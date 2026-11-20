import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { createDraft, getDocument, signDocument } from "../src/worker/db/documents";
import { archiveSite, createSite, getSite, listAccess, listSites, updateSite } from "../src/worker/db/sites";
import type { PackageKey } from "../src/worker/db/packages";
import type { ProposalContent } from "../src/worker/documents/proposal";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { startOnboarding } from "../src/worker/onboarding/start";
import { clearProjectHooksForTests } from "../src/worker/projects/hooks";
import { startProjects } from "../src/worker/projects/start";
import { ensureSite, hostingTierFor } from "../src/worker/sites/seed";
import { seedBusiness } from "./fixtures/cro";
import { clientSig, proposal, readyToSend, seedDeal, sendDraft } from "./fixtures/documents";
import { resetProjectWork } from "./fixtures/projects";

const e = env as Env;
const FAR = "2099-01-01T00:00:00.000Z";
const NOW = new Date("2026-12-03T10:00:00.000Z");

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  clearProjectHooksForTests();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await resetProjectWork();
  await env.DB.prepare(`UPDATE sop_templates SET active = 1`).run();
});
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); setMailDeps(null); });

const lines = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const seed = (businessId: string, packageKeys: PackageKey[], test = false) => ensureSite(env.DB, { businessId, packageKeys, test });

describe("hostingTierFor", () => {
  it("client_hosted_surcharge wins; a build or Care means Logan hosts; anything else is unknown", () => {
    expect(hostingTierFor(["starter_site", "client_hosted_surcharge"])).toBe("client_hosted");
    expect(hostingTierFor(["starter_site"])).toBe("logan_hosted");
    expect(hostingTierFor(["growth_site"])).toBe("logan_hosted");
    expect(hostingTierFor(["website_subscription"])).toBe("logan_hosted");
    expect(hostingTierFor(["care"])).toBe("logan_hosted");
    expect(hostingTierFor(["care_plus"])).toBe("logan_hosted");
    expect(hostingTierFor(["care_fallback"])).toBe("logan_hosted");
    expect(hostingTierFor(["quick_fix"])).toBe("unknown");
    expect(hostingTierFor(["local_seo", "hourly"])).toBe("unknown");
    expect(hostingTierFor([])).toBe("unknown");
  });
});

describe("ensureSite", () => {
  it("a signed starter site seeds one primary site with the business's domain and logan_hosted", async () => {
    const b = await seedBusiness({ websiteUrl: "https://www.ace.com/about" });
    const r = (await seed(b.id, ["starter_site", "care"]))!;
    expect(r.created).toBe(true);
    expect(r.site).toMatchObject({ businessId: b.id, seedKey: "primary", url: "https://www.ace.com/about", domain: "ace.com", hostingTier: "logan_hosted", test: false, archivedAt: null });
    expect(await listAccess(env.DB, r.site.id)).toHaveLength(6);
    expect(await lines(b.id, "site_added")).toEqual(["Site record made for ace.com"]);
  });

  it("client_hosted_surcharge in the packages seeds client_hosted", async () => {
    const b = await seedBusiness();
    const r = (await seed(b.id, ["starter_site", "client_hosted_surcharge"]))!;
    expect(r.site.hostingTier).toBe("client_hosted");
  });

  it("a business with no website still gets a site, with null url and domain", async () => {
    const b = await seedBusiness({ websiteUrl: null });
    const r = (await seed(b.id, ["starter_site"]))!;
    expect(r.created).toBe(true);
    expect(r.site).toMatchObject({ seedKey: "primary", url: null, domain: null });
    expect(await lines(b.id, "site_added")).toEqual(["Site record made for a new site"]);
  });

  it("a website address with a login in it is stored without the login", async () => {
    const b = await seedBusiness({ websiteUrl: "https://u:hunter2@ace.com/" });
    const r = (await seed(b.id, ["starter_site"]))!;
    expect(r.site).toMatchObject({ domain: "ace.com", url: "https://ace.com/" });
    expect(JSON.stringify(await listSites(env.DB, { businessId: b.id }))).not.toContain("hunter2");
  });

  it("calling ensureSite twice leaves one site and one site_added line", async () => {
    const b = await seedBusiness();
    const a = (await seed(b.id, ["starter_site"]))!;
    const again = (await seed(b.id, ["starter_site"]))!;
    expect(again.created).toBe(false);
    expect(again.site.id).toBe(a.site.id);
    expect(await listSites(env.DB, { businessId: b.id, includeArchived: true })).toHaveLength(1);
    expect(await lines(b.id, "site_added")).toHaveLength(1);
  });

  it("two ensureSite calls at once leave one site", async () => {
    const b = await seedBusiness();
    const [x, y] = await Promise.all([seed(b.id, ["starter_site"]), seed(b.id, ["starter_site"])]);
    expect(x!.site.id).toBe(y!.site.id);
    expect([x!.created, y!.created].filter(Boolean)).toHaveLength(1);
    expect(await listSites(env.DB, { businessId: b.id, includeArchived: true })).toHaveLength(1);
    expect(await lines(b.id, "site_added")).toHaveLength(1);
  });

  it("a real document after a test one turns the site real (test 0)", async () => {
    const b = await seedBusiness();
    expect((await seed(b.id, ["starter_site"], true))!.site.test).toBe(true);
    const real = (await seed(b.id, ["starter_site"], false))!;
    expect(real.created).toBe(false);
    expect(real.site.test).toBe(false);
    expect((await getSite(env.DB, real.site.id))!.test).toBe(false);
  });

  it("a test document after a real one leaves it real", async () => {
    const b = await seedBusiness();
    const a = (await seed(b.id, ["starter_site"], false))!;
    const later = (await seed(b.id, ["starter_site"], true))!;
    expect(later.site.id).toBe(a.site.id);
    expect(later.site.test).toBe(false);
  });

  it("an owner-edited hosting tier is not overwritten by a later seed, but an unknown tier is filled", async () => {
    const b = await seedBusiness();
    const first = (await seed(b.id, ["quick_fix"]))!;
    expect(first.site.hostingTier).toBe("unknown");
    const filled = (await seed(b.id, ["starter_site"]))!;
    expect(filled.site.hostingTier).toBe("logan_hosted");

    await updateSite(env.DB, filled.site.id, { hostingTier: "client_hosted" }, "2026-12-03T10:00:00.000Z");
    const kept = (await seed(b.id, ["starter_site"]))!;
    expect(kept.site.hostingTier).toBe("client_hosted");
    expect((await getSite(env.DB, filled.site.id))!.hostingTier).toBe("client_hosted");
  });

  it("a hand-added site for the same domain is adopted as the primary and no second site is made", async () => {
    const b = await seedBusiness({ websiteUrl: "https://ace.com" });
    const hand = (await createSite(env.DB, { businessId: b.id, url: "https://www.ace.com/", notes: "added by hand" })).site;
    const r = (await seed(b.id, ["starter_site"]))!;
    expect(r.created).toBe(false);
    expect(r.site).toMatchObject({ id: hand.id, seedKey: "primary", notes: "added by hand", hostingTier: "logan_hosted" });
    expect(await listSites(env.DB, { businessId: b.id, includeArchived: true })).toHaveLength(1);
    expect(await lines(b.id, "site_added")).toEqual([]);
    expect((await seed(b.id, ["starter_site"]))!.site.id).toBe(hand.id);
  });

  it("an archived primary is left alone and no new site is made", async () => {
    const b = await seedBusiness();
    const a = (await seed(b.id, ["starter_site"]))!;
    await archiveSite(env.DB, a.site.id, "2026-12-03T10:00:00.000Z");
    const r = (await seed(b.id, ["starter_site"]))!;
    expect(r.created).toBe(false);
    expect(r.site.id).toBe(a.site.id);
    expect(r.site.archivedAt).not.toBeNull();
    expect(await listSites(env.DB, { businessId: b.id, includeArchived: true })).toHaveLength(1);
  });

  it("a failure returns null, logs one plain line, and echoes nothing", async () => {
    const b = await seedBusiness({ websiteUrl: "https://secret-client-name.example" });
    expect(await ensureSite(env.DB, { businessId: "no-such-business", packageKeys: ["starter_site"], test: false })).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    const [first, ...rest] = errors.mock.calls[0];
    expect(first).toBe("sites: not seeded");
    expect(rest).toHaveLength(1);
    expect(typeof rest[0]).toBe("string");
    expect(String(rest[0])).not.toContain("secret-client-name");
    expect(await listSites(env.DB, { businessId: b.id })).toEqual([]);
  });
});

// ---- the two places a sale seeds a site ----

type Pkg = ProposalContent["packages"][number];
const pkg = (key: Pkg["key"], name: string): Pkg => ({ key, version: 1, name, priceLine: "$1,000", includes: [] });

/** A signed proposal for a lead (real or test), with its business's website as the site to be. */
async function signed(o: { test?: boolean; packages?: Pkg[] } = {}) {
  const s = await seedDeal();
  const base = proposal();
  const content: ProposalContent = { ...base, packages: o.packages ?? [pkg("starter_site", "Starter Site"), pkg("care", "Care")] };
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content, test: o.test });
  const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: FAR });
  expect(await signDocument(env.DB, doc.id, clientSig(hash), "2026-12-02T09:00:00.000Z")).toBe("signed");
  return { ...s, doc: (await getDocument(env.DB, doc.id))! };
}

/** Makes every insert into `sites` fail, so a seed fails after the rest of the start worked. Undo with the returned function. */
async function breakSites() {
  await env.DB.prepare(`CREATE TRIGGER sites_break BEFORE INSERT ON sites BEGIN SELECT RAISE(ABORT, 'sites are broken'); END`).run();
  return () => env.DB.prepare(`DROP TRIGGER IF EXISTS sites_break`).run();
}

describe("seeding from a sale", () => {
  it("startOnboarding on a signed proposal seeds the site", async () => {
    await readyToSend();
    const s = await signed();
    expect(await startOnboarding(e, s.doc)).not.toBeNull();
    const sites = await listSites(env.DB, { businessId: s.businessId });
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ seedKey: "primary", domain: "ace.com", hostingTier: "logan_hosted", test: false });
    expect(await lines(s.businessId, "site_added")).toEqual(["Site record made for ace.com"]);
  });

  it("a test onboarding seeds a test site", async () => {
    await readyToSend();
    const s = await signed({ test: true });
    expect(await startOnboarding(e, s.doc, { test: true })).not.toBeNull();
    expect((await listSites(env.DB, { businessId: s.businessId }))[0].test).toBe(true);
  });

  it("a project start seeds the site when onboarding did not", async () => {
    const s = await signed();
    expect((await startProjects(e, s.doc, { now: NOW })).length).toBeGreaterThan(0);
    const sites = await listSites(env.DB, { businessId: s.businessId });
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ seedKey: "primary", domain: "ace.com", hostingTier: "logan_hosted", test: false });
    // Onboarding after the projects finds the site and makes no second one.
    await readyToSend();
    await startOnboarding(e, s.doc);
    expect(await listSites(env.DB, { businessId: s.businessId })).toHaveLength(1);
    expect(await lines(s.businessId, "site_added")).toHaveLength(1);
  });

  it("a failing seed never fails the onboarding or the project start", async () => {
    await readyToSend();
    const s = await signed();
    const undo = await breakSites();
    try {
      expect(await startOnboarding(e, s.doc)).not.toBeNull();
      expect((await startProjects(e, s.doc, { now: NOW })).length).toBeGreaterThan(0);
    } finally { await undo(); }
    expect(await listSites(env.DB, { businessId: s.businessId, includeArchived: true })).toEqual([]);
    const seedErrors = errors.mock.calls.filter((c: unknown[]) => c[0] === "sites: not seeded");
    expect(seedErrors).toHaveLength(2);
    // Nothing is lost: with the fault gone the next start seeds the site.
    expect((await startProjects(e, s.doc, { now: NOW })).length).toBeGreaterThan(0);
    expect(await listSites(env.DB, { businessId: s.businessId })).toHaveLength(1);
  });
});
