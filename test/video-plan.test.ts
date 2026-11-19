import { describe, it, expect } from "vitest";
import { DraftPlanSchema, SegmentSchema, MarkupSchema, SCRIPT_MS, approvalBlockers, checkPlanAgainst, planStructureProblems, estimateDurationMs, hashText, lineStale, planDurationMs,
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

describe("MarkupSchema", () => {
  it("an empty callout text is a valid draft state", () => {
    expect(MarkupSchema.safeParse({ type: "callout", x: 0.1, y: 0.1, text: "" }).success).toBe(true);
    expect(MarkupSchema.safeParse({ type: "callout", x: 0.1, y: 0.1, text: "x".repeat(61) }).success).toBe(false);
    expect(MarkupSchema.safeParse({ type: "callout", x: 0.1, y: 0.1, text: "two\nlines" }).success).toBe(false);
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

describe("segment ids", () => {
  const withId = (id: string) => SegmentSchema.safeParse(seg(id, "hook")).success;
  it("a segment id with a slash is rejected", () => {
    expect(withId("a/b")).toBe(false);
    expect(withId("../x")).toBe(false);
    expect(withId("a b")).toBe(false);
  });
  it("a 41-character segment id is rejected", () => {
    expect(withId("a".repeat(41))).toBe(false);
    expect(withId("a".repeat(40))).toBe(true);
  });
  it("plain ids pass, and the draft schema applies the same rule", () => {
    for (const id of ["s1", "line_2", "hook-A"]) expect(withId(id), id).toBe(true);
    const d = draft();
    d.segments[0].id = "bad/id";
    expect(DraftPlanSchema.safeParse(d).success).toBe(false);
  });
});

describe("script structure", () => {
  const plan = (segments: Segment[]) => ({ shots: [shot("s1")], segments, narration: "clone" as const, version: 1 });
  const good = () => draft().segments as Segment[];

  it("planStructureProblems is empty for a hook, three problems, an offer and a cta", () => {
    expect(planStructureProblems(good())).toEqual([]);
  });

  it("names every way the structure can be wrong", () => {
    const g = good();
    expect(planStructureProblems([g[0], g[0], g[1], g[2], g[3], g[4], g[5]]).join(" ")).toMatch(/exactly one hook/);
    expect(planStructureProblems(g.filter((s) => s.role !== "offer")).join(" ")).toMatch(/exactly one offer/);
    expect(planStructureProblems(g.slice(0, 5)).join(" ")).toMatch(/last segment must be the cta/);
    expect(planStructureProblems(g.filter((s) => s.id !== "d")).join(" ")).toMatch(/exactly 3 problem segments, got 2/);
    expect(planStructureProblems(g.map((s) => (s.id === "d" ? { ...s, findingCode: "slow_mobile" } : s))).join(" ")).toMatch(/distinct findingCodes/);
  });

  it("approvalBlockers blocks a line under 5 words or over 60 words, as the draft schema does", () => {
    const w = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    const codes = ["slow_mobile", "no_contact_form", "stale_copyright"];
    const withText = (i: number, text: string) => plan(good().map((s, j) => (j === i ? { ...s, text } : s)));
    const short = approvalBlockers(withText(1, "Too short"), codes);
    expect(short.join(" ")).toMatch(/Line 2 has 2 words; each line needs 5 to 60 words/);
    expect(approvalBlockers(withText(1, "one"), codes).join(" ")).toMatch(/Line 2 has 1 word; each line needs 5 to 60 words/);
    expect(approvalBlockers(withText(1, w(61)), codes).join(" ")).toMatch(/Line 2 has 61 words/);
    expect(approvalBlockers(withText(1, w(5)), codes).filter((b) => /words; each line/.test(b))).toEqual([]);
    expect(approvalBlockers(withText(1, w(60)), codes).filter((b) => /words; each line/.test(b))).toEqual([]);
    expect(approvalBlockers(withText(1, ""), codes).filter((b) => /words; each line/.test(b))).toEqual([]); // that one is "has no words"
  });

  it("approvalBlockers lists a saved plan whose structure was edited away, and a good plan has none of them", () => {
    const codes = ["slow_mobile", "no_contact_form", "stale_copyright"];
    const withTwoHooks = good().map((s) => (s.id === "e" ? { ...s, role: "hook" as const } : s));
    const blockers = approvalBlockers(plan(withTwoHooks), codes);
    expect(blockers.some((b) => /exactly one hook/.test(b))).toBe(true);
    expect(blockers.some((b) => /exactly one offer/.test(b))).toBe(true);
    expect(approvalBlockers(plan(good()), codes).filter((b) => /right shape/.test(b))).toEqual([]);
  });
});
