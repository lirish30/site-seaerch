import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WP_ARG } from "../src/worker/care/args";
import { availableFor, getInventory } from "../src/worker/db/careUpdates";
import { HelperRefused, getHelperKind } from "../src/worker/helper/kinds";
import { seedClient } from "./fixtures/clients";

const KIND = "care.inventory";
const def = () => getHelperKind(KIND)!;

/** The same accept/refuse table as helper/test/care-wp.test.ts. */
const HOSTILE = ["x; rm -rf ~", "$(id)", "`id`", "a b", "a\nb", "../etc", "/var/../etc"];

async function careSite(o: { test?: boolean } = {}) {
  const s = await seedClient({ test: o.test, subs: [{ key: "care", monthlyCents: 5000, test: o.test }] });
  await env.DB.prepare(`UPDATE sites SET cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = 'ace-host', wp_path = '/var/www/ace' WHERE id = ?`).bind(s.site!.id).run();
  return s;
}
const payload = (siteId: string, o: Record<string, unknown> = {}) => ({ siteId, batchId: "batch-1", alias: "ace-host", path: "/var/www/ace", ...o });
const item = (o: Record<string, unknown> = {}) => ({ slug: "akismet", name: "Akismet", status: "active", version: "5.0", updateVersion: "5.1", fromWporg: true, ...o });
const result = (o: Record<string, unknown> = {}) => ({
  wpVersion: "6.4.1", phpVersion: "8.2.1", core: { to: "6.5" },
  plugins: [item(), item({ slug: "pro-thing", name: "Pro Thing", version: "1.0", updateVersion: "1.1", fromWporg: false }), item({ slug: "hello", status: "inactive", updateVersion: null, fromWporg: false })],
  themes: [item({ slug: "twentytwentyfour", status: "active", version: "1.0", updateVersion: null, fromWporg: false })], activeTheme: "twentytwentyfour", ...o,
});
const parse = (o: Record<string, unknown>) => def().result.parse(o);

describe("care.inventory payload", () => {
  it("takes a good one and gives it no inputs or outputs", () => {
    const p = def().payload.parse(payload("s1"));
    expect(def().inputs(p)).toEqual([]);
    expect(def().outputs(p)).toEqual([]);
  });

  it.each(HOSTILE)("refuses %j as the alias or the path", (bad) => {
    expect(def().payload.safeParse(payload("s1", { alias: bad })).success).toBe(false);
    expect(def().payload.safeParse(payload("s1", { path: bad })).success).toBe(false);
  });

  it("uses the shared patterns", () => {
    for (const v of HOSTILE) expect(Object.values(WP_ARG).some((re) => re.test(v))).toBe(false);
  });
});

describe("care.inventory result", () => {
  it.each(HOSTILE)("refuses %j as a slug, an update version or the core version", (bad) => {
    expect(def().result.safeParse(result({ plugins: [item({ slug: bad })] })).success).toBe(false);
    expect(def().result.safeParse(result({ plugins: [item({ updateVersion: bad })] })).success).toBe(false);
    expect(def().result.safeParse(result({ core: { to: bad } })).success).toBe(false);
  });

  it("trims every string to 200 characters and caps the lists", () => {
    const r = parse(result({ phpVersion: `  ${"9".repeat(300)}  `, plugins: [item({ name: "n".repeat(500) })] }));
    expect(r.phpVersion).toHaveLength(200);
    expect(r.plugins[0].name).toHaveLength(200);
    expect(def().result.safeParse(result({ plugins: Array.from({ length: 301 }, (_, i) => item({ slug: `p${i}` })) })).success).toBe(false);
    expect(def().result.safeParse(result({ themes: Array.from({ length: 51 }, (_, i) => item({ slug: `t${i}` })) })).success).toBe(false);
  });
});

describe("care.inventory apply", () => {
  it("stores the inventory and the available updates with their risks", async () => {
    const s = await careSite();
    await def().apply(env, def().payload.parse(payload(s.site!.id)), parse(result()));
    const inv = await getInventory(env.DB, s.site!.id);
    expect(inv).toMatchObject({ wpVersion: "6.4.1", phpVersion: "8.2.1", groupKey: "brochure" });
    expect(inv!.plugins).toEqual(["akismet", "pro-thing"]);
    const ups = await availableFor(env.DB, s.site!.id);
    expect(ups.map((u) => [u.type, u.slug, u.fromVersion, u.toVersion, u.risk, u.rollbackable])).toEqual([
      ["core", "wordpress", "6.4.1", "6.5", "major", true],
      ["plugin", "akismet", "5.0", "5.1", "mild", true],
      ["plugin", "pro-thing", "1.0", "1.1", "mild", false],
    ]);
    expect(ups).toHaveLength(3);
  });

  it("a second apply with one fewer update marks it gone", async () => {
    const s = await careSite();
    const p = def().payload.parse(payload(s.site!.id));
    await def().apply(env, p, parse(result()));
    await def().apply(env, p, parse(result({ plugins: [item()] })));
    expect((await availableFor(env.DB, s.site!.id)).map((u) => u.slug)).toEqual(["wordpress", "akismet"]);
    expect((await env.DB.prepare(`SELECT status FROM care_updates WHERE slug = 'pro-thing' AND site_id = ?`).bind(s.site!.id).first<{ status: string }>())!.status).toBe("gone");
  });

  it("refuses a result for an archived site, a missing site or a site without Care", async () => {
    const s = await careSite();
    await env.DB.prepare(`UPDATE sites SET archived_at = '2027-01-01T00:00:00.000Z' WHERE id = ?`).bind(s.site!.id).run();
    await expect(def().apply(env, def().payload.parse(payload(s.site!.id)), parse(result()))).rejects.toThrow(HelperRefused);
    await expect(def().apply(env, def().payload.parse(payload("nope")), parse(result()))).rejects.toThrow(HelperRefused);
    expect(await getInventory(env.DB, s.site!.id)).toBeNull();
  });

  it("accepts a test site, because a single-site rehearsal may target one", async () => {
    const s = await careSite({ test: true });
    await def().apply(env, def().payload.parse(payload(s.site!.id)), parse(result()));
    expect((await availableFor(env.DB, s.site!.id)).length).toBe(3);
  });

  it("skips an update whose current version is not a safe version string", async () => {
    const s = await careSite();
    await def().apply(env, def().payload.parse(payload(s.site!.id)), parse(result({ core: null, plugins: [item({ version: "1.0 beta" })] })));
    expect(await availableFor(env.DB, s.site!.id)).toEqual([]);
  });
});

describe("care.inventory failure", () => {
  it("tells the batch on fail and on expire without throwing (onInventoryDone is Task 7's stub for now)", async () => {
    const p = def().payload.parse(payload("s1"));
    await expect(def().onFail!(env, p, "boom")).resolves.toBeUndefined();
    await expect(def().onExpire!(env, p)).resolves.toBeUndefined();
  });
});
