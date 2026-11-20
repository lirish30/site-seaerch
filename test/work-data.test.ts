import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/api";
import { workError } from "../src/client/workData";

describe("workError", () => {
  it("a 409 that names the blocking steps reads as a sentence listing them", () => {
    const e = new ApiError(409, "This step is waiting on: Write the copy.", [], "", { error: "x", blockedBy: ["Write the copy", "Get the logo"] });
    expect(workError(e)).toBe("Blocked by: Write the copy, Get the logo");
  });
  it("any other error shows the server's own sentence, or the fallback", () => {
    expect(workError(new ApiError(409, "A timer is already running."))).toBe("A timer is already running.");
    expect(workError(new Error("boom"))).toBe("boom");
    expect(workError("odd", "Something went wrong")).toBe("Something went wrong");
  });
});
