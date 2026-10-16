import { describe, expect, it } from "vitest";
import { KIND_LABEL, KIND_TONE, choiceOptions, detectColumns, foundParts, inputName, sourceLine, stepOf } from "../src/client/importView";
import type { ImportCandidate, ImportCommitResult, ImportKind, ImportPreviewRow } from "../src/client/types";

const cand = (id: string, name: string, o: Partial<ImportCandidate> = {}): ImportCandidate =>
  ({ id, name, domain: `${id}.com`, website_url: null, address: null, lead_status: "new", archived_at: null, ...o });
const prow = (kind: ImportKind, candidates: ImportCandidate[] = [], o: Partial<ImportPreviewRow> = {}): ImportPreviewRow =>
  ({ index: 0, line: 2, kind, candidates, row: { name: "R", url: null, source: "Referral" }, ...o });
const text = (r: ImportPreviewRow) => foundParts(r).map((p) => p.text).join("");

describe("labels and tones", () => {
  it("has a label and a tone for every kind of row", () => {
    const kinds: ImportKind[] = ["new", "exact", "ambiguous", "duplicate_in_file", "suppressed", "invalid"];
    for (const k of kinds) { expect(KIND_LABEL[k]).toBeTruthy(); expect(k in KIND_TONE).toBe(true); }
    expect(KIND_LABEL.invalid).toBe("Can’t import");
  });
  it("reads Link to existing for a single exact match, and names each candidate when there are several", () => {
    expect(choiceOptions(prow("exact", [cand("a", "Acme")]))[0]).toEqual({ value: "link:a", label: "Link to existing" });
    expect(choiceOptions(prow("exact", [cand("a", "Acme"), cand("b", "Acme 2")])).map((o) => o.label)).toEqual(["Link to Acme (a.com)", "Link to Acme 2 (b.com)", "Skip"]);
  });
});

describe("foundParts", () => {
  it("says what will happen for each kind of row", () => {
    expect(text(prow("new"))).toBe("Will be created as a new lead");
    expect(text(prow("new", [], { nameDerived: true }))).toBe("Will be created as a new lead, named after its web address");
    expect(text(prow("exact", [cand("a", "Treasure Valley Rooter")]))).toBe("Matches Treasure Valley Rooter");
    expect(text(prow("exact", [cand("a", "Old Co", { archived_at: "x" })]))).toBe("Matches Old Co (archived)");
    expect(text(prow("duplicate_in_file", [], { reason: "Same website as row 5." }))).toBe("Same website as row 5");
    expect(text(prow("suppressed", [], { reason: "On your suppression list: an existing client." }))).toBe("On your suppression list: an existing client");
    expect(text(prow("invalid", [], { reason: "This row has no name." }))).toBe("This row has no name");
    expect(text(prow("invalid"))).toBe("Can’t import");
  });
  it("links an exact match and every candidate of an ambiguous row to its lead", () => {
    expect(foundParts(prow("exact", [cand("a", "A")]))).toEqual([{ text: "Matches A", id: "a" }]);
    expect(foundParts(prow("ambiguous", [cand("a", "A"), cand("b", "B")]))).toEqual([{ text: "Could be " }, { text: "A", id: "a" }, { text: " or " }, { text: "B", id: "b" }]);
    expect(text(prow("ambiguous", [cand("a", "A"), cand("b", "B"), cand("c", "C")]))).toBe("Could be A, B or C");
    expect(text(prow("ambiguous", [cand("a", "A"), cand("b", "B"), cand("c", "C"), cand("d", "D"), cand("e", "E")]))).toBe("Could be A, B, C, 2 more");
  });
});

describe("steps", () => {
  it("is add until there is a preview, review while there is one, and done once an import has a result", () => {
    const result = { created: 1 } as ImportCommitResult;
    expect(stepOf(null, null)).toBe("add");
    expect(stepOf([prow("new")], null)).toBe("review");
    expect(stepOf(null, result)).toBe("done");
  });
  it("words the file summary", () => {
    expect(sourceLine(8, " Referral ")).toBe("8 rows · source: Referral");
    expect(sourceLine(1, "Referral")).toBe("1 row · source: Referral");
    expect(inputName("leads.csv", "x,y")).toBe("leads.csv");
    expect(inputName("", "acme.com ")).toBe("acme.com");
    expect(inputName("", "name\nA")).toBe("Pasted list");
  });
});

describe("detectColumns", () => {
  it("finds columns by the same header names the server reads", () => {
    const d = detectColumns("Business Name, Web Site,Phone\nA,a.com,1");
    expect(d).toEqual({ found: ["name", "url", "phone"], missing: ["address", "category"], hasName: true });
    expect(detectColumns('"name","URL","address","telephone","category"\n')?.missing).toEqual([]);
  });
  it("flags a header with no name column, and says nothing for empty input or a lone address", () => {
    expect(detectColumns("website,phone\na.com,1")?.hasName).toBe(false);
    expect(detectColumns("")).toBeNull();
    expect(detectColumns("acme.com")).toBeNull();
    expect(detectColumns("\n\nname\nA")?.found).toEqual(["name"]);
  });
});
