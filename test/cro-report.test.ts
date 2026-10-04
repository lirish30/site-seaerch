import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { cropView, itemCrop } from "../src/worker/cro/crop";
import { clip, splitItems } from "../src/worker/report/cro";
import type { RankedItem } from "../src/worker/cro/types";
import { reportFor } from "../src/worker/report/data";
import { renderDoc } from "../src/worker/report/html";
import { createCroAudit, listCroItems, replaceCroItems, updateCroAudit, updateCroItem } from "../src/worker/db/cro";
import { shotKey } from "../src/worker/cro/pipeline";
import { defaultScenario } from "../src/worker/cro/scenario";
import { seedBusiness, seedLeadAudit, model, ranked, ev } from "./fixtures/cro";

const crop = { x: 100, y: 200, w: 120, h: 40, device: "desktop" as const, pageIndex: 0 };

describe("crop helpers", () => {
  it("frames the element with padding, scaled to the display width, with the pin at its centre", () => {
    expect(cropView(crop, 520)).toEqual({ width: 520, height: 195, bgWidth: 2340, bgX: -98, bgY: -260, markerX: 163, markerY: 98 });
  });
  it("keeps the pin inside the box for an element taller than the max height", () => {
    const v = cropView({ ...crop, h: 900 }, 520);
    expect(v.height).toBe(439);
    expect(v.markerY).toBe(v.height);
    expect(v.markerX).toBe(163);
  });
  it("stays finite and inside the box for an element at or beyond the shot edge", () => {
    for (const c of [{ ...crop, x: 2000, w: 50 }, { ...crop, x: 1440, w: 0, h: 0 }, { ...crop, device: "mobile" as const, x: 380, w: 50 }, { ...crop, x: -50, w: 10, h: -5 }]) {
      const v = cropView(c, 520);
      for (const n of Object.values(v)) expect(Number.isFinite(n)).toBe(true);
      expect(v.height).toBeGreaterThan(0);
      expect(v.markerX).toBeGreaterThanOrEqual(0); expect(v.markerX).toBeLessThanOrEqual(v.width);
      expect(v.markerY).toBeGreaterThanOrEqual(0); expect(v.markerY).toBeLessThanOrEqual(v.height);
      expect(v.bgWidth).toBeLessThan(10000);
    }
  });
  it("finds the first cited evidence with a screenshot location", () => {
    expect(itemCrop({ evidence_ids: ["E2", "E1"] }, [ev("E1", { crop }), ev("E2")])).toEqual(crop);
    expect(itemCrop({ evidence_ids: ["E2"] }, [ev("E2")])).toBeNull();
  });
});

describe("deck CRO chapter", () => {
  it("adds the chapter with included items only, escaped, with screenshot crops and the scenario label", async () => {
    const b = await seedBusiness();
    await seedLeadAudit(b.id);
    const a = await createCroAudit(env.DB, b.id);
    await updateCroAudit(env.DB, a.id, { status: "done", step: "done", business_model: model(), strengths: ["Real photos"],
      positioning: { says_now: "Welcome to Our Website", should_say: "Boise's same-day plumbers" },
      tracking_plan: [{ event: "call_click", why: "Calls are the main lead" }], scenario_inputs: defaultScenario(model()), evidence: [ev("E1", { crop })] });
    await replaceCroItems(env.DB, a.id, [ranked({ title: "Header <b>button</b>", rank: 1 }), ranked({ title: "Hidden one", rank: 2 }),
      ranked({ title: "Later thing", rank: 6, horizon: 60 })]);
    const hidden = (await listCroItems(env.DB, a.id)).find((i) => i.title === "Hidden one")!;
    await updateCroItem(env.DB, hidden.id, { included: false });
    await env.RAW.put(shotKey(a.id, 0, "desktop"), new Uint8Array([9, 9]));

    const r = (await reportFor(env, b.id))!;
    expect(r.html).toContain("How your website makes money");
    expect(r.html).toContain("Header &lt;b&gt;button&lt;/b&gt;");
    expect(r.html).not.toContain("Hidden one");
    expect(r.html).toContain("Days 31–60");
    expect(r.html).toContain("Illustrative, based on the assumptions shown");
    expect(r.html).toContain(".cro-shot-0-desktop{background-image:url(data:image/jpeg;base64,CQk=)}");
    expect(r.html).toContain('class="cro-crop cro-shot-0-desktop"');
    expect(r.html.indexOf("How your website makes money")).toBeLessThan(r.html.indexOf("Recommended next step"));
    expect(renderDoc(r.data, null)).toContain("Conversion roadmap");
  });

  it("leaves the deck unchanged without a finished CRO audit", async () => {
    const b = await seedBusiness();
    await seedLeadAudit(b.id);
    await createCroAudit(env.DB, b.id);
    const r = (await reportFor(env, b.id))!;
    expect(r.html).not.toContain("How your website makes money");
    expect(renderDoc(r.data, null)).not.toContain("Conversion roadmap");
  });
});

async function seedDone(items: RankedItem[], audit: Record<string, unknown> = {}) {
  const b = await seedBusiness();
  await seedLeadAudit(b.id);
  const a = await createCroAudit(env.DB, b.id);
  await updateCroAudit(env.DB, a.id, { status: "done", step: "done", business_model: model(), strengths: ["Real photos"],
    tracking_plan: [], scenario_inputs: null, evidence: [ev("E1", { crop })], ...audit });
  await replaceCroItems(env.DB, a.id, items);
  return { b, a };
}
const slideCount = (html: string) => (html.match(/class="slide cro cro-item"/g) ?? []).length;
const XSS = '<img src=x onerror=alert(1)>';

describe("deck CRO chapter edge cases", () => {
  it("escapes every audited field in the deck and the doc", async () => {
    const { b } = await seedDone(
      [ranked({ title: `T ${XSS}`, observation: `O ${XSS}`, change: `C ${XSS}`, why: `W ${XSS}`, we_can_do_it: `Offer ${XSS}`, rank: 1 })],
      { strengths: [`S ${XSS}`], positioning: { says_now: `Says ${XSS}`, should_say: `Should ${XSS}` },
        tracking_plan: [{ event: `ev ${XSS}`, why: `why ${XSS}` }], model_overrides: { primary_conversion: `Goal ${XSS}` } });
    const r = (await reportFor(env, b.id))!;
    const doc = renderDoc(r.data, null);
    expect(r.html).not.toContain("<img src=x");
    expect(doc).not.toContain("<img src=x");
    expect(r.html).toContain("Says &lt;img src=x onerror=alert(1)&gt;");
    expect(doc).toContain("Goal &lt;img src=x onerror=alert(1)&gt;");
    expect(doc).toContain("Change: C &lt;img");
  });

  it("makes the mode label visible on CRO slides", async () => {
    const { b } = await seedDone([ranked()]);
    const r = (await reportFor(env, b.id))!;
    expect(r.html).toContain(".cro h2 .pill { background:var(--brand); }");
    expect(r.html).toContain('<span class="pill">Just fix</span>');
  });

  it("does not promote a 60-day item to this month when a top item is hidden", async () => {
    const items = [1, 2, 3, 4, 5].map((n) => ranked({ title: `Month item ${n}`, rank: n }))
      .concat(ranked({ title: "Sixty day thing", rank: 6, horizon: 60 }));
    const { b, a } = await seedDone(items);
    const two = (await listCroItems(env.DB, a.id)).find((i) => i.title === "Month item 2")!;
    await updateCroItem(env.DB, two.id, { included: false });
    const r = (await reportFor(env, b.id))!;
    expect(slideCount(r.html)).toBe(4);
    expect(r.html).toContain("Do this month · 4 of 4");
    expect(r.html).not.toContain("<h2>Sixty day thing");
    expect(r.html.indexOf("Sixty day thing")).toBeGreaterThan(r.html.indexOf("Your 90-day roadmap"));
    expect(splitItems(r.data.cro!.items).rest.map((i) => i.title)).toEqual(["Sixty day thing"]);
  });

  it("puts extra 30-day items under Also this month and caps a roadmap column with a +N more line", async () => {
    const items = Array.from({ length: 7 }, (_, i) => ranked({ title: `Item ${i + 1}`, rank: i + 1 }))
      .concat(Array.from({ length: 9 }, (_, i) => ranked({ title: `Later ${i + 1}`, rank: 8 + i, horizon: 60 })));
    const { b } = await seedDone(items);
    const r = (await reportFor(env, b.id))!;
    expect(slideCount(r.html)).toBe(5);
    const road = r.html.slice(r.html.indexOf("Your 90-day roadmap"));
    const also = road.slice(road.indexOf("Also this month"), road.indexOf("Days 31–60"));
    expect(also).toContain("<li>Item 6</li>");
    expect(also).toContain("<li>Item 7</li>");
    const sixty = road.slice(road.indexOf("Days 31–60"), road.indexOf("Days 61–90"));
    expect(sixty).toContain("<li>Later 6</li>");
    expect(sixty).not.toContain("Later 7");
    expect(sixty).toContain("+3 more");
  });

  it("shortens long text at a word boundary before escaping, but keeps the full text in the doc", async () => {
    const long = "word ".repeat(100).trim();
    const { b } = await seedDone([ranked({ observation: long, title: `${"Title ".repeat(30)}<b>`, we_can_do_it: long })]);
    const r = (await reportFor(env, b.id))!;
    expect(r.html).toContain("<p>word word");
    expect(r.html).not.toContain(long);
    expect(r.html).toMatch(/word…<\/p>/);
    expect(renderDoc(r.data, null)).toContain(long);
    expect(clip("short", 10)).toBe("short");
    expect(clip("alpha beta gamma delta", 14)).toBe("alpha beta…");
    expect(clip("x".repeat(30), 10)).toBe(`${"x".repeat(9)}…`);
    expect(clip("a <b> & c", 4)).toBe("a <…"); // clipped before escaping, so no entity is ever cut in half
  });

  it("renders a done audit with no included items without empty lists or item slides", async () => {
    const { b, a } = await seedDone([ranked({ title: "Only one" })]);
    const only = (await listCroItems(env.DB, a.id))[0];
    await updateCroItem(env.DB, only.id, { included: false });
    const r = (await reportFor(env, b.id))!;
    expect(r.html).toContain("How your website makes money");
    expect(slideCount(r.html)).toBe(0);
    expect(r.html).not.toContain("Only one");
    const doc = renderDoc(r.data, null);
    expect(doc).toContain("Conversion roadmap");
    expect(doc).not.toContain("<ol></ol>");
  });

  it("omits the chapter instead of failing the deck when loading it errors", async () => {
    const { b } = await seedDone([ranked()]);
    const broken = { DB: env.DB, RAW: { get: async () => { throw new Error("r2 down"); } } as unknown as R2Bucket };
    const r = (await reportFor(broken, b.id))!;
    expect(r.html).not.toContain("How your website makes money");
    expect(r.data.cro).toBeNull();
    expect(r.html).toContain("Recommended next step");
  });
});
