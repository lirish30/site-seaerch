import { describe, it, expect } from "vitest";
import { helperLine } from "../src/client/helperView";

describe("helperLine", () => {
  it("online", () => expect(helperLine({ online: true, pending: {} })).toBe("Your Mac helper is online."));
  it("online with work waiting still just says online", () => expect(helperLine({ online: true, pending: { "voice.segment": 3 } })).toBe("Your Mac helper is online."));
  it("offline with nothing waiting", () => expect(helperLine({ online: false, pending: {} })).toBe("Your Mac helper is offline."));
  it("offline with one job waiting", () => expect(helperLine({ online: false, pending: { "voice.segment": 1 } })).toBe("Your Mac helper is offline. 1 job waiting."));
  it("offline with several jobs waiting, across kinds", () =>
    expect(helperLine({ online: false, pending: { "voice.segment": 4, render: 1 } })).toBe("Your Mac helper is offline. 5 jobs waiting."));
});
