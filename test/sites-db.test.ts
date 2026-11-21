import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getBusiness } from "../src/worker/db/businesses";
import {
  ACCESS_KEYS, adoptAsPrimary, archiveSite, createSite, getSite, hasSite, listAccess, listSites, setAccess, SiteConflictError, updateSite,
} from "../src/worker/db/sites";
import { seedBusiness } from "./fixtures/cro";

const T0 = "2026-12-03T10:00:00.000Z";
const T1 = "2026-12-03T11:00:00.000Z";
const T2 = "2026-12-03T12:00:00.000Z";
const T3 = "2026-12-03T13:00:00.000Z";

describe("sites db", () => {
  it("createSite makes the site and exactly six needed items", async () => {
    const b = await seedBusiness();
    const { site, created } = await createSite(env.DB, { businessId: b.id, url: "https://www.Ace.com/about", cms: "wordpress" });
    expect(created).toBe(true);
    expect(site).toMatchObject({
      businessId: b.id, seedKey: null, url: "https://www.Ace.com/about", domain: "ace.com", cms: "wordpress", hostProvider: null, registrar: null, dnsProvider: null,
      adminUrl: null, hostingTier: "unknown", accessMethod: "unknown", notes: null, test: false, archivedAt: null,
    });
    expect(site.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await getSite(env.DB, site.id)).toEqual(site);
    const items = await listAccess(env.DB, site.id);
    expect(items.map((i) => i.key)).toEqual([...ACCESS_KEYS]);
    for (const i of items) {
      expect(i).toMatchObject({ siteId: site.id, status: "needed", vaultItem: null, note: null, requestedAt: null, receivedAt: null, verifiedAt: null });
    }
    expect(await getSite(env.DB, "nope")).toBeNull();
  });

  it("a seeded site is created once and a second call returns it with created false", async () => {
    const b = await seedBusiness();
    const a = await createSite(env.DB, { businessId: b.id, seedKey: "primary", url: "https://ace.com" });
    expect(a.created).toBe(true);
    expect(a.site.seedKey).toBe("primary");
    const again = await createSite(env.DB, { businessId: b.id, seedKey: "primary", url: "https://other.com", notes: "ignored" });
    expect(again.created).toBe(false);
    expect(again.site).toEqual(a.site);
    expect((await listSites(env.DB, { businessId: b.id })).length).toBe(1);
    expect((await listAccess(env.DB, a.site.id)).length).toBe(6);
    const other = await seedBusiness();
    expect((await createSite(env.DB, { businessId: other.id, seedKey: "primary" })).created).toBe(true);
  });

  it("two hand-added sites for one business are allowed", async () => {
    const b = await seedBusiness();
    const a = await createSite(env.DB, { businessId: b.id, url: "https://one.com" });
    const c = await createSite(env.DB, { businessId: b.id, url: "https://two.com" });
    const d = await createSite(env.DB, { businessId: b.id });
    const e = await createSite(env.DB, { businessId: b.id });
    expect(new Set([a.site.id, c.site.id, d.site.id, e.site.id]).size).toBe(4);
    expect((await listSites(env.DB, { businessId: b.id })).length).toBe(4);
  });

  it("a duplicate domain on the same business is refused (a plain error, not a crash)", async () => {
    const b = await seedBusiness();
    const a = await createSite(env.DB, { businessId: b.id, url: "https://ace.com" });
    await expect(createSite(env.DB, { businessId: b.id, url: "http://www.ace.com/contact" })).rejects.toBeInstanceOf(SiteConflictError);
    const c = await createSite(env.DB, { businessId: b.id, url: "https://other.com" });
    await expect(updateSite(env.DB, c.site.id, { url: "https://ace.com" }, T1)).rejects.toBeInstanceOf(SiteConflictError);
    expect((await getSite(env.DB, c.site.id))!.domain).toBe("other.com");
    // Another business may hold the same domain, and an archived site frees it.
    const other = await seedBusiness();
    expect((await createSite(env.DB, { businessId: other.id, url: "https://ace.com" })).created).toBe(true);
    expect(await archiveSite(env.DB, a.site.id, T1)).toBe(true);
    expect((await createSite(env.DB, { businessId: b.id, url: "https://ace.com" })).created).toBe(true);
  });

  it("updateSite changes only what is given and re-derives the domain from a new url", async () => {
    const b = await seedBusiness();
    const { site } = await createSite(env.DB, { businessId: b.id, url: "https://ace.com", notes: "first" });
    const up = await updateSite(env.DB, site.id, { url: "https://new.example.org/x", cms: "webflow", notes: null }, T1);
    expect(up).toMatchObject({ url: "https://new.example.org/x", domain: "new.example.org", cms: "webflow", notes: null, updatedAt: T1, createdAt: site.createdAt });
    expect(await updateSite(env.DB, "nope", { cms: "wix" }, T1)).toBeNull();
    expect((await updateSite(env.DB, site.id, {}, T2))!.updatedAt).toBe(T1);
  });

  it("setAccess to requested stamps requested_at, to received stamps received_at, to verified stamps verified_at", async () => {
    const b = await seedBusiness();
    const { site } = await createSite(env.DB, { businessId: b.id });
    const r = await setAccess(env.DB, site.id, "dns", { status: "requested", note: "asked by email" }, T0);
    expect(r).toMatchObject({ siteId: site.id, key: "dns", status: "requested", note: "asked by email", vaultItem: null, requestedAt: T0, receivedAt: null, verifiedAt: null, updatedAt: T0 });
    const rc = await setAccess(env.DB, site.id, "dns", { status: "received", vaultItem: "Ace Plumbing - Cloudflare" }, T1);
    expect(rc).toMatchObject({ status: "received", vaultItem: "Ace Plumbing - Cloudflare", note: "asked by email", requestedAt: T0, receivedAt: T1, verifiedAt: null, updatedAt: T1 });
    const v = await setAccess(env.DB, site.id, "dns", { status: "verified" }, T2);
    expect(v).toMatchObject({ status: "verified", requestedAt: T0, receivedAt: T1, verifiedAt: T2, updatedAt: T2 });
    // A note-only change leaves status and stamps alone; null clears a field.
    const n = await setAccess(env.DB, site.id, "dns", { note: null }, T3);
    expect(n).toMatchObject({ status: "verified", note: null, vaultItem: "Ace Plumbing - Cloudflare", requestedAt: T0, receivedAt: T1, verifiedAt: T2, updatedAt: T3 });
    // Jumping straight to verified still records when it was received.
    const j = await setAccess(env.DB, site.id, "admin", { status: "verified" }, T1);
    expect(j).toMatchObject({ requestedAt: null, receivedAt: T1, verifiedAt: T1 });
    // The other five items are untouched.
    expect((await listAccess(env.DB, site.id)).filter((i) => i.status === "needed").length).toBe(4);
  });

  it("moving verified back to requested clears received_at and verified_at but keeps requested_at", async () => {
    const b = await seedBusiness();
    const { site } = await createSite(env.DB, { businessId: b.id });
    await setAccess(env.DB, site.id, "hosting", { status: "requested" }, T0);
    await setAccess(env.DB, site.id, "hosting", { status: "received" }, T1);
    await setAccess(env.DB, site.id, "hosting", { status: "verified" }, T2);
    const back = await setAccess(env.DB, site.id, "hosting", { status: "requested" }, T3);
    expect(back).toMatchObject({ status: "requested", requestedAt: T0, receivedAt: null, verifiedAt: null, updatedAt: T3 });
    // Verified back to received keeps received_at and clears only verified_at.
    await setAccess(env.DB, site.id, "hosting", { status: "received" }, T1);
    await setAccess(env.DB, site.id, "hosting", { status: "verified" }, T2);
    const half = await setAccess(env.DB, site.id, "hosting", { status: "received" }, T3);
    expect(half).toMatchObject({ status: "received", requestedAt: T0, receivedAt: T1, verifiedAt: null });
    // Not applicable clears the received and verified stamps too.
    const na = await setAccess(env.DB, site.id, "hosting", { status: "not_applicable" }, T3);
    expect(na).toMatchObject({ status: "not_applicable", requestedAt: T0, receivedAt: null, verifiedAt: null });
  });

  it("setAccess on an unknown site or key returns null", async () => {
    const b = await seedBusiness();
    const { site } = await createSite(env.DB, { businessId: b.id });
    expect(await setAccess(env.DB, "nope", "dns", { status: "requested" }, T0)).toBeNull();
    expect(await setAccess(env.DB, site.id, "email" as never, { status: "requested" }, T0)).toBeNull();
    await expect(setAccess(env.DB, site.id, "dns", { status: "bogus" as never }, T0)).rejects.toBeInstanceOf(RangeError);
  });

  it("archiveSite hides the site from listSites unless includeArchived", async () => {
    const b = await seedBusiness();
    const keep = await createSite(env.DB, { businessId: b.id, url: "https://keep.com" });
    const gone = await createSite(env.DB, { businessId: b.id, url: "https://gone.com" });
    expect(await archiveSite(env.DB, gone.site.id, T1)).toBe(true);
    expect(await archiveSite(env.DB, gone.site.id, T2)).toBe(false);
    expect(await archiveSite(env.DB, "nope", T2)).toBe(false);
    expect((await listSites(env.DB, { businessId: b.id })).map((s) => s.id)).toEqual([keep.site.id]);
    expect((await listSites(env.DB, { businessId: b.id, includeArchived: true })).map((s) => s.id)).toEqual([keep.site.id, gone.site.id]);
    expect((await getSite(env.DB, gone.site.id))!.archivedAt).toBe(T1);
  });

  it("hasSite is true for an archived site too", async () => {
    const b = await seedBusiness();
    expect(await hasSite(env.DB, b.id)).toBe(false);
    const { site } = await createSite(env.DB, { businessId: b.id });
    expect(await hasSite(env.DB, b.id)).toBe(true);
    await archiveSite(env.DB, site.id, T1);
    expect(await hasSite(env.DB, b.id)).toBe(true);
  });
});

describe("adoptAsPrimary", () => {
  it("makes a hand-added live site the primary, once, and only when the business has no primary", async () => {
    const b = await seedBusiness();
    const hand = (await createSite(env.DB, { businessId: b.id, url: "https://ace.com" })).site;
    const other = (await createSite(env.DB, { businessId: b.id, url: "https://other.com" })).site;
    const adopted = (await adoptAsPrimary(env.DB, hand.id, T1))!;
    expect(adopted).toMatchObject({ id: hand.id, seedKey: "primary", updatedAt: T1 });
    expect(await adoptAsPrimary(env.DB, other.id, T2)).toBeNull(); // the business has a primary now
    expect((await getSite(env.DB, other.id))!.seedKey).toBeNull();
    expect(await adoptAsPrimary(env.DB, hand.id, T3)).toBeNull(); // already the primary
  });

  it("refuses an archived site and an unknown one", async () => {
    const b = await seedBusiness();
    const { site } = await createSite(env.DB, { businessId: b.id, url: "https://ace.com" });
    await archiveSite(env.DB, site.id, T1);
    expect(await adoptAsPrimary(env.DB, site.id, T2)).toBeNull();
    expect(await adoptAsPrimary(env.DB, "nope", T2)).toBeNull();
  });
});

describe("lead delete with a site", () => {
  it("the lead delete route refuses a lead that has a site, archived or not", async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    const b = await seedBusiness();
    const { site } = await createSite(env.DB, { businessId: b.id });
    await archiveSite(env.DB, site.id, T1);
    const res = await SELF.fetch(`https://x/api/leads/${b.id}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "this lead has a site record" });
    expect(await getBusiness(env.DB, b.id)).not.toBeNull();
  });
});
