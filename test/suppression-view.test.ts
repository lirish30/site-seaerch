import { describe, expect, it } from "vitest";
import { REASONS, reasonLabel, suppressedMessage } from "../src/client/suppressionView";
import { SUPPRESSION_REASONS } from "../src/worker/types";

describe("suppression view helpers", () => {
  it("offers exactly the reasons the server accepts, each with a label", () => {
    expect([...REASONS].sort()).toEqual([...SUPPRESSION_REASONS].sort());
    for (const r of REASONS) expect(reasonLabel(r)).not.toBe(r);
    expect(reasonLabel("mystery")).toBe("mystery");
  });
  it("words the banner by reason and appends the note", () => {
    expect(suppressedMessage({ reason: "opt_out", note: null })).toBe("Suppressed: this business is marked as someone who opted out. Drafting and exports are turned off.");
    expect(suppressedMessage({ reason: "client", note: "signed 2026" })).toMatch(/existing client.*Note: signed 2026$/);
  });
});
