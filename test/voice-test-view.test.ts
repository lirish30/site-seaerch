import { describe, it, expect } from "vitest";
import { REFERENCE_SECONDS, engineName, referenceProblem, voiceTestLine } from "../src/client/voiceTestView";

describe("voiceTestLine", () => {
  it("says how many clips the Mac still owes", () => {
    expect(voiceTestLine({ pending: 3, chosen: null })).toBe("Waiting for your Mac: 3 of 3 clips left.");
    expect(voiceTestLine({ pending: 1, chosen: null })).toBe("Waiting for your Mac: 1 of 3 clips left.");
  });
  it("asks for a pick once every clip is ready", () => {
    expect(voiceTestLine({ pending: 0, chosen: null })).toBe("Listen to A, B and C, then pick the one that sounds most like you.");
  });
  it("confirms a pick, whatever was still pending", () => {
    expect(voiceTestLine({ pending: 0, chosen: "B" })).toBe("Picked. New videos will use this voice.");
    expect(voiceTestLine({ pending: 2, chosen: "A" })).toBe("Picked. New videos will use this voice.");
  });
});

describe("engineName", () => {
  it("names the engines and leaves an unknown one as it is", () => {
    expect(engineName("qwen3-tts")).toBe("Qwen3-TTS");
    expect(engineName("chatterbox")).toBe("Chatterbox");
    expect(engineName("openvoice-v2")).toBe("OpenVoice v2");
    expect(engineName("other")).toBe("other");
  });
});

describe("referenceProblem", () => {
  it("accepts 30 to 120 seconds", () => {
    expect(referenceProblem(30_000)).toBeNull();
    expect(referenceProblem(120_000)).toBeNull();
  });
  it("says how far off a recording is", () => {
    expect(referenceProblem(12_400)).toBe("That recording is 12 seconds. It needs at least 30.");
    expect(referenceProblem(150_000)).toBe("That recording is 150 seconds. It can be at most 120.");
    expect(referenceProblem(NaN)).toBe("Couldn't tell how long that recording is.");
    expect(referenceProblem(0)).toBe("Couldn't tell how long that recording is.");
  });
  it("matches the bounds the server enforces", async () => {
    const { REFERENCE_SECONDS: server } = await import("../src/worker/routes/voiceTest");
    expect(REFERENCE_SECONDS).toEqual(server);
  });
});
