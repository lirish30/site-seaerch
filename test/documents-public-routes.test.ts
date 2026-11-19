import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/worker/index";
import { createDraft, getDocument, signaturesFor } from "../src/worker/db/documents";
import { setPdfRendererForTests } from "../src/worker/documents/signed";
import { proposal, seedDeal, sendDraft, stubPdfRenderer } from "./fixtures/documents";

// Signing makes the PDF, which needs a browser: these tests are about the signature.
beforeEach(stubPdfRenderer);
afterEach(() => setPdfRendererForTests(null));

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const FAR = "2099-01-01T00:00:00.000Z";
type E = typeof env;

/** The Worker as a prospect's browser reaches it: no cookie. */
const call = (path: string, init: RequestInit = {}, e: Partial<E> = {}) => worker.fetch(new Request(`https://x/api/public${path}`, init), { ...env, ...e } as E, ctx);
const post = (token: string, body: unknown, headers: Record<string, string> = {}, e: Partial<E> = {}) =>
  call(`/p/${token}/sign`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, e);
const form = (hash: string, o: Record<string, unknown> = {}) => ({ name: "Pat Jones", consent: true, authority: true, sha256: hash, ...o });

/** A sent proposal that stays open for the life of the test run. */
async function sent() {
  const s = await seedDeal();
  const content = proposal();
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content });
  const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: FAR });
  return { ...s, doc, hash, token: doc.token! };
}

const limiter = (success: boolean) => {
  const keys: string[] = [];
  return { keys, binding: { limit: async (o: { key: string }) => { keys.push(o.key); return { success }; } } as unknown as RateLimit };
};

/** A database that fails the test the moment anything touches it. */
const poisoned = (touched: string[]): D1Database =>
  new Proxy({} as D1Database, { get: (_t, k) => { touched.push(String(k)); throw new Error(`the database was touched (${String(k)})`); } });

describe("headers", () => {
  it("GET and POST carry no-store, noindex and no-referrer, on every answer", async () => {
    const a = await sent();
    const answers = [
      await call(`/p/${a.token}`),
      await post(a.token, form(a.hash)),
      await post(a.token, form(a.hash)), // the second sign
      await call(`/p/${"A".repeat(43)}`),
      await post(a.token, "not json"),
      await post(a.token, form(a.hash, { name: "A".repeat(5000) })),
      await call("/p/short"),
      await post("short", form(a.hash)),
      await post(a.token, form("0".repeat(64))),
      await call(`/p/${a.token}/sign`), // not a route
    ];
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 404, 400, 413, 404, 404, 409, 401]);
    for (const r of answers.slice(0, -1)) {
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });
});

describe("GET /p/:token", () => {
  it("needs no cookie and returns the page; an unknown token is a plain 404", async () => {
    const a = await sent();
    const res = await call(`/p/${a.token}`);
    expect(res.status).toBe(200);
    const page = await res.json<any>();
    expect(page).toMatchObject({ state: "open", contentSha256: a.hash, clientName: "Ace Plumbing", payment: { state: "none" } });
    expect((await getDocument(env.DB, a.doc.id))!.status).toBe("viewed");
    const gone = await call(`/p/${"B".repeat(43)}`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "not found" });
  });

  it("a void document is the closed page, with nothing of the proposal in it", async () => {
    const a = await sent();
    await env.DB.prepare(`UPDATE documents SET status = 'void', void_reason = 'x' WHERE id = ?`).bind(a.doc.id).run();
    const body = await (await call(`/p/${a.token}`)).json<any>();
    expect(Object.keys(body).sort()).toEqual(["clientName", "contactEmail", "state"]);
    expect(body.state).toBe("closed");
  });

  it("only GET reaches it without a cookie: other methods and neighbouring paths stay protected", async () => {
    const a = await sent();
    for (const [path, method] of [[`/p/${a.token}`, "POST"], [`/p/${a.token}`, "DELETE"], [`/p/${a.token}`, "PUT"], [`/p/${a.token}/sign`, "GET"], [`/p/${a.token}/sign`, "DELETE"],
      [`/p/${a.token}/sign/`, "POST"], [`/p/${a.token}/other`, "GET"], [`/p/${a.token}/other`, "POST"], ["/p", "GET"], ["/p/", "GET"], ["/p//sign", "POST"], [`/p/${a.token}/sign/x`, "POST"]] as const) {
      const r = await call(path, { method, body: method === "GET" ? undefined : "{}" });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("POST /p/:token/sign", () => {
  it("signs, taking the address and browser from the request's own headers", async () => {
    const a = await sent();
    const res = await post(a.token, form(a.hash), { "cf-connecting-ip": "203.0.113.77", "user-agent": "Mozilla/5.0 RouteTest" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "signed", signed: { name: "Pat Jones" }, payment: { state: "none" } });
    const [mine] = (await signaturesFor(env.DB, a.doc.id)).filter((s) => s.role === "client");
    expect(mine).toMatchObject({ signerName: "Pat Jones", signerEmail: "pat@ace.test", ip: "203.0.113.77", userAgent: "Mozilla/5.0 RouteTest", contentSha256: a.hash });
  });

  it("the body is the only source of the name: no header or query can set who signed", async () => {
    const a = await sent();
    const res = await call(`/p/${a.token}/sign?name=Mallory&ip=6.6.6.6`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "6.6.6.6", "x-real-ip": "6.6.6.6" }, body: JSON.stringify(form(a.hash)) });
    expect(res.status).toBe(200);
    const [mine] = (await signaturesFor(env.DB, a.doc.id)).filter((s) => s.role === "client");
    expect(mine.signerName).toBe("Pat Jones");
    expect(mine.ip).toBeNull();
  });

  it("a stale hash is a 409 saying so", async () => {
    const a = await sent();
    const res = await post(a.token, form("0".repeat(64)));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "this proposal changed, reload" });
  });

  it("an oversized body is a 413, whether or not the length is declared, and nothing is read past the cap", async () => {
    const a = await sent();
    const big = JSON.stringify(form(a.hash, { name: "A".repeat(5000) }));
    expect(big.length).toBeGreaterThan(4096);
    const declared = await post(a.token, big, { "content-length": String(big.length) });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "too large" });
    // No content-length on a stream: the reader stops at the limit.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1024; c.enqueue(new Uint8Array(1024).fill(97)); if (pulled > 1_000_000) c.close(); } });
    const streamed = await call(`/p/${a.token}/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(pulled).toBeLessThan(100_000);
    // Exactly at the edge is fine to read (and then refused as what it is).
    const edge = await post(a.token, "x".repeat(4096));
    expect(edge.status).toBe(400);
    expect((await signaturesFor(env.DB, a.doc.id)).filter((s) => s.role === "client")).toEqual([]);
  });

  it("a body that is not JSON, or not the form, is a 400 that names fields and never echoes what was sent", async () => {
    const a = await sent();
    expect((await post(a.token, "")).status).toBe(400);
    expect((await post(a.token, "{")).status).toBe(400);
    expect((await post(a.token, "[]")).status).toBe(400);
    const bad = await post(a.token, form(a.hash, { name: "ECHO-ME\u202e", consent: false }));
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(JSON.parse(text)).toEqual({ error: "invalid body", fields: ["name", "consent"] });
    expect(text).not.toContain("ECHO-ME");
    expect((await post(a.token, form(a.hash, { extra: 1 }))).status).toBe(400);
    expect((await signaturesFor(env.DB, a.doc.id)).filter((s) => s.role === "client")).toEqual([]);
  });
});

describe("the CLIENT_LIMITER", () => {
  it("the limiter returns 429, on both routes, keyed by the link and the client address, before anything runs", async () => {
    const a = await sent();
    const l = limiter(false);
    const get = await call(`/p/${a.token}`, { headers: { "cf-connecting-ip": "203.0.113.9" } }, { CLIENT_LIMITER: l.binding });
    const sign = await post(a.token, form(a.hash), { "cf-connecting-ip": "203.0.113.9" }, { CLIENT_LIMITER: l.binding });
    for (const res of [get, sign]) {
      expect(res.status).toBe(429);
      expect(await res.text()).toBe(JSON.stringify({ error: "too many requests" }));
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(l.keys).toEqual([`${a.token}:203.0.113.9`, `${a.token}:203.0.113.9`]);
    expect((await getDocument(env.DB, a.doc.id))!.status).toBe("sent"); // not viewed, not signed
    expect(await signaturesFor(env.DB, a.doc.id)).toHaveLength(1);
  });

  it("counts a link and an address apart, and lets everything through when it says yes or when there is no binding", async () => {
    const a = await sent();
    const l = limiter(true);
    await call(`/p/${a.token}`, { headers: { "cf-connecting-ip": "1.1.1.1" } }, { CLIENT_LIMITER: l.binding });
    await call(`/p/${a.token}`, { headers: { "cf-connecting-ip": "2.2.2.2" } }, { CLIENT_LIMITER: l.binding });
    await call(`/p/${a.token}`, {}, { CLIENT_LIMITER: l.binding });
    expect(l.keys).toEqual([`${a.token}:1.1.1.1`, `${a.token}:2.2.2.2`, `${a.token}:unknown`]);
    expect((await call(`/p/${a.token}`, {}, { CLIENT_LIMITER: undefined })).status).toBe(200);
  });

  it("does not count a malformed link", async () => {
    const l = limiter(false);
    expect((await call("/p/bad", {}, { CLIENT_LIMITER: l.binding })).status).toBe(404);
    expect((await post("bad", {}, {}, { CLIENT_LIMITER: l.binding })).status).toBe(404);
    expect(l.keys).toEqual([]);
  });

  it("the real binding throttles one link and address at thirty a minute", async () => {
    const a = await sent();
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await call(`/p/${a.token}`, { headers: { "cf-connecting-ip": "203.0.113.50" } })).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    expect((await call(`/p/${a.token}`, { headers: { "cf-connecting-ip": "203.0.113.51" } })).status).toBe(200);
  });
});

describe("tokens that cannot be real", () => {
  it("a worker-only token path never reaches the database when the token is not 43 characters", async () => {
    const touched: string[] = [];
    const e = { DB: poisoned(touched) };
    const T = "A".repeat(43);
    const bad = ["a", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}.`, `${"A".repeat(42)}%`, `${"A".repeat(42)}+`, `${T}%20`, "A".repeat(500), `${"A".repeat(21)}%2f${"A".repeat(21)}`];
    for (const t of bad) {
      const g = await call(`/p/${t}`, {}, e);
      expect(g.status, `GET ${t}`).toBe(404);
      expect(await g.json()).toEqual({ error: "not found" });
      const p = await post(t, form("0".repeat(64)), {}, e);
      expect(p.status, `POST ${t}`).toBe(404);
      expect(await p.json()).toEqual({ error: "not found" });
      expect(g.headers.get("cache-control")).toBe("no-store");
    }
    expect(touched).toEqual([]);
  });

  it("a malformed token's POST is a 404 whatever the body: it is not even read", async () => {
    const touched: string[] = [];
    const e = { DB: poisoned(touched) };
    expect((await post("short", "not json", {}, e)).status).toBe(404);
    expect((await post("short", "x".repeat(10_000), {}, e)).status).toBe(404);
    expect(touched).toEqual([]);
  });
});
