import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { cropView, itemCrop } from "../src/worker/cro/crop";
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
