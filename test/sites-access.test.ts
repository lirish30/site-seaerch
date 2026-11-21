import { describe, expect, it } from "vitest";
import { ACCESS_KEYS, type AccessItem, type AccessKey, type AccessStatus, type Site } from "../src/worker/db/sites";
import { ACCESS_LABELS, cleanVaultName, isHttpUrl, noteProblem, siteFlags, unresolved, vaultNameProblem } from "../src/worker/sites/access";

const item = (key: AccessKey, status: AccessStatus): AccessItem => ({
  siteId: "s1", key, status, vaultItem: null, note: null, requestedAt: null, receivedAt: null, verifiedAt: null, updatedAt: "2026-11-20T00:00:00.000Z",
});
const all = (status: AccessStatus): AccessItem[] => ACCESS_KEYS.map((k) => item(k, status));
const site = (o: Partial<Site> = {}): Site => ({
  id: "s1", businessId: "b1", seedKey: "primary", url: "https://acme.com", domain: "acme.com", cms: "wordpress", hostProvider: null, registrar: null,
  dnsProvider: null, adminUrl: null, hostingTier: "logan_hosted", accessMethod: "unknown", notes: null, test: false,
  archivedAt: null, createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z", ...o,
});

describe("ACCESS_LABELS", () => {
  it("names the six keys and every help ends with the vault reminder", () => {
    expect(ACCESS_KEYS.map((k) => ACCESS_LABELS[k].label)).toEqual(["Hosting", "DNS", "Registrar", "Site admin", "Google Business Profile", "Analytics"]);
    for (const k of ACCESS_KEYS) expect(ACCESS_LABELS[k].help.endsWith("Name the password manager item, never the login.")).toBe(true);
  });
});

describe("vaultNameProblem", () => {
  it("accepts ordinary item names and an empty value", () => {
    for (const ok of ["Acme Plumbing - GoDaddy", "Acme Plumbing GoDaddy login item", "acme-godaddy-owner", "", "   "]) expect(vaultNameProblem(ok)).toBeNull();
  });
  it("refuses secret shapes, links and long text without repeating them", () => {
    const refused = [
      "password: hunter2", "Tr0ub4dor&3xyzQ9", "https://admin:pw@acme.com/", "https://acme.com/wp-admin", "sk_live_51Habc123def456",
      "AKIAIOSFODNN7EXAMPLE", "-----BEGIN PRIVATE KEY-----", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", "a".repeat(81), "0123456789abcdef0123456789abcdef",
    ];
    for (const r of refused) {
      const p = vaultNameProblem(r);
      expect(p, r).toBeTypeOf("string");
      expect(p!.endsWith("."), r).toBe(true);
      expect(p!.includes(r), r).toBe(false);
    }
  });
  it("uses the two stated sentences", () => {
    expect(vaultNameProblem("password: hunter2")).toBe("That looks like a login or a key. Type only the name of the password manager item.");
    expect(vaultNameProblem("https://acme.com/wp-admin")).toBe("A password manager item name is a name, not a link.");
  });
  it("strips control and bidi characters before checking", () => {
    expect(cleanVaultName("Acme‮ GoDaddy")).toBe("Acme GoDaddy");
    expect(vaultNameProblem("Acme‮ GoDaddy")).toBeNull();
    expect(vaultNameProblem("pass​word: x")).not.toBeNull();
  });
});

describe("cleanVaultName", () => {
  it("cleans, caps at 80 and turns empty into null", () => {
    expect(cleanVaultName("  Acme - GoDaddy  ")).toBe("Acme - GoDaddy");
    expect(cleanVaultName("")).toBeNull();
    expect(cleanVaultName(" ‮ ")).toBeNull();
    expect(cleanVaultName("x ".repeat(60))!.length).toBeLessThanOrEqual(80);
  });
});

describe("noteProblem", () => {
  it("accepts a plain sentence and an empty note", () => {
    expect(noteProblem("Owner is Dana; invited me as editor on 12/3.")).toBeNull();
    expect(noteProblem("")).toBeNull();
    expect(noteProblem("Single sign-on through the Acme Google account, see https://acme.com/help")).toBeNull();
  });
  it("refuses a login pair, a key or a long note without repeating it", () => {
    for (const r of ["login = dana / hunter2", "https://admin:pw@acme.com/", "AKIAIOSFODNN7EXAMPLE", "x".repeat(501)]) {
      const p = noteProblem(r);
      expect(p, r).toBeTypeOf("string");
      expect(p!.includes(r), r).toBe(false);
    }
  });
  it("allows a long single word, which is only a vault-name rule", () => {
    expect(noteProblem("Remember-to-ask-Dana-about-DNS-9")).toBeNull();
  });
});

describe("secret shapes are refused in names and notes alike", () => {
  const secrets: Array<[string, string]> = [
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", "eyJzdWIiOiIx"],
    ["ghp_" + "Zq8Lm2Xv9Rt4Wk7Bn3Yc5Hd1Jf6Ps0", "Zq8Lm2Xv9Rt4"],
    ["xoxb-1234567890-AbCdEfGhIjKl", "AbCdEfGhIjKl"],
    ["sk-" + "Qw3Er5Ty7Ui9Op1As2Df4Gh6", "Qw3Er5Ty7Ui9"],
    ["AIza" + "SyD4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ12", "SyD4e5F6g7H8"],
    ["pw: hunter2", "hunter2"],
    ["passwd=abc", "passwd=abc"],
    ["password\uFF1Ax", "password\uFF1Ax"],
    ["note ghp_" + "Zq8Lm2Xv9Rt4Wk7Bn3Yc5Hd1Jf6Ps0 more words", "Zq8Lm2Xv9Rt4"],
  ];
  it.each(secrets)("refuses %s in a note and a name without repeating it", (input, fragment) => {
    for (const p of [noteProblem(input), vaultNameProblem(input)]) {
      expect(p, input).toBeTypeOf("string");
      expect(p!).not.toContain(fragment);
    }
  });
  it("still accepts ordinary names", () => {
    for (const ok of ["Hostgator login (Dana)", "Acme Token Vault", "Passcode Vault", "Cloudflare acme-plumbing.com"]) {
      expect(vaultNameProblem(ok), ok).toBeNull();
      expect(noteProblem(ok), ok).toBeNull();
    }
  });
});

describe("unresolved", () => {
  it("keeps needed and requested only", () => {
    const items = [item("hosting", "needed"), item("dns", "requested"), item("registrar", "received"), item("admin", "verified"), item("gbp", "not_applicable"), item("analytics", "needed")];
    expect(unresolved(items).map((i) => i.key)).toEqual(["hosting", "dns", "analytics"]);
  });
});

describe("isHttpUrl", () => {
  it("allows http and https and nothing else", () => {
    expect(isHttpUrl("https://acme.com/wp-admin")).toBe(true);
    expect(isHttpUrl("http://acme.com")).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://acme.com", "", "acme.com", "not a url"]) expect(isHttpUrl(bad), bad).toBe(false);
  });
});

describe("siteFlags", () => {
  it("lists every missing label when all six are needed", () => {
    const flags = siteFlags({ site: site(), items: all("needed"), careActive: false });
    expect(flags).toEqual([{ code: "access_missing", text: "Still missing: Hosting, DNS, Registrar, Site admin, Google Business Profile, Analytics." }]);
  });
  it("is quiet when everything is verified or not applicable", () => {
    const items = all("verified");
    items[4] = item("gbp", "not_applicable");
    expect(siteFlags({ site: site(), items, careActive: true })).toEqual([]);
  });
  it("lists only the unresolved ones, in checklist order", () => {
    const items = [item("analytics", "requested"), item("hosting", "needed"), item("dns", "received")];
    expect(siteFlags({ site: site(), items, careActive: false })[0].text).toBe("Still missing: Hosting, Analytics.");
  });
  it("flags Care on a client-hosted site with no usable access", () => {
    for (const accessMethod of ["none", "unknown"] as const) {
      const flags = siteFlags({ site: site({ hostingTier: "client_hosted", accessMethod }), items: all("verified"), careActive: true });
      expect(flags.map((f) => f.code)).toEqual(["client_hosted_no_access"]);
      expect(flags[0].text).toBe("Care on a client-hosted site needs SSH with WP-CLI or a MainWP connection. Ask for access, or recommend moving the site to your hosting.");
    }
  });
  it("does not flag when the connection works, Care is off, or Logan hosts it", () => {
    expect(siteFlags({ site: site({ hostingTier: "client_hosted", accessMethod: "mainwp" }), items: all("verified"), careActive: true })).toEqual([]);
    expect(siteFlags({ site: site({ hostingTier: "client_hosted", accessMethod: "ssh_wpcli" }), items: all("verified"), careActive: true })).toEqual([]);
    expect(siteFlags({ site: site({ hostingTier: "client_hosted", accessMethod: "none" }), items: all("verified"), careActive: false })).toEqual([]);
    expect(siteFlags({ site: site({ hostingTier: "logan_hosted", accessMethod: "none" }), items: all("verified"), careActive: true })).toEqual([]);
  });
  it("gives both flags when both apply", () => {
    const flags = siteFlags({ site: site({ hostingTier: "client_hosted", accessMethod: "none" }), items: all("needed"), careActive: true });
    expect(flags.map((f) => f.code)).toEqual(["access_missing", "client_hosted_no_access"]);
  });
  it("gives an archived site no flags", () => {
    expect(siteFlags({ site: site({ archivedAt: "2026-11-01T00:00:00.000Z", hostingTier: "client_hosted", accessMethod: "none" }), items: all("needed"), careActive: true })).toEqual([]);
  });
});
