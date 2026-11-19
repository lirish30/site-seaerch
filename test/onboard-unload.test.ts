import { describe, expect, it } from "vitest";
import { combine, KEEPALIVE_LIMIT_BYTES, mayRun, unloadPlan } from "../src/client/onboardView";

const URL = "/api/public/o/T/answers";
type A = Record<string, string>;
const answers = { url: URL, bodyOf: (a: A) => ({ answers: a }), merge: (o: A, n: A) => ({ ...o, ...n }) };
const text = { url: "/t", bodyOf: (t: string) => ({ text: t }) };
const none = { pending: null, queued: null, started: null };

describe("unloadPlan", () => {
  it("sends nothing when nothing is waiting, queued or started", () => {
    expect(unloadPlan<A>({ ...none, ...answers })).toEqual({ action: "none", supersede: false });
    expect(unloadPlan<A>({ ...none, started: { a: "x" }, ...answers })).toEqual({ action: "none", supersede: false });
  });

  it("gives one keepalive request for a waiting value, with the same body the normal path sends", () => {
    expect(unloadPlan({ ...none, pending: { business: "Heating" }, ...answers }))
      .toEqual({ action: "keepalive", url: URL, method: "PUT", body: JSON.stringify({ answers: { business: "Heating" } }), supersede: false });
  });

  it("treats an empty string as a value to send (clearing a box is a save)", () => {
    expect(unloadPlan({ ...none, pending: "", ...text })).toMatchObject({ action: "keepalive", body: JSON.stringify({ text: "" }) });
  });

  it("a value queued in the pacer but not started counts as unsent: one keepalive, and the queued job is stood down", () => {
    expect(unloadPlan({ ...none, queued: { a: "x" }, ...answers }))
      .toEqual({ action: "keepalive", url: URL, method: "PUT", body: JSON.stringify({ answers: { a: "x" } }), supersede: true });
  });

  it("queued A plus newer pending B gives ONE keepalive carrying B, never A after B, and stands A down", () => {
    const plan = unloadPlan({ ...none, queued: "A", pending: "B", ...text });
    expect(plan).toEqual({ action: "keepalive", url: "/t", method: "PUT", body: JSON.stringify({ text: "B" }), supersede: true });
    // answers add up: the newer value wins where both have the field, and the older field is kept
    const joined = unloadPlan({ ...none, queued: { a: "old", b: "keep" }, pending: { a: "new" }, ...answers });
    expect(joined).toMatchObject({ action: "keepalive", supersede: true, body: JSON.stringify({ answers: { a: "new", b: "keep" } }) });
  });

  it("does not stand anything down when nothing was queued", () => {
    expect(unloadPlan({ ...none, started: "A", pending: "B", ...text })).toMatchObject({ action: "keepalive", supersede: false, body: JSON.stringify({ text: "B" }) });
  });

  it("falls back to the normal path when the body is over the keepalive limit, standing nothing down", () => {
    expect(unloadPlan({ ...none, pending: { a: "x".repeat(KEEPALIVE_LIMIT_BYTES) }, ...answers })).toEqual({ action: "paced" });
    expect(unloadPlan({ ...none, queued: { a: "x" }, pending: { b: "x".repeat(KEEPALIVE_LIMIT_BYTES) }, ...answers })).toEqual({ action: "paced" });
    expect(unloadPlan({ ...none, pending: { a: "x".repeat(KEEPALIVE_LIMIT_BYTES - 100) }, ...answers }).action).toBe("keepalive");
  });

  it("counts bytes, not characters, against the limit", () => {
    expect(unloadPlan({ ...none, pending: { a: "é".repeat(KEEPALIVE_LIMIT_BYTES / 2 + 10) }, ...answers })).toEqual({ action: "paced" });
  });

  it("does not send again a value whose fetch has started", () => {
    expect(unloadPlan({ ...none, pending: { a: "x" }, started: { a: "x" }, ...answers })).toEqual({ action: "none", supersede: false });
    expect(unloadPlan({ ...none, pending: { a: "y" }, started: { a: "x" }, ...answers }).action).toBe("keepalive");
    expect(unloadPlan({ ...none, pending: "hi", started: "hi", ...text })).toEqual({ action: "none", supersede: false });
  });

  it("a queued value equal to the started one is redundant: nothing is sent and the queued job is stood down", () => {
    expect(unloadPlan({ ...none, queued: "hi", started: "hi", ...text })).toEqual({ action: "none", supersede: true });
  });
});

describe("combine", () => {
  it("is whichever one there is, and the newer when there are two", () => {
    expect(combine<string>(null, null)).toBeNull();
    expect(combine("A", null)).toBe("A");
    expect(combine(null, "B")).toBe("B");
    expect(combine("A", "B")).toBe("B");
    expect(combine("", "B")).toBe("B");
    expect(combine("A", "")).toBe("");
    expect(combine<A>({ a: "1" }, { b: "2" }, (o, n) => ({ ...o, ...n }))).toEqual({ a: "1", b: "2" });
  });
});

describe("mayRun", () => {
  it("lets a queued job fetch only while its token is still the current one", () => {
    expect(mayRun(3, 3)).toBe(true);
    expect(mayRun(3, 4)).toBe(false); // stood down: a newer token was issued
    expect(mayRun(2, 4)).toBe(false);
  });
});
