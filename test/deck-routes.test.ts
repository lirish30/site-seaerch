import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { latestAudit } from "../src/worker/db/audits";
import { listActivity } from "../src/worker/db/activity";
import { getDeal, saveRecapStmt, stampDeckFrozen } from "../src/worker/db/deals";
import { listCurrentPackages, savePackage } from "../src/worker/db/packages";
import { createVideoAudit, savePlan } from "../src/worker/db/videoAudits";
import { offerOf, type CallRecap } from "../src/worker/queue/callRecap";
import { MAX_DECK_IMAGE_BYTES, deckFileName, deckRoutes } from "../src/worker/routes/deck";
import type { Option } from "../src/worker/sales/options";
import type { VideoPlan } from "../src/worker/video/plan";
import { seedRecapDeal } from "./fixtures/deal";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
const call = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" } });

const opt = (id: "a" | "b" | "c", label: string, keys: string[], recommended = false) => ({ id, label, tagline: `${label} tagline`, items: keys.map((key) => ({ key })), recommended }) as Option;
const OPTIONS = [opt("a", "Fix it", ["quick_fix"]), opt("b", "Fix it and keep it running", ["quick_fix", "care"], true), opt("c", "Fix it, keep it running, get found", ["quick_fix", "care", "local_seo"])];
const RECAP: CallRecap = {
  playback: "You want more water heater jobs.", recommendation: "Fix what is broken first, then keep the site looked after.", leadType: "wp_few_broken",
  goals: ["More calls for water heater jobs"], currentState: ["Old site"], generatedAt: "2026-11-18T00:00:00.000Z",
};

/** A deal with the recap and options stored the way the queue's apply stores them. */
async function seedDeck(o: { name?: string; booking?: boolean } = {}) {
  const s = await seedRecapDeal({ name: o.name, booking: o.booking });
  await env.DB.batch([saveRecapStmt(env.DB, s.deal.id, RECAP, offerOf(OPTIONS, await listCurrentPackages(env.DB)))]);
  return s;
}
const fakePdf = () => {
  const calls: { binding: unknown; html: string }[] = [];
  const pdf = async (binding: Fetcher, html: string) => { calls.push({ binding, html }); return new Uint8Array([37, 80, 68, 70]); };
  return { calls, app: deckRoutes({ pdf }) };
};
const BROWSER = { marker: "browser" } as unknown as Fetcher;
const get = (app: ReturnType<typeof deckRoutes>, path: string, e: Record<string, unknown> = { ...env, BROWSER }, method = "GET") => app.request(path, { method }, e);

describe("deck routes", () => {
  it("requires sign-in", async () => {
    for (const [m, p] of [["GET", "/api/deals/x/deck.html"], ["GET", "/api/deals/x/deck.pdf"], ["POST", "/api/deals/x/deck/freeze"]] as const) {
      expect((await call(m, p, undefined, false)).status, p).toBe(401);
    }
  });

  it("deck before recap is a 409", async () => {
    const { deal } = await seedRecapDeal();
    const { app, calls } = fakePdf();
    for (const [m, p] of [["GET", "deck.html"], ["GET", "deck.pdf"], ["POST", "deck/freeze"]] as const) {
      const res = await get(app, `/${deal.id}/${p}`, { ...env, BROWSER }, m);
      expect(res.status, p).toBe(409);
      expect(await res.json()).toEqual({ error: "draft the recap first" });
    }
    expect(calls).toHaveLength(0);
    expect((await getDeal(env.DB, deal.id))!.deckFrozenAt).toBeNull();
    // Through the real app too.
    expect((await call("GET", `/api/deals/${deal.id}/deck.html`)).status).toBe(409);
  });

  it("another deal's id is a 404", async () => {
    const { app } = fakePdf();
    for (const [m, p] of [["GET", "deck.html"], ["GET", "deck.pdf"], ["POST", "deck/freeze"]] as const) expect((await get(app, `/not-a-deal/${p}`, { ...env, BROWSER }, m)).status, p).toBe(404);
    expect((await call("GET", "/api/deals/not-a-deal/deck.html")).status).toBe(404);
  });

  it("serves the deck as a self-contained page with the prices from the snapshot, and the first view freezes it", async () => {
    const { deal } = await seedDeck({ booking: true });
    expect((await getDeal(env.DB, deal.id))!.deckFrozenAt).toBeNull();
    const res = await call("GET", `/api/deals/${deal.id}/deck.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("Ace Plumbing");
    expect(html).toContain("$797");
    expect(html).toContain("$129/mo");
    expect(html).toContain("ArrowRight");
    expect(html).toContain("Prepared for Pat Jones");
    const frozen = (await getDeal(env.DB, deal.id))!.deckFrozenAt;
    expect(frozen).not.toBeNull();
    // A second view keeps the first time.
    await call("GET", `/api/deals/${deal.id}/deck.html`);
    expect((await getDeal(env.DB, deal.id))!.deckFrozenAt).toBe(frozen);
  });

  it("escapes a business name with markup", async () => {
    const { deal } = await seedDeck({ name: `<img src=x onerror=alert(1)> & Sons` });
    const html = await (await call("GET", `/api/deals/${deal.id}/deck.html`)).text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; Sons");
  });

  it("pdf is requested through htmlToPdf with print true", async () => {
    const { b, deal } = await seedDeck({ name: "Ace/Plumbing: \"Best\"" });
    const { app, calls } = fakePdf();
    const res = await get(app, `/${deal.id}/deck.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(calls).toHaveLength(1);
    expect(calls[0].binding).toBe(BROWSER);
    // Print output: every slide a page, no notes, no script.
    expect(calls[0].html).toContain('data-print="1"');
    expect(calls[0].html).not.toContain('id="notes"');
    expect(calls[0].html).not.toContain("<script");
    expect((calls[0].html.match(/<section class="slide/g) ?? []).length).toBeGreaterThanOrEqual(10);
    const disposition = res.headers.get("content-disposition")!;
    expect(disposition).toMatch(/^attachment; filename="Ace Plumbing Best - Recommendation - \d{4}-\d{2}-\d{2}\.pdf"$/);
    expect((await getDeal(env.DB, deal.id))!.deckFrozenAt).not.toBeNull();
    expect((await listActivity(env.DB, b.id)).some((a) => a.kind === "export")).toBe(true);
  });

  it("pdf says so when Browser Rendering is not bound", async () => {
    const { deal } = await seedDeck();
    const { app, calls } = fakePdf();
    expect((await get(app, `/${deal.id}/deck.pdf`, { ...env, BROWSER: undefined })).status).toBe(501);
    expect(calls).toHaveLength(0);
  });

  it("deckFileName is safe and dated", () => {
    expect(deckFileName("Ace / Plumbing\r\n\"Co\"", new Date("2026-11-18T20:00:00Z"))).toBe("Ace Plumbing Co - Recommendation - 2026-11-18.pdf");
    expect(deckFileName("///", new Date("2026-11-18T20:00:00Z"))).toBe("Website - Recommendation - 2026-11-18.pdf");
  });

  it("screenshots come from R2 as data URIs, and one over 400 KB is skipped, not a failure", async () => {
    const { b, deal } = await seedDeck();
    const a = (await latestAudit(env.DB, b.id))!; // seedRecapDeal gives the lead an audit
    const v = (await createVideoAudit(env.DB, { businessId: b.id, auditId: a.id }))!;
    const small = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
    await env.RAW.put(`video/${v.id}/shots/s1.preview.jpg`, small, { httpMetadata: { contentType: "image/jpeg" } });
    await env.RAW.put(`video/${v.id}/shots/s2.preview.jpg`, new Uint8Array(MAX_DECK_IMAGE_BYTES + 1), { httpMetadata: { contentType: "image/jpeg" } });
    const seg = (id: string, role: "hook" | "problem" | "cta", shotId: string, findingCode?: string) => ({ id, role, text: `Line ${id} has a few words in it.`, shotId, markups: [], ...(findingCode ? { findingCode } : {}) });
    const plan: VideoPlan = {
      shots: ["s1", "s2", "s3"].map((id) => ({ id, viewport: "desktop" as const, scrollY: 0, width: 1280, height: 720, fullKey: `video/${v.id}/shots/${id}.jpg`, previewKey: `video/${v.id}/shots/${id}.preview.jpg` })),
      segments: [seg("h", "hook", "s1"), seg("p1", "problem", "s1", "no_https"), seg("p2", "problem", "s2", "old_copyright"), seg("p3", "problem", "s3", "no_title_or_meta"), seg("c", "cta", "s1")],
      narration: "clone", version: 0,
    };
    await savePlan(env.DB, v.id, plan);
    const res = await call("GET", `/api/deals/${deal.id}/deck.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const imgs = [...html.matchAll(/<img [^>]*src="(data:image\/jpeg;base64,[^"]+)"/g)].map((m) => m[1]);
    expect(imgs).toEqual([`data:image/jpeg;base64,${btoa(String.fromCharCode(...small))}`]); // s1 only: s2 is too big, s3 is not in R2
    expect(html).toContain("Three things I found on your site.");
  });

  it("freeze re-snapshots the options' packages at today's prices and stamps the time", async () => {
    const { deal } = await seedDeck();
    await call("GET", `/api/deals/${deal.id}/deck.html`);
    await savePackage(env.DB, "quick_fix", { priceCents: 89700 });
    // Frozen: the catalog moved but the deck did not.
    expect(await (await call("GET", `/api/deals/${deal.id}/deck.html`)).text()).not.toContain("$897");
    const res = await call("POST", `/api/deals/${deal.id}/deck/freeze`);
    expect(res.status).toBe(200);
    const stored = await res.json<any>();
    expect(stored.deckFrozenAt).not.toBeNull();
    expect(stored.priceSnapshot.find((s: any) => s.key === "quick_fix")).toMatchObject({ priceCents: 89700, version: 2 });
    expect(stored.valueCents).toBe(89700 + 12900 * 12);
    expect(await (await call("GET", `/api/deals/${deal.id}/deck.html`)).text()).toContain("$897");
  });
});

describe("a frozen deck's inclusions", () => {
  it("do not change when a package's inclusions are edited, until the deck is frozen again", async () => {
    const { deal } = await seedDeck();
    const first = await (await call("GET", `/api/deals/${deal.id}/deck.html`)).text();
    expect(first).toContain("Weekly updates");
    await savePackage(env.DB, "care", { includes: ["BRAND-NEW-INCLUSION only after a refreeze"] });
    await savePackage(env.DB, "care", { summary: "A new summary" });
    const second = await (await call("GET", `/api/deals/${deal.id}/deck.html`)).text();
    expect(second).toBe(first);
    expect(second).not.toContain("BRAND-NEW-INCLUSION");
    // The PDF is the same story.
    const { app, calls } = fakePdf();
    expect((await get(app, `/${deal.id}/deck.pdf`)).status).toBe(200);
    expect(calls[0].html).toContain("Weekly updates");
    expect(calls[0].html).not.toContain("BRAND-NEW-INCLUSION");
    expect((await call("POST", `/api/deals/${deal.id}/deck/freeze`)).status).toBe(200);
    const after = await (await call("GET", `/api/deals/${deal.id}/deck.html`)).text();
    expect(after).toContain("BRAND-NEW-INCLUSION only after a refreeze");
    expect(after).not.toContain("Weekly updates");
  });

  it("a snapshot entry whose package version is missing is shown without inclusions, not an error", async () => {
    const { deal } = await seedDeck();
    const snap = (await getDeal(env.DB, deal.id))!.priceSnapshot.map((s) => (s.key === "care" ? { ...s, version: 999 } : s));
    await env.DB.prepare(`UPDATE deals SET price_snapshot = ? WHERE id = ?`).bind(JSON.stringify(snap), deal.id).run();
    const res = await call("GET", `/api/deals/${deal.id}/deck.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("$129/mo"); // the frozen price still shows
    expect(html).not.toContain("Weekly updates"); // Care's inclusions are skipped
    expect(html).toContain("Fixed scope"); // another package's inclusions are unaffected
  });

  it("a deal with no snapshot reads inclusions from the current catalog", async () => {
    const { deal } = await seedDeck();
    await env.DB.prepare(`UPDATE deals SET price_snapshot = '[]' WHERE id = ?`).bind(deal.id).run();
    const html = await (await call("GET", `/api/deals/${deal.id}/deck.html`)).text();
    expect(html).toContain("$129/mo");
  });
});

describe("a failed PDF", () => {
  it("returns 502 with a short error and leaves the deck unfrozen; a good PDF freezes it", async () => {
    const { deal } = await seedDeck();
    const boom = deckRoutes({ pdf: async () => { throw new Error("browser exploded: secret internals"); } });
    const res = await get(boom, `/${deal.id}/deck.pdf`);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("could not make the PDF");
    expect(body).not.toContain("secret internals");
    expect((await getDeal(env.DB, deal.id))!.deckFrozenAt).toBeNull();
    const { app } = fakePdf();
    expect((await get(app, `/${deal.id}/deck.pdf`)).status).toBe(200);
    expect((await getDeal(env.DB, deal.id))!.deckFrozenAt).not.toBeNull();
  });
});

describe("a draft deck", () => {
  it("editing the options clears the freeze, and the next view freezes the newly snapshotted prices", async () => {
    const { deal } = await seedDeck();
    await call("GET", `/api/deals/${deal.id}/deck.html`);
    expect((await getDeal(env.DB, deal.id))!.deckFrozenAt).not.toBeNull();
    const edited = [OPTIONS[0], { ...OPTIONS[1], items: [{ key: "quick_fix", setupDiscountCents: 10000 }, { key: "care" }] }, OPTIONS[2]];
    const res = await call("PUT", `/api/deals/${deal.id}/options`, { options: edited });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).deckFrozenAt).toBeNull();
    expect((await getDeal(env.DB, deal.id))!.deckFrozenAt).toBeNull();
    const html = await (await call("GET", `/api/deals/${deal.id}/deck.html`)).text();
    expect(html).toContain("less $100 off setup");
    expect((await getDeal(env.DB, deal.id))!.deckFrozenAt).not.toBeNull();
  });

  it("a new recap clears the freeze", async () => {
    const { deal } = await seedDeck();
    await stampDeckFrozen(env.DB, deal.id);
    expect((await getDeal(env.DB, deal.id))!.deckFrozenAt).not.toBeNull();
    await env.DB.batch([saveRecapStmt(env.DB, deal.id, RECAP, offerOf(OPTIONS, await listCurrentPackages(env.DB)))]);
    expect((await getDeal(env.DB, deal.id))!.deckFrozenAt).toBeNull();
  });
});
