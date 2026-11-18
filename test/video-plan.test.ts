import { describe, it, expect } from "vitest";
import { DraftPlanSchema, SCRIPT_MS, checkPlanAgainst, estimateDurationMs, hashText, lineStale, planDurationMs,
  type Segment, type Shot } from "../src/worker/video/plan";

const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");
const shot = (id: string): Shot => ({ id, viewport: "desktop", scrollY: 0, width: 1440, height: 900, fullKey: `video/${id}/full.png`, previewKey: `video/${id}/preview.jpg` });
const seg = (id: string, role: Segment["role"], o: Partial<Segment> = {}): Segment => ({ id, role, text: words(20), shotId: "s1", markups: [], ...o });
const draft = (): { segments: Omit<Segment, "audio">[] } => ({
  segments: [
    seg("a", "hook"),
    seg("b", "problem", { findingCode: "slow_mobile" }),
    seg("c", "problem", { findingCode: "no_contact_form" }),
    seg("d", "problem", { findingCode: "stale_copyright" }),
    seg("e", "offer"),
    seg("f", "cta"),
  ],
});
const withSegments = (segments: Omit<Segment, "audio">[]) => ({ segments });

describe("DraftPlanSchema", () => {
  it("accepts a hook, three problems, an offer and a cta", () => {
    expect(DraftPlanSchema.safeParse(draft()).success).toBe(true);
  });

  it("rejects two offers", () => {
    const d = draft();
    d.segments[4] = seg("e", "offer");
    d.segments.splice(5, 0, seg("e2", "offer"));
    expect(DraftPlanSchema.safeParse(d).success).toBe(false);
  });

  it("rejects four problems", () => {
    const d = draft();
    d.segments.splice(4, 0, seg("p4", "problem", { findingCode: "no_https" }));
    expect(DraftPlanSchema.safeParse(d).success).toBe(false);
  });

  it("rejects repeated finding codes", () => {
    const d = draft();
    d.segments[3] = seg("d", "problem", { findingCode: "slow_mobile" });
    expect(DraftPlanSchema.safeParse(d).success).toBe(false);
  });

  it("rejects a coordinate of 1.2", () => {
    const d = draft();
    d.segments[1].markups = [{ type: "circle", x: 1.2, y: 0.5, r: 0.1 }];
    expect(DraftPlanSchema.safeParse(d).success).toBe(false);
    d.segments[1].markups = [{ type: "circle", x: 0.5, y: 0.5, r: 0.1 }];
    expect(DraftPlanSchema.safeParse(d).success).toBe(true);
    d.segments[1].focus = { x: 0.2, y: 0.2, w: 1.2, h: 0.3 };
    expect(DraftPlanSchema.safeParse(d).success).toBe(false);
  });

  it("rejects a 70-word line", () => {
    const d = draft();
    d.segments[0].text = words(70);
    expect(DraftPlanSchema.safeParse(d).success).toBe(false);
    d.segments[0].text = words(60);
    expect(DraftPlanSchema.safeParse(d).success).toBe(true);
    d.segments[0].text = words(4);
    expect(DraftPlanSchema.safeParse(d).success).toBe(false);
  });

  it("rejects a hook that is not first, a cta that is not last, more than six markups, and a long callout", () => {
    const d = draft();
    expect(DraftPlanSchema.safeParse(withSegments([...d.segments].reverse())).success).toBe(false);
    const m = draft();
    m.segments[1].markups = Array.from({ length: 7 }, () => ({ type: "blur" as const, x: 0, y: 0, w: 0.1, h: 0.1 }));
    expect(DraftPlanSchema.safeParse(m).success).toBe(false);
    const c = draft();
    c.segments[1].markups = [{ type: "callout", x: 0.1, y: 0.1, text: "x".repeat(61) }];
    expect(DraftPlanSchema.safeParse(c).success).toBe(false);
    c.segments[1].markups = [{ type: "callout", x: 0.1, y: 0.1, text: "two\nlines" }];
    expect(DraftPlanSchema.safeParse(c).success).toBe(false);
  });
});

describe("duration", () => {
  it("a 225-word script estimates 90 seconds", () => {
    expect(estimateDurationMs(words(225))).toBe(90_000);
  });

  it("planDurationMs adds a 350 ms gap between lines", () => {
    const segs = [seg("a", "hook", { text: words(150) }), seg("b", "cta", { text: words(150) })];
    expect(planDurationMs(segs)).toBe(60_000 + 60_000 + 350);
    expect(planDurationMs([segs[0]])).toBe(60_000);
    expect(planDurationMs([])).toBe(0);
  });

  it("a 40-second script is outside the window", () => {
    const segs = [seg("a", "hook", { text: words(100) })]; // 40 s
    const problems = checkPlanAgainst({ shots: [shot("s1")], segments: segs }, []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/seconds/);
    expect(SCRIPT_MS).toEqual({ min: 80_000, max: 130_000 });
  });
});

describe("checkPlanAgainst", () => {
  it("names an unknown shot and an unknown finding code", () => {
    const segs = [seg("a", "hook", { text: words(225), shotId: "nope" }), seg("b", "problem", { text: words(10), findingCode: "ghost" })];
    const problems = checkPlanAgainst({ shots: [shot("s1")], segments: segs }, ["slow_mobile"]);
    expect(problems.some((p) => p.includes("nope"))).toBe(true);
    expect(problems.some((p) => p.includes("ghost"))).toBe(true);
  });

  it("returns nothing for a plan inside the window with known references", () => {
    const segs = [seg("a", "hook", { text: words(225), findingCode: "slow_mobile" })];
    expect(checkPlanAgainst({ shots: [shot("s1")], segments: segs }, ["slow_mobile"])).toEqual([]);
  });
});

describe("lineStale", () => {
  it("is true after the text changes", () => {
    const s = seg("a", "hook", { text: "Hello there Ace Plumbing, this is a quick look." });
    expect(lineStale(s)).toBe(true); // no audio yet
    const voiced: Segment = { ...s, audio: { key: "k", source: "clone", durationMs: 3000, textHash: hashText(s.text) } };
    expect(lineStale(voiced)).toBe(false);
    expect(lineStale({ ...voiced, text: `${s.text} Changed.` })).toBe(true);
  });

  it("hashText is a stable 8-char hex string", () => {
    expect(hashText("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });
});
