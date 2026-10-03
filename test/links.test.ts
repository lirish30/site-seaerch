import { describe, expect, it } from "vitest";
import { safeHttpUrl } from "../src/client/links";

describe("safeHttpUrl", () => {
  it("rejects non-http schemes", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<b>x</b>")).toBeNull();
    expect(safeHttpUrl("ftp://example.com")).toBeNull();
  });
  it("prefixes bare hosts", () => {
    expect(safeHttpUrl("example.com")).toBe("https://example.com/");
    expect(safeHttpUrl("example.com:8080/x")).toBe("https://example.com:8080/x");
  });
  it("keeps http and https", () => {
    expect(safeHttpUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(safeHttpUrl("https://example.com/a")).toBe("https://example.com/a");
  });
  it("handles empty", () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl("  ")).toBeNull();
  });
});
