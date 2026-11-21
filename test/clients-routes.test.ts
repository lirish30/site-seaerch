import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { getSite, listAccess, listSites } from "../src/worker/db/sites";
import { seedClient } from "./fixtures/clients";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
const call = (method: string, path: string, body?: unknown, o: { auth?: boolean } = {}) =>
  SELF.fetch(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(o.auth === false ? {} : { cookie }), "content-type": "application/json" } });

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => errors.mockRestore());

const VAULT = "Acme GoDaddy";
const lines = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId, 200)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");

describe("auth and reads", () => {
  it("every client route needs the owner's session", async () => {
    const s = await seedClient();
    expect((await call("GET", "/api/clients", undefined, { auth: false })).status).toBe(401);
    expect((await call("GET", `/api/clients/${s.businessId}`, undefined, { auth: false })).status).toBe(401);
    expect((await call("PUT", `/api/sites/${s.site!.id}/access/hosting`, { status: "received" }, { auth: false })).status).toBe(401);
  });

  it("GET /clients lists clients and ?test=1 adds the rehearsal ones", async () => {
    const real = await seedClient({ subs: [{ monthlyCents: 49700 }] });
    const test = await seedClient({ test: true });
    const plain = await seedClient({ won: false, project: false });
    const ids = ((await (await call("GET", "/api/clients")).json()) as { clients: { id: string }[] }).clients.map((c) => c.id);
    expect(ids).toContain(real.businessId);
    expect(ids).not.toContain(test.businessId);
    expect(ids).not.toContain(plain.businessId);
    const all = ((await (await call("GET", "/api/clients?test=1")).json()) as { clients: { id: string; mrrCents: number }[] }).clients;
    expect(all.map((c) => c.id)).toContain(test.businessId);
    expect(all.find((c) => c.id === real.businessId)!.mrrCents).toBe(49700);
  });

  it("GET /clients/:id is 404 for an unknown id and for a lead that is not a client", async () => {
    const plain = await seedClient({ won: false, project: false });
    expect((await call("GET", `/api/clients/${plain.businessId}`)).status).toBe(404);
    expect((await call("GET", "/api/clients/nope")).status).toBe(404);
  });
});

describe("PUT access", () => {
  it('with status received and vaultItem "Acme GoDaddy" saves it and logs "Hosting: received" without the name', async () => {
    const s = await seedClient();
    const res = await call("PUT", `/api/sites/${s.site!.id}/access/hosting`, { status: "received", vaultItem: VAULT, note: "Dana invited me as an editor." });
    expect(res.status).toBe(200);
    const { item } = (await res.json()) as { item: { status: string; vaultItem: string; receivedAt: string | null } };
    expect(item).toMatchObject({ status: "received", vaultItem: VAULT });
    expect(item.receivedAt).not.toBeNull();
    expect((await listAccess(env.DB, s.site!.id)).find((i) => i.key === "hosting")).toMatchObject({ vaultItem: VAULT, note: "Dana invited me as an editor." });
    expect(await lines(s.businessId, "access_changed")).toEqual(["Hosting: received"]);
    expect(JSON.stringify(await listActivity(env.DB, s.businessId, 200))).not.toContain("GoDaddy");
  });

  it("the raw JSON of GET /clients/:id is the only place the vault name appears: not in the activity array, the list or any error", async () => {
    const s = await seedClient();
    await call("PUT", `/api/sites/${s.site!.id}/access/dns`, { status: "received", vaultItem: VAULT, note: "Owner is Dana." });
    await call("PUT", `/api/sites/${s.site!.id}/access/dns`, { vaultItem: "Acme Cloudflare" });
    const raw = await (await call("GET", `/api/clients/${s.businessId}`)).text();
    const rec = JSON.parse(raw) as { client: { activity: { kind: string; detail: string }[]; sites: { access: { key: string; vaultItem: string | null }[] }[] } };
    expect(rec.client.sites[0].access.find((i) => i.key === "dns")!.vaultItem).toBe("Acme Cloudflare");
    expect(raw).toContain("Acme Cloudflare");
    expect(JSON.stringify(rec.client.activity)).not.toContain("Cloudflare");
    expect(JSON.stringify(rec.client.activity)).not.toContain("Dana");
    expect(rec.client.activity.filter((a) => a.kind === "access_changed").map((a) => a.detail).sort()).toEqual(["DNS: details updated", "DNS: received"]);
    expect(await (await call("GET", "/api/clients")).text()).not.toContain("Cloudflare");
    expect(await (await call("GET", "/api/clients?test=1")).text()).not.toContain("Cloudflare");
    expect(errors).not.toHaveBeenCalled();
  });

  it('with vaultItem "password: x" is a 400, nothing changes, and the error text does not contain the input', async () => {
    const s = await seedClient();
    const before = await listAccess(env.DB, s.site!.id);
    const res = await call("PUT", `/api/sites/${s.site!.id}/access/hosting`, { status: "received", vaultItem: "password: x" });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("password: x");
    expect(text).not.toContain("x\"");
    expect(JSON.parse(text).fields.vaultItem[0]).toBe("That looks like a login or a key. Type only the name of the password manager item.");
    expect(await listAccess(env.DB, s.site!.id)).toEqual(before);
    expect(await lines(s.businessId, "access_changed")).toEqual([]);
  });

  it("refuses a key, a link and an over-long name, and a secret in the note, with sentences that never repeat them", async () => {
    const s = await seedClient();
    const bad: [Record<string, unknown>, string][] = [
      [{ vaultItem: "sk_live_51Habc123def456" }, "sk_live_51Habc123def456"],
      [{ vaultItem: "https://admin:pw@acme.com/" }, "admin:pw"],
      [{ vaultItem: "https://acme.com/wp-admin" }, "wp-admin"],
      [{ vaultItem: "a".repeat(81) }, "aaaaaaaaaa"],
      [{ note: "login = dana / hunter2" }, "hunter2"],
      [{ note: "n".repeat(501) }, "nnnnnnnnnn"],
    ];
    for (const [body, echoed] of bad) {
      const res = await call("PUT", `/api/sites/${s.site!.id}/access/admin`, body);
      expect(res.status, JSON.stringify(Object.keys(body))).toBe(400);
      expect(await res.text()).not.toContain(echoed);
    }
    expect((await listAccess(env.DB, s.site!.id)).find((i) => i.key === "admin")).toMatchObject({ vaultItem: null, note: null, status: "needed" });
  });

  it("cleans a vault name before it is stored, clears it with an empty string or null, and keeps it when it is left out", async () => {
    const s = await seedClient();
    const put = (b: unknown) => call("PUT", `/api/sites/${s.site!.id}/access/registrar`, b);
    await put({ vaultItem: "  Acme‮ GoDaddy\u0007 " });
    expect((await listAccess(env.DB, s.site!.id)).find((i) => i.key === "registrar")!.vaultItem).toBe("Acme GoDaddy");
    await put({ status: "requested" });
    expect((await listAccess(env.DB, s.site!.id)).find((i) => i.key === "registrar")).toMatchObject({ vaultItem: "Acme GoDaddy", status: "requested" });
    await put({ vaultItem: "" });
    expect((await listAccess(env.DB, s.site!.id)).find((i) => i.key === "registrar")!.vaultItem).toBeNull();
    await put({ vaultItem: "Acme GoDaddy" });
    await put({ vaultItem: null });
    expect((await listAccess(env.DB, s.site!.id)).find((i) => i.key === "registrar")!.vaultItem).toBeNull();
  });

  it("refuses an unknown status, an empty body, an extra field and an unknown key", async () => {
    const s = await seedClient();
    expect((await call("PUT", `/api/sites/${s.site!.id}/access/hosting`, { status: "done" })).status).toBe(400);
    expect((await call("PUT", `/api/sites/${s.site!.id}/access/hosting`, {})).status).toBe(400);
    expect((await call("PUT", `/api/sites/${s.site!.id}/access/hosting`, { status: "received", password: "x" })).status).toBe(400);
    expect((await call("PUT", `/api/sites/${s.site!.id}/access/billing`, { status: "received" })).status).toBe(404);
    expect((await call("PUT", "/api/sites/nope/access/hosting", { status: "received" })).status).toBe(404);
  });

  it("logs the status word for every move and leaves the vault name out of each", async () => {
    const s = await seedClient();
    for (const status of ["requested", "received", "verified", "not_applicable"]) await call("PUT", `/api/sites/${s.site!.id}/access/gbp`, { status, vaultItem: VAULT });
    expect((await lines(s.businessId, "access_changed")).sort()).toEqual(["Google Business Profile: not applicable", "Google Business Profile: received", "Google Business Profile: requested", "Google Business Profile: verified"]);
  });
});

describe("site fields", () => {
  it('PATCH a site with url "javascript:alert(1)" or adminUrl "data:text/html,x" is a 400', async () => {
    const s = await seedClient();
    for (const body of [{ url: "javascript:alert(1)" }, { adminUrl: "data:text/html,x" }, { url: "ftp://ace.com" }, { adminUrl: "/wp-admin" }, { url: "not a url" }]) {
      const res = await call("PATCH", `/api/sites/${s.site!.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.text()).not.toContain("alert");
    }
    expect(await getSite(env.DB, s.site!.id)).toMatchObject({ url: "https://ace.com", adminUrl: null });
  });

  it("a login inside a site or admin address is a 400 on PATCH and on add, and the answer never repeats it", async () => {
    const s = await seedClient();
    const before = await getSite(env.DB, s.site!.id);
    for (const body of [{ url: "https://u:p@host.com/" }, { adminUrl: "https://u:p@host.com/wp-admin" }, { adminUrl: "https://:pw@host.com/" }, { url: "http://admin@host.com/" }]) {
      for (const res of [await call("PATCH", `/api/sites/${s.site!.id}`, body), await call("POST", `/api/clients/${s.businessId}/sites`, body)]) {
        expect(res.status, JSON.stringify(body)).toBe(400);
        const text = await res.text();
        for (const echoed of ["p@", "pw@", "u:p", "admin@", "host.com"]) expect(text).not.toContain(echoed);
        expect(text).toContain("Leave the login out of the address.");
      }
    }
    expect(await getSite(env.DB, s.site!.id)).toEqual(before);
    expect(await listSites(env.DB, { businessId: s.businessId })).toHaveLength(1);
  });

  it("a login-shaped host, registrar or DNS provider is refused like a note", async () => {
    const s = await seedClient();
    for (const field of ["hostProvider", "registrar", "dnsProvider"]) {
      const res = await call("PATCH", `/api/sites/${s.site!.id}`, { [field]: "password: x" });
      expect(res.status, field).toBe(400);
      expect(await res.text()).not.toContain("password: x");
    }
    expect(await getSite(env.DB, s.site!.id)).toMatchObject({ hostProvider: null, registrar: null, dnsProvider: null });
  });

  it("PATCH hostingTier, accessMethod or cms to an unknown value is a 400", async () => {
    const s = await seedClient();
    for (const body of [{ hostingTier: "cloud" }, { accessMethod: "ftp" }, { cms: "drupal" }]) expect((await call("PATCH", `/api/sites/${s.site!.id}`, body)).status).toBe(400);
    expect((await call("PATCH", `/api/sites/${s.site!.id}`, {})).status).toBe(400);
    expect((await call("PATCH", `/api/sites/${s.site!.id}`, { seedKey: "primary" })).status).toBe(400);
  });

  it("PATCH changes the fields given, cleans them, re-derives the domain from a new url, and clears with empty text", async () => {
    const s = await seedClient();
    const res = await call("PATCH", `/api/sites/${s.site!.id}`, {
      url: "https://www.new-ace.com/", adminUrl: "https://new-ace.com/wp-admin", cms: "wordpress", hostingTier: "client_hosted", accessMethod: "mainwp", hostProvider: "  Bluehost‮ ", registrar: "GoDaddy", notes: "Moved last year.",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { site: unknown }).site).toMatchObject({
      url: "https://www.new-ace.com/", domain: "new-ace.com", adminUrl: "https://new-ace.com/wp-admin", cms: "wordpress", hostingTier: "client_hosted", accessMethod: "mainwp", hostProvider: "Bluehost", registrar: "GoDaddy", notes: "Moved last year.",
    });
    await call("PATCH", `/api/sites/${s.site!.id}`, { adminUrl: "", registrar: "" });
    expect(await getSite(env.DB, s.site!.id)).toMatchObject({ adminUrl: null, registrar: null, hostProvider: "Bluehost" });
  });

  it("refuses a login in a site note and a field over 120 characters, without repeating either", async () => {
    const s = await seedClient();
    const a = await call("PATCH", `/api/sites/${s.site!.id}`, { notes: "password: hunter2" });
    expect(a.status).toBe(400);
    expect(await a.text()).not.toContain("hunter2");
    expect((await call("PATCH", `/api/sites/${s.site!.id}`, { hostProvider: "h".repeat(121) })).status).toBe(400);
  });

  it("a second live site with the same domain is a plain 409; an archived one frees it", async () => {
    const s = await seedClient();
    const dup = await call("POST", `/api/clients/${s.businessId}/sites`, { url: "https://ace.com/about" });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "this client already has a live site with that domain" });
    await call("DELETE", `/api/sites/${s.site!.id}`);
    expect((await call("POST", `/api/clients/${s.businessId}/sites`, { url: "https://ace.com/about" })).status).toBe(201);
  });
});

describe("add, archive and ownership", () => {
  it("POST /clients/:id/sites is 201 with the site and six needed items, and logs site_added", async () => {
    const s = await seedClient({ site: false });
    const res = await call("POST", `/api/clients/${s.businessId}/sites`, { url: "https://second-ace.com", cms: "webflow", hostingTier: "logan_hosted" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { site: { id: string; domain: string; cms: string; test: boolean }; access: { status: string }[] };
    expect(body.site).toMatchObject({ domain: "second-ace.com", cms: "webflow", test: false });
    expect(body.access).toHaveLength(6);
    expect(body.access.every((i) => i.status === "needed")).toBe(true);
    expect(await lines(s.businessId, "site_added")).toEqual(["Site added: second-ace.com"]);
    expect((await call("POST", `/api/clients/${s.businessId}/sites`, {})).status).toBe(201);
    expect(await lines(s.businessId, "site_added")).toContain("Site added: no domain yet");
  });

  it("refuses a javascript: address on add, adds nothing and logs nothing", async () => {
    const s = await seedClient({ site: false });
    expect((await call("POST", `/api/clients/${s.businessId}/sites`, { url: "javascript:alert(1)" })).status).toBe(400);
    expect(await listSites(env.DB, { businessId: s.businessId })).toEqual([]);
    expect(await lines(s.businessId, "site_added")).toEqual([]);
  });

  it("a site added to a rehearsal client is a test site; to a real client it is not", async () => {
    const t = await seedClient({ test: true, site: false });
    const r = await call("POST", `/api/clients/${t.businessId}/sites`, { url: "https://rehearsal.com" });
    expect(((await r.json()) as { site: { test: boolean } }).site.test).toBe(true);
  });

  it("a lead that is not a client, and an unknown client, cannot get a site (404)", async () => {
    const plain = await seedClient({ won: false, project: false, site: false });
    expect((await call("POST", `/api/clients/${plain.businessId}/sites`, { url: "https://x.com" })).status).toBe(404);
    expect((await call("POST", "/api/clients/nope/sites", {})).status).toBe(404);
    expect(await listSites(env.DB, { businessId: plain.businessId })).toEqual([]);
  });

  it("a site under another client's id is a 404 on every site route", async () => {
    const a = await seedClient();
    const b = await seedClient();
    const base = `/api/clients/${b.businessId}/sites/${a.site!.id}`;
    expect((await call("PATCH", base, { notes: "hijack" })).status).toBe(404);
    expect((await call("PUT", `${base}/access/hosting`, { status: "received" })).status).toBe(404);
    expect((await call("DELETE", base)).status).toBe(404);
    expect(await getSite(env.DB, a.site!.id)).toMatchObject({ notes: null, archivedAt: null });
    expect((await listAccess(env.DB, a.site!.id)).find((i) => i.key === "hosting")!.status).toBe("needed");
    const own = `/api/clients/${a.businessId}/sites/${a.site!.id}`;
    expect((await call("PATCH", own, { notes: "mine" })).status).toBe(200);
    expect((await call("PUT", `${own}/access/hosting`, { status: "received" })).status).toBe(200);
    expect((await call("DELETE", own)).status).toBe(204);
  });

  it("PATCH logs one site_changed line naming the fields that changed and never a value; an unchanged PATCH logs none", async () => {
    const s = await seedClient();
    const NOTE = "Moved from Bluehost to WP Engine in March.";
    await call("PATCH", `/api/sites/${s.site!.id}`, { hostingTier: "client_hosted", notes: NOTE, hostProvider: "WP Engine", cms: "unknown" });
    expect(await lines(s.businessId, "site_changed")).toEqual(["Site updated: host, hosting tier, notes"]);
    await call("PATCH", `/api/sites/${s.site!.id}`, { hostingTier: "client_hosted", notes: NOTE });
    expect(await lines(s.businessId, "site_changed")).toEqual(["Site updated: host, hosting tier, notes"]);
    await call("PATCH", `/api/sites/${s.site!.id}`, { url: "https://secret-name.com/", adminUrl: "https://secret-name.com/wp-admin" });
    expect((await lines(s.businessId, "site_changed")).at(-1) ?? "").not.toBe("");
    const all = JSON.stringify(await listActivity(env.DB, s.businessId, 200));
    for (const value of [NOTE, "WP Engine", "Bluehost", "secret-name", "client_hosted"]) expect(all).not.toContain(value);
    expect((await lines(s.businessId, "site_changed")).sort()).toEqual(["Site updated: address, domain, admin address", "Site updated: host, hosting tier, notes"]);
  });

  it("PATCH names the domain when a new address re-derives it, and not when the domain stays the same", async () => {
    const s = await seedClient();
    await call("PATCH", `/api/sites/${s.site!.id}`, { url: "https://www.ace.com/services" });
    expect(await lines(s.businessId, "site_changed")).toEqual(["Site updated: address"]);
    await call("PATCH", `/api/sites/${s.site!.id}`, { url: "https://newname.com/" });
    expect((await lines(s.businessId, "site_changed"))[0]).toBe("Site updated: address, domain"); // newest first
    expect((await getSite(env.DB, s.site!.id))!.domain).toBe("newname.com");
    await call("PATCH", `/api/sites/${s.site!.id}`, { domain: "newname.com" });
    expect(await lines(s.businessId, "site_changed")).toHaveLength(2);
    expect(JSON.stringify(await listActivity(env.DB, s.businessId, 200))).not.toContain("newname");
  });

  it("DELETE logs one site_changed line, Site archived, and a second DELETE adds none", async () => {
    const s = await seedClient();
    await call("DELETE", `/api/sites/${s.site!.id}`);
    await call("DELETE", `/api/sites/${s.site!.id}`);
    expect(await lines(s.businessId, "site_changed")).toEqual(["Site archived"]);
  });

  it("DELETE archives (204), the site leaves the record, and a second DELETE is 404", async () => {
    const s = await seedClient();
    const res = await call("DELETE", `/api/sites/${s.site!.id}`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await getSite(env.DB, s.site!.id)).toMatchObject({ archivedAt: expect.any(String) });
    const rec = (await (await call("GET", `/api/clients/${s.businessId}`)).json()) as { client: { sites: unknown[] } };
    expect(rec.client.sites).toEqual([]);
    expect((await call("DELETE", `/api/sites/${s.site!.id}`)).status).toBe(404);
    expect((await call("PATCH", `/api/sites/${s.site!.id}`, { notes: "x" })).status).toBe(404);
    expect((await call("PUT", `/api/sites/${s.site!.id}/access/hosting`, { status: "received" })).status).toBe(404);
    expect((await call("DELETE", "/api/sites/nope")).status).toBe(404);
  });
});
