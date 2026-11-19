import { describe, it, expect } from "vitest";
import { callDoneCheck, formOf, isNotesDirty, nextActions, notesOf, optionSummary } from "../src/client/dealView";
import { dealHref } from "../src/client/pipelineView";
import type { Package } from "../src/worker/db/packages";
import type { CallRecap } from "../src/worker/queue/callRecap";
import { emptyNotes } from "../src/worker/sales/notes";
import type { Option } from "../src/worker/sales/options";

const written = { ...emptyNotes(), answers: [{ n: 1, text: "water heaters" }] };
const recap: CallRecap = { playback: "p", recommendation: "r", leadType: "wp_few_broken", goals: ["g"], currentState: [], generatedAt: "2026-11-24T19:00:00.000Z" };
const deal = (o: Partial<Parameters<typeof nextActions>[0]> = {}) => ({ stage: "discovery_done" as const, skipCall: false, notes: null, recap: null, ...o });
const labels = (d: ReturnType<typeof deal>) => nextActions(d).map((a) => a.label);

describe("nextActions", () => {
  it('lists "Write notes" after the call and "Draft recap" once notes exist', () => {
    expect(nextActions(deal())).toEqual([{ label: "Write notes", done: false }]);
    expect(nextActions(deal({ notes: emptyNotes() }))).toEqual([{ label: "Write notes", done: false }]);
    expect(nextActions(deal({ notes: written }))).toEqual([{ label: "Write notes", done: true }, { label: "Draft recap", done: false }]);
  });

  it("before the call there is only the call", () => {
    expect(nextActions(deal({ stage: "booked" }))).toEqual([{ label: "Hold the discovery call", done: false }]);
  });

  it("walks on to the two times and the meeting as each is done", () => {
    expect(nextActions(deal({ notes: written, recap }))).toEqual([
      { label: "Write notes", done: true }, { label: "Draft recap", done: true }, { label: "Offer two times", done: false },
    ]);
    expect(nextActions(deal({ stage: "recommendation_booked", notes: written, recap })).slice(-2)).toEqual([
      { label: "Offer two times", done: true }, { label: "Present the recommendation", done: false },
    ]);
    expect(nextActions(deal({ stage: "recommended", notes: written, recap })).every((a) => a.done)).toBe(true);
  });

  it("has nothing to do on a closed deal", () => {
    expect(labels(deal({ stage: "won" }))).toEqual([]);
    expect(labels(deal({ stage: "lost" }))).toEqual([]);
  });
});

describe("optionSummary", () => {
  const pkg = (key: Package["key"], o: Partial<Package>): Package => ({
    id: key, key, version: 1, name: key === "quick_fix" ? "Quick Fix" : "Care", kind: "one_time", priceCents: 79700, setupCents: 0, termMonths: null, altPriceCents: null, fromPrice: false,
    summary: "", includes: [], wordpressOnly: false, publicOffer: true, active: true, createdAt: "", ...o,
  });
  const catalog = [pkg("quick_fix", {}), pkg("care", { kind: "monthly", priceCents: 12900 })];
  const option: Option = { id: "b", label: "Fix it and keep it running", tagline: "t", items: [{ key: "quick_fix" }, { key: "care" }], recommended: true };

  it("names each package with its catalog price and totals up front and monthly", () => {
    expect(optionSummary(option, catalog)).toEqual({ items: ["Quick Fix: $797", "Care: $129/mo"], upfront: "$797", monthly: "$129/mo" });
  });
  it("leaves a total out when there is none", () => {
    expect(optionSummary({ ...option, items: [{ key: "quick_fix" }] }, catalog)).toEqual({ items: ["Quick Fix: $797"], upfront: "$797", monthly: null });
  });
});

describe("the board links to the deal page", () => {
  it("dealHref points at /deals/:id", () => {
    expect(dealHref({ id: "d1" })).toBe("/deals/d1");
  });
});

describe("formOf and notesOf", () => {
  it("round trips the notes through the form, keeping the owner's numbers as cents and counts", () => {
    const n = { ...emptyNotes(), answers: [{ n: 2, text: "Boise and Meridian" }, { n: 10, text: "Timing" }], goals: ["More calls"], avgJobValueCents: 40050, missedJobsPerMonth: 5, platform: "wordpress" as const, decisionMakers: "Pat", callHeldAt: "2026-11-24T18:25:00.000Z" };
    const f = formOf(n);
    expect(f.answers).toHaveLength(10);
    expect(f.answers[1]).toBe("Boise and Meridian");
    expect(f.goals).toEqual(["More calls", "", ""]);
    expect(f).toMatchObject({ avgJob: "400.5", missed: "5", platform: "wordpress" });
    expect(notesOf(f, n.callHeldAt)).toEqual({ ok: true, notes: n });
  });

  it("a blank owner number stays null (never estimated), and blank boxes are dropped", () => {
    const r = notesOf(formOf(null), null);
    expect(r).toEqual({ ok: true, notes: emptyNotes() });
    expect(formOf(null).platform).toBe("other");
  });

  it("says what is wrong with a number that is not one", () => {
    expect(notesOf({ ...formOf(null), avgJob: "lots" }, null)).toEqual({ ok: false, error: expect.stringMatching(/Average job/) });
    expect(notesOf({ ...formOf(null), missed: "2.5" }, null)).toEqual({ ok: false, error: expect.stringMatching(/Missed jobs/) });
    expect(notesOf({ ...formOf(null), avgJob: "$1,250", missed: " 3 " }, null)).toMatchObject({ ok: true, notes: { avgJobValueCents: 125000, missedJobsPerMonth: 3 } });
  });
});

describe("the notes form survives a tab switch and a reload of the deal", () => {
  it("prefills the platform from the audit only when there are no saved notes", () => {
    expect(formOf(null, { platform: "wordpress" }).platform).toBe("wordpress");
    expect(formOf(null, { platform: "wix" }).platform).toBe("other");
    expect(formOf(null, { platform: null }).platform).toBe("other");
    expect(formOf(null, null).platform).toBe("other");
    expect(formOf(null).platform).toBe("other");
    // Saved notes keep what Logan chose, whatever the audit says.
    expect(formOf({ ...emptyNotes(), platform: "other" }, { platform: "wordpress" }).platform).toBe("other");
    expect(formOf({ ...emptyNotes(), platform: "wordpress" }, { platform: "wix" }).platform).toBe("wordpress");
  });

  it("is not dirty as loaded (with or without the prefill) and is dirty once something is typed", () => {
    const audit = { platform: "wordpress" };
    const fresh = formOf(null, audit);
    expect(isNotesDirty(fresh, null, audit)).toBe(false);
    expect(isNotesDirty({ ...fresh, answers: fresh.answers.map((a, i) => (i === 0 ? "water heaters" : a)) }, null, audit)).toBe(true);
    expect(isNotesDirty({ ...fresh, platform: "other" }, null, audit)).toBe(true); // Logan changing the prefill is an edit
    const saved = { ...emptyNotes(), answers: [{ n: 1, text: "water heaters" }], platform: "wordpress" as const };
    expect(isNotesDirty(formOf(saved), saved)).toBe(false);
    expect(isNotesDirty({ ...formOf(saved), goals: ["More calls", "", ""] }, saved)).toBe(true);
  });

  it("unsaved typing stays dirty when the deal reloads with the same saved notes, and is clean once the saved notes match it", () => {
    const typed = { ...formOf(null), goals: ["More calls", "", ""] };
    expect(isNotesDirty(typed, null)).toBe(true); // a reload that brings back no notes does not clear it
    const stored = notesOf(typed, null);
    if (!stored.ok) throw new Error(stored.error);
    expect(isNotesDirty(formOf(stored.notes), stored.notes)).toBe(false); // after a save the form is rebuilt from what was stored
  });
});

describe("callDoneCheck", () => {
  it("stops on notes that are not valid, with the reason, so the call is not marked done", () => {
    expect(callDoneCheck({ ...formOf(null), avgJob: "lots" }, null)).toEqual({ ok: false, error: expect.stringMatching(/Average job/) });
    expect(callDoneCheck({ ...formOf(null), missed: "2.5" }, null)).toEqual({ ok: false, error: expect.stringMatching(/Missed jobs/) });
  });
  it("saves first when something is written, and goes straight on when nothing is", () => {
    const written = { ...formOf(null), answers: ["water heaters", ...Array(9).fill("")] };
    expect(callDoneCheck(written, null)).toMatchObject({ ok: true, save: true });
    expect(callDoneCheck(formOf(null), null)).toMatchObject({ ok: true, save: false });
    expect(callDoneCheck({ ...formOf(null), goals: ["More calls", "", ""] }, null)).toMatchObject({ ok: true, save: true }); // any typed box is kept, not only an answer
    // Deliberate change: a platform that differs from what is stored is saved too, so the prefilled WordPress is not replaced by blank notes saying "other".
    expect(callDoneCheck({ ...formOf(null), platform: "wordpress" }, null, null)).toMatchObject({ ok: true, save: true });
    expect(callDoneCheck(formOf(null), null, null)).toMatchObject({ ok: true, save: false }); // nothing typed and the default platform: nothing to save
    const storedWp = { ...emptyNotes(), platform: "wordpress" as const };
    expect(callDoneCheck(formOf(storedWp), null, storedWp)).toMatchObject({ ok: true, save: false }); // same as stored
    expect(callDoneCheck({ ...formOf(storedWp), platform: "other" }, null, storedWp)).toMatchObject({ ok: true, save: true }); // changed from stored
  });
});
