import { describe, expect, it } from "vitest";
import { DNC_REASONS, dncReasonLabel, dncValueHint } from "../src/client/dncView";
import { DO_NOT_CONTACT_REASONS } from "../src/worker/db/doNotContact";

describe("do-not-contact view helpers", () => {
  it("offers exactly the reasons the server accepts, each with a label", () => {
    expect([...DNC_REASONS].sort()).toEqual([...DO_NOT_CONTACT_REASONS].sort());
    for (const r of DNC_REASONS) expect(dncReasonLabel(r)).not.toBe(r);
    expect(dncReasonLabel("mystery")).toBe("mystery");
  });
  it("hints the value for each kind", () => {
    expect(dncValueHint("email")).toBe("name@company.com");
    expect(dncValueHint("domain")).toBe("company.com");
    expect(dncValueHint("name")).toBe("Company name");
  });
});
