import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { evidenceFor, prepForDisplay } from "../src/client/callPrepView";
import { BASE_PUSHBACKS, DISCOVERY_QUESTIONS, DISCOVERY_STRUCTURE } from "../src/worker/sales/discovery";
import { listCurrentPackages } from "../src/worker/db/packages";
import type { CallPrep } from "../src/worker/queue/callPrep";

const prep: CallPrep = {
  opener: "Hi Pat.", generatedAt: "2026-11-18T18:00:00.000Z",
  flags: [{ findingCode: "no_https", talkingPoint: "The padlock is missing.", askThis: "Do customers mention it?" }],
  questionNotes: [{ n: 4, tailored: "Plumbers see $300 to $1,500 jobs; ask for theirs." }],
  pushbacks: [{ objection: "Too much", answer: "Quick Fix is {{quick_fix}}." }],
  watchFor: ["Says 'just fix it'"],
};

describe("prepForDisplay", () => {
  it("without prep still shows the ten questions and base pushbacks with prices merged", async () => {
    const catalog = await listCurrentPackages(env.DB);
    const v = prepForDisplay(null, catalog);
    expect(v.structure).toEqual(DISCOVERY_STRUCTURE);
    expect(v.questions.map((q) => q.text)).toEqual(DISCOVERY_QUESTIONS);
    expect(v.questions.map((q) => q.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(v.questions.every((q) => q.tailored === undefined)).toBe(true);
    expect(v.flags).toEqual([]);
    expect(v.pushbacks).toHaveLength(BASE_PUSHBACKS.length);
    const text = v.pushbacks.map((p) => p.answer).join("\n");
    expect(text).toContain("$797");
    expect(text).toContain("$129/mo");
    expect(text).not.toContain("{{");
  });

  it("with prep, tailors by question number and merges prices in Claude's pushbacks", async () => {
    const catalog = await listCurrentPackages(env.DB);
    const v = prepForDisplay(prep, catalog);
    expect(v.questions).toHaveLength(10);
    expect(v.questions[3]).toMatchObject({ n: 4, text: DISCOVERY_QUESTIONS[3], tailored: "Plumbers see $300 to $1,500 jobs; ask for theirs." });
    expect(v.questions[0].tailored).toBeUndefined();
    expect(v.flags).toEqual(prep.flags);
    expect(v.pushbacks).toEqual([{ objection: "Too much", answer: "Quick Fix is $797." }]);
  });
});

describe("evidenceFor", () => {
  it("finds the evidence of the cited finding, or nothing", () => {
    const findings = [{ code: "no_https", evidence: "Not secure" }, { code: "no_cta", evidence: "" }];
    expect(evidenceFor(findings, "no_https")).toBe("Not secure");
    expect(evidenceFor(findings, "no_cta")).toBeNull();
    expect(evidenceFor(findings, "gone")).toBeNull();
  });
});
