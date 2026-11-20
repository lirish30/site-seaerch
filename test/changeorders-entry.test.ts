import { describe, expect, it } from "vitest";
import { registeredKinds } from "../src/worker/approvals/registry";
import { buildMcpServer } from "../src/worker/mcp/server";

// This file imports no approval itself: what is registered here is what the MCP entry path brings.
describe("the MCP entry path", () => {
  it("registers change_order.draft so an agent can propose it", () => {
    expect(typeof buildMcpServer).toBe("function");
    expect(registeredKinds()).toContain("change_order.draft");
  });
});
