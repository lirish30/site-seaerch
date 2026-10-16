import { describe, expect, it } from "vitest";
import {
  hasBuiltSignature, isHttps, jobMissing, prettyLink, profileMissing, safeLink, samplesNeeded, samplesNudge, setupItems, setupSentence, suppressionWord, voiceSummary,
} from "../src/client/settingsPagesView";
import type { Service, Suppression } from "../src/client/types";

const sample = (result: string) => ({ id: "x", title: "t", url: "https://a.com", result_line: result, tags: "" });
const svc = (active: boolean) => ({ active }) as Service;

describe("links", () => {
  it("accepts http(s) and bare domains, refuses everything else", () => {
    expect(safeLink("irishweb.studio/work")).toBe("https://irishweb.studio/work");
    expect(safeLink("http://a.com")).toBe("http://a.com/");
    expect(["javascript:alert(1)", "mailto:a@b.co", "not a link", "nodots", ""].map(safeLink)).toEqual(["", "", "", "", ""]);
  });
  it("wants https:// for images and logos", () => {
    expect(isHttps("https://x.com/a.png")).toBe(true);
    expect([" http://x.com/a.png", "x.com/a.png", "https://", "https://a b.com"].map(isHttps)).toEqual([false, false, false, false]);
  });
  it("shows a link without scheme, www or trailing slash", () => expect(prettyLink("https://www.riversidedental.com/")).toBe("riversidedental.com"));
});

describe("overview status", () => {
  it("names the voice by tone and length, falling back to the defaults", () => {
    expect(voiceSummary("direct", "long")).toBe("Direct & short · Long");
    expect(voiceSummary("", "")).toBe("Friendly local · Short");
  });
  it("counts how many more samples would give drafts a choice", () => {
    expect(samplesNeeded([sample("up 40%"), sample(""), sample("  ")])).toBe(5);
    expect(samplesNeeded(Array.from({ length: 8 }, () => sample("a")))).toBe(0);
    expect(samplesNudge(2)).toBe("Two more samples with results would give full-time drafts more to choose from.");
    expect(samplesNudge(1)).toBe("One more sample with a result would give full-time drafts more to choose from.");
  });
  it("finds the profile and job-search gaps", () => {
    expect(profileMissing({ your_name: "A", business_name: "", contact_email: " " })).toEqual(["your business name", "a contact email"]);
    expect(jobMissing({ role_title: "dev", bio: "b", goal_line: "g" })).toEqual([]);
  });
  it("treats a signature as built once it has a name, email or link", () => {
    expect(hasBuiltSignature({ signature_json: "" })).toBe(false);
    expect(hasBuiltSignature({ signature_json: JSON.stringify({ name: "Logan" }) })).toBe(true);
    expect(hasBuiltSignature({ signature_json: JSON.stringify({ phone: "123" }) })).toBe(false);
  });
  it("lists what is left in setup order and words it", () => {
    const doc = { your_name: "A", business_name: "B", contact_email: "a@b.co", services_blurb: "x", role_title: "r", bio: "b", goal_line: "g", resume_url: "", signature_json: JSON.stringify({ name: "A" }) };
    const samples = Array.from({ length: 7 }, () => sample("a"));
    const items = setupItems({ doc, samples, services: [svc(true)] });
    expect(items.filter((i) => !i.done).map((i) => i.key)).toEqual(["resume", "samples"]);
    expect(setupSentence(items, samples)).toBe("Add a resume link and one more work sample. Full-time emails link only to your samples.");
    expect(setupSentence(setupItems({ doc: { ...doc, resume_url: "https://x.com/cv.pdf" }, samples: Array.from({ length: 8 }, () => sample("a")), services: [svc(true)] }), samples)).toBe("");
  });
  it("sums up suppressions", () => {
    const d = (kind: "domain" | "place_id") => ({ kind }) as Suppression;
    expect(suppressionWord([d("domain")])).toBe("1 domain");
    expect(suppressionWord([d("domain"), d("place_id")])).toBe("2 entries");
  });
});
