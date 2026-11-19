import { describe, it, expect } from "vitest";
import {
  addMarkup, approveBlockers, canCancel, editorMode, isWatching, lineVoice, mergeSaved, moveMarkup, moveArrowEnd, removeMarkup, replaceMarkup, resizeMarkup, scriptSummary, setSegmentShot, setSegmentText,
  shotLabel, videoStateLine, publishState, canReopen, hasPlayer, canUnpublish, lastAttemptNotice,
} from "../src/client/videoView";
import { MAX_MARKUPS, hashText, type Markup, type Segment, type VideoPlan } from "../src/worker/video/plan";

const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");
const shot = (id: string) => ({ id, viewport: "desktop" as const, scrollY: 0, width: 1280, height: 720, fullKey: `k/${id}.jpg`, previewKey: `k/${id}.preview.jpg` });
const seg = (id: string, o: Partial<Segment> = {}): Segment => ({ id, role: "problem", findingCode: "no_cta", text: words(30), shotId: "d1", markups: [], ...o });
/** A plan that passes every check: about 100 seconds of speech over real shots and findings. */
const goodPlan = (o: Partial<VideoPlan> = {}): VideoPlan => ({
  shots: [shot("d1"), shot("d2")],
  segments: [
    seg("s1", { role: "hook", findingCode: undefined, text: words(30) }),
    seg("s2", { findingCode: "no_https", text: words(50) }),
    seg("s3", { findingCode: "no_cta", text: words(50), shotId: "d2" }),
    seg("s4", { findingCode: "slow_mobile", text: words(50) }),
    seg("s5", { role: "offer", findingCode: undefined, text: words(40) }),
    seg("s6", { role: "cta", findingCode: undefined, text: words(30) }),
  ],
  narration: "clone", version: 1, ...o,
});
const CODES = ["no_https", "no_cta", "slow_mobile"];

describe("moveMarkup", () => {
  it("moveMarkup clamps at the edges", () => {
    const circle: Markup = { type: "circle", x: 0.95, y: 0.05, r: 0.1 };
    expect(moveMarkup(circle, 0.2, -0.2)).toEqual({ type: "circle", x: 1, y: 0, r: 0.1 });
    expect(moveMarkup(circle, -3, 3)).toEqual({ type: "circle", x: 0, y: 1, r: 0.1 });
    const callout: Markup = { type: "callout", x: 0.5, y: 0.5, text: "hi" };
    expect(moveMarkup(callout, 0.1, 0.1)).toEqual({ type: "callout", x: 0.6, y: 0.6, text: "hi" });
  });

  it("keeps a blur box and an arrow whole on the shot", () => {
    const blur: Markup = { type: "blur", x: 0.7, y: 0.4, w: 0.2, h: 0.1 };
    expect(moveMarkup(blur, 0.5, 0)).toEqual({ type: "blur", x: 0.8, y: 0.4, w: 0.2, h: 0.1 });
    const arrow: Markup = { type: "arrow", from: { x: 0.2, y: 0.5 }, to: { x: 0.9, y: 0.5 } };
    const moved = moveMarkup(arrow, 0.5, 0) as Extract<Markup, { type: "arrow" }>;
    expect(moved.to.x).toBeCloseTo(1);
    expect(moved.from.x).toBeCloseTo(0.3); // the arrow keeps its length when it hits the edge
  });
});

describe("resizing", () => {
  it("grows a circle's radius and a blur's size, within the shot", () => {
    expect(resizeMarkup({ type: "circle", x: 0.5, y: 0.5, r: 0.1 }, 0.05, 0)).toEqual({ type: "circle", x: 0.5, y: 0.5, r: 0.15 });
    expect(resizeMarkup({ type: "circle", x: 0.5, y: 0.5, r: 0.1 }, -1, 0)).toMatchObject({ r: 0.01 });
    expect(resizeMarkup({ type: "blur", x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, 0.5, 0.5)).toEqual({ type: "blur", x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
    const c: Markup = { type: "callout", x: 0.5, y: 0.5, text: "a" };
    expect(resizeMarkup(c, 0.1, 0.1)).toEqual(c);
  });

  it("moves one end of an arrow", () => {
    const a: Markup = { type: "arrow", from: { x: 0.2, y: 0.2 }, to: { x: 0.8, y: 0.8 } };
    expect(moveArrowEnd(a, "to", 0.5, -0.1)).toEqual({ type: "arrow", from: { x: 0.2, y: 0.2 }, to: { x: 1, y: 0.7 } });
    expect(moveArrowEnd(a, "from", -1, 0)).toEqual({ type: "arrow", from: { x: 0, y: 0.2 }, to: { x: 0.8, y: 0.8 } });
  });
});

describe("addMarkup", () => {
  it("addMarkup puts a callout at the centre with empty text rejected by approveBlockers", () => {
    const s = addMarkup(seg("s2", { findingCode: "no_https" }), "callout");
    expect(s.markups).toEqual([{ type: "callout", x: 0.5, y: 0.5, text: "" }]);
    const plan = goodPlan();
    plan.segments[1] = s;
    expect(approveBlockers(plan, CODES).join(" ")).toMatch(/line 2.*callout/i);
    plan.segments[1] = replaceMarkup(s, 0, { type: "callout", x: 0.5, y: 0.5, text: "No booking button" });
    expect(approveBlockers(plan, CODES)).toEqual([]);
  });

  it("puts every kind at the centre and never mutates the segment", () => {
    const base = seg("a");
    for (const type of ["circle", "arrow", "blur", "callout"] as const) {
      const out = addMarkup(base, type);
      expect(out.markups).toHaveLength(1);
      expect(out.markups[0].type).toBe(type);
      const m = out.markups[0];
      const cx = m.type === "arrow" ? (m.from.x + m.to.x) / 2 : m.type === "blur" ? m.x + m.w / 2 : m.x;
      const cy = m.type === "arrow" ? (m.from.y + m.to.y) / 2 : m.type === "blur" ? m.y + m.h / 2 : m.y;
      expect(cx).toBeCloseTo(0.5);
      expect(cy).toBeCloseTo(0.5);
    }
    expect(base.markups).toEqual([]);
  });

  it("stops at the most markups a line may have", () => {
    let s = seg("a");
    for (let i = 0; i < MAX_MARKUPS + 2; i++) s = addMarkup(s, "circle");
    expect(s.markups).toHaveLength(MAX_MARKUPS);
  });

  it("removes and replaces one markup by position", () => {
    const s = addMarkup(addMarkup(seg("a"), "circle"), "blur");
    expect(removeMarkup(s, 0).markups.map((m) => m.type)).toEqual(["blur"]);
    expect(removeMarkup(s, 9)).toEqual(s);
    expect(replaceMarkup(s, 1, { type: "blur", x: 0, y: 0, w: 0.1, h: 0.1 }).markups[1]).toEqual({ type: "blur", x: 0, y: 0, w: 0.1, h: 0.1 });
  });
});

describe("editing a line", () => {
  it("setSegmentText drops the audio when the words change and keeps it when they do not", () => {
    const audio = { key: "a.webm", source: "recorded" as const, durationMs: 4000, textHash: hashText("hello there everyone") };
    const s = seg("a", { text: "hello there everyone", audio });
    expect(setSegmentText(s, "hello there everyone").audio).toEqual(audio);
    expect(setSegmentText(s, "hello there friends").audio).toBeUndefined();
    expect(setSegmentText(s, "hello there friends").text).toBe("hello there friends");
  });

  it("setSegmentShot moves a line to another shot and clears its zoom", () => {
    const s = seg("a", { focus: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    expect(setSegmentShot(s, "d2")).toMatchObject({ shotId: "d2" });
    expect(setSegmentShot(s, "d2").focus).toBeUndefined();
  });
});

describe("scriptSummary", () => {
  it("scriptSummary reports 225 words as 90 seconds and in window", () => {
    const plan = goodPlan({ segments: [seg("only", { text: words(225) })] });
    expect(scriptSummary(plan)).toEqual({ words: 225, seconds: 90, inWindow: true });
  });

  it("is out of the window when too short or too long", () => {
    expect(scriptSummary(goodPlan({ segments: [seg("a", { text: words(100) })] })).inWindow).toBe(false); // 40 s
    expect(scriptSummary(goodPlan({ segments: [seg("a", { text: words(400) })] })).inWindow).toBe(false); // 160 s
    expect(scriptSummary(goodPlan()).inWindow).toBe(true);
  });

  it("counts the pauses between lines the way approval does", () => {
    // 6 lines, 250 words: 100 s of speech + 5 pauses of 0.35 s
    expect(scriptSummary(goodPlan())).toEqual({ words: 250, seconds: 102, inWindow: true });
  });
});

describe("approveBlockers", () => {
  it("is empty for a good plan", () => {
    expect(approveBlockers(goodPlan(), CODES)).toEqual([]);
  });

  it("approveBlockers lists a missing recording for a recorded line", () => {
    const plan = goodPlan({ narration: "recorded" });
    plan.segments[2].audio = { key: "r.webm", source: "recorded", durationMs: 9000, textHash: hashText(plan.segments[2].text) };
    const b = approveBlockers(plan, CODES);
    expect(b).toHaveLength(5);
    expect(b[0]).toMatch(/line 1.*recording/i);
    expect(b.join(" ")).not.toMatch(/line 3/i);
  });

  it("treats a recording of old words as missing", () => {
    const plan = goodPlan({ narration: "recorded" });
    for (const s of plan.segments) s.audio = { key: "r.webm", source: "recorded", durationMs: 1000, textHash: hashText(s.text) };
    expect(approveBlockers(plan, CODES)).toEqual([]);
    plan.segments[0].text = `${plan.segments[0].text} extra`;
    expect(approveBlockers(plan, CODES).join(" ")).toMatch(/line 1.*recording/i);
  });

  it("does not ask for recordings when the voice is cloned", () => {
    expect(approveBlockers(goodPlan({ narration: "clone" }), CODES)).toEqual([]);
  });

  it("includes what the plan check finds: a missing finding, a missing shot, a script that is too short", () => {
    expect(approveBlockers(goodPlan(), ["no_https", "no_cta"]).join(" ")).toMatch(/slow_mobile/);
    const plan = goodPlan();
    plan.segments[0].shotId = "gone";
    expect(approveBlockers(plan, CODES).join(" ")).toMatch(/gone/);
    expect(approveBlockers(goodPlan({ segments: [seg("a", { text: words(20) })] }), CODES).join(" ")).toMatch(/seconds/);
  });

  it("asks for words on an empty line", () => {
    const plan = goodPlan();
    plan.segments[3].text = "   ";
    expect(approveBlockers(plan, CODES).join(" ")).toMatch(/line 4.*no words/i);
  });
});

describe("videoStateLine", () => {
  const line = (status: string, o: { helperOnline?: boolean; error?: string | null } = {}) => videoStateLine({ status, jobs: [], helperOnline: o.helperOnline ?? false, error: o.error });
  it("scripting waits for Claude", () => expect(line("scripting")).toBe("Waiting for Claude. The script will be written in your next queue session."));
  it("review says nothing", () => expect(line("review")).toBe(""));
  it("producing with the helper offline waits for the Mac", () => expect(line("producing")).toBe("Waiting for your Mac. Voice and video are made when the helper is running."));
  it("producing with the helper online is making the video", () => expect(line("producing", { helperOnline: true })).toBe("Making the video."));
  it("rendered is ready to approve", () => expect(line("rendered")).toBe("Ready to approve. Watch it, then approve it in the inbox."));
  it("published is live", () => expect(line("published")).toBe("Live on the report page."));
  it("failed names the error", () => expect(line("failed", { error: "No screenshots" })).toBe("Something went wrong: No screenshots"));
  it("failed with no error still reads", () => expect(line("failed")).toBe("Something went wrong: unknown error"));
  it("says where capturing and cancelled stand", () => {
    expect(line("capturing")).toBe("Taking screenshots of the site.");
    expect(line("cancelled")).toBe("Cancelled.");
  });
});

describe("small helpers", () => {
  it("names shots by kind and position", () => {
    const shots = [shot("d1"), shot("m1"), shot("d2")].map((s) => (s.id.startsWith("m") ? { ...s, viewport: "mobile" as const } : s));
    expect(shotLabel(shots, "d1")).toBe("Desktop 1");
    expect(shotLabel(shots, "d2")).toBe("Desktop 2");
    expect(shotLabel(shots, "m1")).toBe("Phone 1");
    expect(shotLabel(shots, "zz")).toBe("zz");
  });

  it("canCancel is false once a video is finished", () => {
    for (const s of ["capturing", "scripting", "review", "producing", "rendered"]) expect(canCancel(s), s).toBe(true);
    for (const s of ["published", "failed", "cancelled"]) expect(canCancel(s), s).toBe(false);
  });

  it("says what each line's voice is", () => {
    const audio = (text: string) => ({ key: "k", source: "recorded" as const, durationMs: 1, textHash: hashText(text) });
    const s = seg("a", { text: "one two three four five" });
    expect(lineVoice(s, "recorded")).toEqual({ label: "Not recorded yet", needsWork: true });
    expect(lineVoice({ ...s, audio: audio(s.text) }, "recorded")).toEqual({ label: "Recorded", needsWork: false });
    expect(lineVoice({ ...s, audio: audio("old words here now ok") }, "recorded")).toEqual({ label: "Words changed: record it again", needsWork: true });
    expect(lineVoice(s, "clone").needsWork).toBe(false);
    expect(lineVoice({ ...s, audio: audio(s.text) }, "clone").label).toBe("Recorded");
  });

  it("mergeSaved takes the server's version and audio and keeps the editor's own words", () => {
    const local = goodPlan({ version: 3 });
    local.segments[0].text = "typed after the save began for this line";
    const saved = goodPlan({ version: 4 });
    saved.segments[1].audio = { key: "k", source: "recorded", durationMs: 1, textHash: hashText(saved.segments[1].text) };
    local.segments[2].audio = { key: "stale", source: "recorded", durationMs: 1, textHash: "x" };
    const merged = mergeSaved(local, saved);
    expect(merged.version).toBe(4);
    expect(merged.segments[0].text).toBe("typed after the save began for this line");
    expect(merged.segments[1].audio).toEqual(saved.segments[1].audio);
    expect(merged.segments[2].audio).toBeUndefined();
  });
});

describe("editorMode", () => {
  const withLines = { segments: [{}] };
  it("shows only the state while there is no plan or no lines yet, whatever the status", () => {
    for (const status of ["capturing", "scripting", "failed", "cancelled", "review"]) {
      expect(editorMode(status, null), status).toBe("state");
      expect(editorMode(status, { segments: [] }), status).toBe("state");
    }
  });
  it("edits only in review, and shows the plan read-only otherwise", () => {
    expect(editorMode("review", withLines)).toBe("edit");
    for (const status of ["scripting", "producing", "rendered", "published", "failed", "cancelled"]) expect(editorMode(status, withLines), status).toBe("readonly");
  });
  it("keeps polling while the video moves on its own, and stops on failure", () => {
    for (const s of ["capturing", "scripting", "producing"]) expect(isWatching(s), s).toBe(true);
    for (const s of ["review", "rendered", "published", "failed", "cancelled"]) expect(isWatching(s), s).toBe(false);
  });
});

describe("publish approval in the editor", () => {
  it("reads the approval as waiting, rejected or none", () => {
    expect(publishState("rendered", { status: "pending" })).toBe("waiting");
    expect(publishState("rendered", { status: "rejected" })).toBe("rejected");
    expect(publishState("rendered", { status: "approved" })).toBe("waiting"); // being published right now
    expect(publishState("rendered", null)).toBe("none");
    expect(publishState("review", { status: "rejected" })).toBe("none"); // only a rendered video has a publish decision to show
    expect(publishState("published", { status: "approved" })).toBe("none");
  });

  it("offers Edit and re-render only for a rendered video", () => {
    expect(canReopen("rendered")).toBe(true);
    for (const s of ["capturing", "scripting", "review", "producing", "published", "failed", "cancelled"]) expect(canReopen(s), s).toBe(false);
  });

  it("names the rendered video's player files", () => {
    expect(hasPlayer({ status: "rendered", video_key: "k" })).toBe(true);
    expect(hasPlayer({ status: "published", video_key: "k" })).toBe(true);
    expect(hasPlayer({ status: "rendered", video_key: null })).toBe(false);
    expect(hasPlayer({ status: "review", video_key: "k" })).toBe(false);
  });
});

describe("unpublishing", () => {
  it("offers Unpublish only for a published video", () => {
    expect(canUnpublish("published")).toBe(true);
    for (const s of ["capturing", "scripting", "review", "producing", "rendered", "failed", "cancelled"]) expect(canUnpublish(s), s).toBe(false);
  });
});

describe("lastAttemptNotice", () => {
  it("names the helper's error while the video is back in review", () => {
    expect(lastAttemptNotice("review", "hyperframes is not installed")).toBe("The last attempt failed: hyperframes is not installed");
  });
  it("says nothing without an error, or in any other status", () => {
    expect(lastAttemptNotice("review", null)).toBe("");
    expect(lastAttemptNotice("review", "")).toBe("");
    expect(lastAttemptNotice("review", undefined)).toBe("");
    for (const s of ["capturing", "scripting", "producing", "rendered", "published", "failed", "cancelled"]) expect(lastAttemptNotice(s, "boom"), s).toBe("");
  });
});
