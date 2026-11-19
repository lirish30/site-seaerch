import { describe, expect, it } from "vitest";
import { END_CARD_MS, GAP_MS, MARKUP_AT_MS, buildComposition, type RenderPlan } from "../src/render/composition.ts";

const brand = { name: "Logan Irish", business: "Siteline" };
const cta = "Book a free call: hellositeline.com/book";

const plan = (over: Partial<RenderPlan> = {}): RenderPlan => ({
  shots: [{ id: "d1", width: 1280, height: 2400, fullKey: "video/v/shots/d1.jpg" }, { id: "m1", width: 390, height: 844, fullKey: "video/v/shots/m1.png" }],
  segments: [
    { id: "s1", role: "hook", shotId: "d1", markups: [{ type: "circle", x: 0.5, y: 0.2, r: 0.1 }], audio: { key: "video/v/audio/s1.wav", source: "clone", durationMs: 1111 } },
    { id: "s2", role: "problem", shotId: "d1", markups: [], audio: { key: "video/v/audio/s2.wav", source: "clone", durationMs: 2222 } },
    { id: "s3", role: "cta", shotId: "m1", focus: { x: 0.1, y: 0.1, w: 0.5, h: 0.3 }, markups: [{ type: "callout", x: 0.2, y: 0.3, text: "No padlock" }, { type: "blur", x: 0.6, y: 0.6, w: 0.2, h: 0.1 }], audio: { key: "video/v/audio/s3.wav", source: "recorded", durationMs: 3333 } },
  ],
  ...over,
});
const durations = { s1: 4000, s2: 3000, s3: 5000 };
const build = (p = plan(), d: Record<string, number> = durations) => buildComposition({ plan: p, durationsMs: d, brand, ctaText: cta });
const html = (r = build()) => r.files["index.html"];

/** The absolute start (ms) of every markup of one kind, in document order. */
const appearTimes = (h: string, type: string): number[] => [...h.matchAll(new RegExp(`data-markup="${type}"[^>]*data-at-ms="(\\d+)"`, "g"))].map((m) => Number(m[1]));

describe("buildComposition", () => {
  it("total length is the sum of lines, gaps and the end card", () => {
    const r = build();
    // 4000 + 3000 + 5000 of speech, a 350 ms gap after each line (the last one leads into the end card), then the end card.
    expect(r.totalMs).toBe(12_000 + 3 * GAP_MS + END_CARD_MS);
    expect(r.totalMs).toBe(17_050);
    expect(html(r)).toContain('data-duration="17.05"');
  });

  it("scene starts follow the audio durations, not the stored ones", () => {
    const r = build();
    expect(r.sceneStartsMs).toEqual([0, 4000 + GAP_MS, 4000 + GAP_MS + 3000 + GAP_MS]);
    // The plan stored 1111 / 2222 / 3333 ms; none of them is used.
    const h = html(r);
    expect(h).toContain('data-start="4.35"');
    expect(h).toContain('data-start="7.7"');
    expect(h).not.toContain("1.111");
    expect(h).not.toContain("2.222");
  });

  it("each line's audio starts with its scene", () => {
    const h = html();
    const audios = [...h.matchAll(/<audio [^>]*src="([^"]+)"[^>]*data-start="([\d.]+)"/g)].map((m) => [m[1], Number(m[2])]);
    expect(audios).toEqual([["assets/line-s1.wav", 0], ["assets/line-s2.wav", 4.35], ["assets/line-s3.wav", 7.7]]);
  });

  it("markups appear 400 ms into their own scene only", () => {
    const r = build();
    const h = html(r);
    expect(MARKUP_AT_MS).toBe(400);
    expect(appearTimes(h, "circle")).toEqual([r.sceneStartsMs[0] + 400]);
    expect(appearTimes(h, "callout")).toEqual([r.sceneStartsMs[2] + 400]);
    // The scene with no markups has none, and each markup sits inside its own scene's element.
    const scene = (i: number) => h.slice(h.indexOf(`id="sc${i}"`), h.indexOf(`id="sc${i + 1}"`) === -1 ? undefined : h.indexOf(`id="sc${i + 1}"`));
    expect(scene(0)).toContain('data-markup="circle"');
    expect(scene(1)).not.toContain("data-markup=");
    expect(scene(2)).toContain('data-markup="callout"');
    expect(scene(2)).not.toContain('data-markup="circle"');
  });

  it("several markups in one scene appear in order", () => {
    const p = plan();
    p.segments[0].markups = [{ type: "circle", x: 0.1, y: 0.1, r: 0.05 }, { type: "arrow", from: { x: 0.1, y: 0.1 }, to: { x: 0.4, y: 0.4 } }, { type: "callout", x: 0.5, y: 0.5, text: "Here" }];
    const h0 = html(build(p));
    const h = h0.slice(0, h0.indexOf('id="sc1"')); // this scene only
    const at = [...h.matchAll(/data-markup="(?:circle|arrow|callout)"[^>]*data-at-ms="(\d+)"/g)].map((m) => Number(m[1]));
    expect(at[0]).toBe(400);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(new Set(at).size).toBe(3);
  });

  it("blur covers the whole scene", () => {
    const r = build();
    const h = html(r);
    const blur = h.match(/<div[^>]*data-markup="blur"[^>]*>/)![0];
    expect(blur).not.toContain("data-at-ms"); // not faded in: it is there from the scene's first frame
    expect(blur).not.toMatch(/opacity:\s*0/);
    expect(h).toMatch(/filter:\s*blur\(/);
    // and the timeline never tweens it
    expect(h.match(/<script>[\s\S]*<\/script>/)![0]).not.toContain("#m2-1");
  });

  it("the same input gives the same files", () => {
    expect(build()).toEqual(build());
    expect(JSON.stringify(build(plan()))).toBe(JSON.stringify(build(JSON.parse(JSON.stringify(plan())))));
  });

  it("a missing audio file is a clear error", () => {
    expect(() => build(plan(), { s1: 4000, s3: 5000 })).toThrow(/s2.*audio|audio.*s2/);
    expect(() => build(plan(), { s1: 4000, s2: 0, s3: 5000 })).toThrow(/s2/);
    const noShot = plan(); noShot.segments[1].shotId = "zzz";
    expect(() => build(noShot)).toThrow(/zzz/);
  });

  it("is 1280 by 720 and the end card shows the brand, the business and the call to action", () => {
    const h = html();
    expect(h).toContain('data-width="1280"');
    expect(h).toContain('data-height="720"');
    const card = h.slice(h.indexOf('id="end"'));
    expect(card).toContain("Logan Irish");
    expect(card).toContain("Siteline");
    expect(card).toContain("Book a free call: hellositeline.com/book");
    expect(card).toContain(`data-start="${(17_050 - END_CARD_MS) / 1000}"`);
  });

  it("text from the plan is escaped", () => {
    const p = plan();
    p.segments[2].markups = [{ type: "callout", x: 0.2, y: 0.3, text: '<script>alert("x")</script> & more' }];
    const r = buildComposition({ plan: p, durationsMs: durations, brand: { name: "A <b>", business: "B & C" }, ctaText: "go <now>" });
    const h = r.files["index.html"];
    expect(h).not.toContain('<script>alert("x")');
    expect(h).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more");
    expect(h).toContain("A &lt;b&gt;");
    expect(h).toContain("B &amp; C");
    expect(h).toContain("go &lt;now&gt;");
  });

  it("draws are clamped to the image: a markup that runs past the edge is cut off", () => {
    const p = plan();
    // The blur box x + w is 1.4, the circle is centred on the corner and wider than the image.
    p.segments[0].markups = [{ type: "blur", x: 0.8, y: 0.9, w: 0.6, h: 0.5 }, { type: "circle", x: 1, y: 1, r: 0.9 }];
    const h = html(build(p));
    const blur = h.match(/<div[^>]*data-markup="blur"[^>]*>/)![0];
    expect(blur).toMatch(/left:\s*1024px/); // 0.8 of 1280
    expect(blur).toMatch(/width:\s*256px/); // only what is left of the image: 0.2 of 1280, not 0.6
    expect(blur).toMatch(/top:\s*2160px/);
    expect(blur).toMatch(/height:\s*240px/); // 0.1 of 2400
    // the stage that holds every markup is the image's size and cuts off whatever sticks out
    expect(h).toMatch(/\.world\{[^}]*overflow:\s*hidden/);
    expect(h).toContain('style="width:1280px;height:2400px"');
  });

  it("a focus is where the camera ends up; with none it is the whole shot", () => {
    const h = html();
    // scene 2 (the mobile shot) zooms to its focus: 390 x 844, focus 195 x 253.2 -> scale 720/253.2
    expect(h).toMatch(/tl\.fromTo\("#w2",\s*\{[^}]*\},\s*\{[^}]*scale:\s*2\.84\d*/);
    // scene 1 has none: the whole 1280 x 2400 shot fits a 720-high frame, so scale 0.3
    expect(h).toMatch(/tl\.fromTo\("#w1",[^;]*scale:\s*0\.3\b/);
  });

  it("an empty script makes only the end card", () => {
    const r = buildComposition({ plan: { shots: [], segments: [] }, durationsMs: {}, brand, ctaText: cta });
    expect(r.sceneStartsMs).toEqual([]);
    expect(r.totalMs).toBe(END_CARD_MS);
  });
});
