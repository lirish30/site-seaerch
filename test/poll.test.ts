import { describe, expect, it } from "vitest";
import { pollDelay, searchFinished } from "../src/client/poll";
import type { Search } from "../src/client/types";

const s = (o: Partial<Search>): Search => ({ id: "s", location: "L", business_type: "b", max_results: 5, status: "running",
  error: null, found_count: 0, processed_count: 0, created_at: "", ...o });

describe("pollDelay", () => {
  it("polls every 4s while healthy and backs off 8s → 15s cap on consecutive failures", () => {
    expect(pollDelay(0)).toBe(4000);
    expect(pollDelay(1)).toBe(8000);
    expect(pollDelay(2)).toBe(15000);
    expect(pollDelay(10)).toBe(15000);
  });
});

describe("searchFinished", () => {
  it("is terminal only when failed, or done with every lead processed", () => {
    expect(searchFinished(s({ status: "failed" }))).toBe(true);
    expect(searchFinished(s({ status: "done", found_count: 3, processed_count: 3 }))).toBe(true);
    expect(searchFinished(s({ status: "done", found_count: 3, processed_count: 2 }))).toBe(false);
    expect(searchFinished(s({ status: "running", found_count: 0, processed_count: 0 }))).toBe(false);
  });
});
