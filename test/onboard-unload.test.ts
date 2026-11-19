import { describe, expect, it } from "vitest";
import { KEEPALIVE_LIMIT_BYTES, unloadPlan } from "../src/client/onboardView";

const URL = "/api/public/o/T/answers";
const bodyOf = (a: Record<string, string>) => ({ answers: a });

describe("unloadPlan", () => {
  it("sends nothing when nothing is waiting", () => {
    expect(unloadPlan<Record<string, string>>(null, null, URL, bodyOf)).toEqual({ action: "none" });
    expect(unloadPlan<Record<string, string>>(null, { a: "x" }, URL, bodyOf)).toEqual({ action: "none" });
  });

  it("gives one keepalive request for a waiting value, with the same body the normal path sends", () => {
    const plan = unloadPlan({ business: "Heating" }, null, URL, bodyOf);
    expect(plan).toEqual({ action: "keepalive", url: URL, method: "PUT", body: JSON.stringify({ answers: { business: "Heating" } }) });
  });

  it("treats an empty string as a value to send (clearing a box is a save)", () => {
    expect(unloadPlan("", null, "/t", (t) => ({ text: t }))).toMatchObject({ action: "keepalive", body: JSON.stringify({ text: "" }) });
  });

  it("falls back to the normal path when the body is over the keepalive limit", () => {
    const big = { a: "x".repeat(KEEPALIVE_LIMIT_BYTES) };
    expect(unloadPlan(big, null, URL, bodyOf)).toEqual({ action: "paced" });
    const justUnder = { a: "x".repeat(KEEPALIVE_LIMIT_BYTES - 100) };
    expect(unloadPlan(justUnder, null, URL, bodyOf).action).toBe("keepalive");
  });

  it("counts bytes, not characters, against the limit", () => {
    const wide = { a: "é".repeat(KEEPALIVE_LIMIT_BYTES / 2 + 10) }; // 2 bytes each
    expect(unloadPlan(wide, null, URL, bodyOf)).toEqual({ action: "paced" });
  });

  it("does not send again a value that is already in flight", () => {
    expect(unloadPlan({ a: "x" }, { a: "x" }, URL, bodyOf)).toEqual({ action: "none" });
    expect(unloadPlan({ a: "y" }, { a: "x" }, URL, bodyOf).action).toBe("keepalive");
    expect(unloadPlan("hi", "hi", "/t", (t) => ({ text: t }))).toEqual({ action: "none" });
  });
});
