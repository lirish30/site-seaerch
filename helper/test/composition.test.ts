import { describe, expect, it } from "vitest";
import { END_CARD_MS, GAP_MS, GSAP_SRI, GSAP_URL, MARKUP_AT_MS, buildComposition, calloutBox, type RenderPlan } from "../src/render/composition.ts";

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

describe("the page's one network dependency", () => {
  it("the GSAP script is pinned and carries its integrity hash and crossorigin", () => {
    const h = html();
    const tag = h.match(/<script [^>]*src="[^"]*gsap[^"]*"[^>]*>/)![0];
    expect(tag).toContain(`src="${GSAP_URL}"`);
    expect(GSAP_URL).toMatch(/gsap@\d+\.\d+\.\d+\/dist\/gsap\.min\.js$/); // an exact version, never a range or "latest"
    expect(tag).toContain(`integrity="${GSAP_SRI}"`);
    expect(GSAP_SRI).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    expect(tag).toContain('crossorigin="anonymous"');
  });

  it("the page asks no font service for anything and names only system fonts", () => {
    const h = html();
    expect(h).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(h).not.toMatch(/@import|@font-face|<link /);
    expect(h).toMatch(/font-family:-apple-system/);
    // the only absolute URL anywhere in the page is the pinned script
    expect([...h.matchAll(/https?:\/\/[^"'\s)]+/g)].map((m) => m[0])).toEqual([GSAP_URL]);
  });
});

describe("calloutBox", () => {
  const W = 1280, H = 2400;
  /** The box's left and right sides in the picture, from what calloutBox says. */
  const span = (b: ReturnType<typeof calloutBox>): [number, number] => (b.anchor === "left" ? [b.edge, b.edge + b.width] : [W - b.edge - b.width, W - b.edge]);
  const inside = (b: ReturnType<typeof calloutBox>) => { const [l, r] = span(b); expect(l).toBeGreaterThanOrEqual(0); expect(r).toBeLessThanOrEqual(W + 1e-6); expect(b.top).toBeGreaterThanOrEqual(0); };
  const text = (n: number) => "x".repeat(n);

  it("a short callout keeps its anchor", () => {
    const left = calloutBox({ x: 0.2, y: 0.3, text: "No padlock" }, W, H, 30);
    expect(left).toMatchObject({ anchor: "left", edge: 0.2 * W, wraps: false });
    const right = calloutBox({ x: 0.9, y: 0.3, text: "No padlock" }, W, H, 30);
    expect(right).toMatchObject({ anchor: "right", edge: W - 0.9 * W, wraps: false });
    inside(left); inside(right);
  });

  it("a long callout near the right edge stays inside the image", () => {
    for (const x of [0.6, 0.8, 0.95, 1]) {
      const b = calloutBox({ x, y: 0.5, text: text(40) }, W, H, 30);
      inside(b);
    }
    // 40 characters need about 700 px; at x 0.6 there is room to the left, so it flips rather than wraps
    const b = calloutBox({ x: 0.6, y: 0.5, text: text(40) }, W, H, 30);
    expect(b.wraps).toBe(false);
  });

  it("a long callout near the left edge stays inside the image", () => {
    for (const x of [0, 0.05, 0.3, 0.5]) inside(calloutBox({ x, y: 0.5, text: text(45) }, W, H, 30));
    // x 0.5 with 45 characters (about 800 px) fits neither side as one line of this width, so it is moved in, not cut
    const edge = calloutBox({ x: 0.05, y: 0.5, text: text(45) }, W, H, 30);
    expect(edge.anchor).toBe("left");
  });

  it("a 60-character callout at x 0.5 fits", () => {
    const b = calloutBox({ x: 0.5, y: 0.5, text: text(60) }, W, H, 30);
    inside(b);
    expect(b.wraps).toBe(true);
    expect(b.width).toBeLessThanOrEqual(0.7 * W);
    // nothing is shortened: the page carries all 60 characters, wrapping inside a max-width
    const p = plan();
    p.segments[0].markups = [{ type: "callout", x: 0.5, y: 0.5, text: text(60) }];
    const h = html(build(p));
    const tag = h.match(/<div[^>]*data-markup="callout"[^>]*>[^<]*<\/div>/)![0];
    expect(tag).toContain(text(60));
    expect(tag).toMatch(/max-width:\s*\d+/);
    expect(tag).toContain("white-space:normal");
  });

  it("a callout near the bottom is lifted so it does not run off the picture", () => {
    const b = calloutBox({ x: 0.5, y: 1, text: text(60) }, W, 600, 30);
    expect(b.top).toBeLessThan(600);
    expect(b.top).toBeGreaterThanOrEqual(0);
  });

  it("scales with the zoom: the same words need a wider box when the camera is further out", () => {
    const near = calloutBox({ x: 0.5, y: 0.5, text: text(30) }, W, H, 30);
    const far = calloutBox({ x: 0.5, y: 0.5, text: text(30) }, W, H, 100);
    expect(far.width).toBeGreaterThan(near.width);
    inside(far);
  });
});
