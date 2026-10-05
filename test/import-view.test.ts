import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/api";
import { candidateLabel, choiceCounts, choiceOptions, commitSummary, defaultChoice, importErrorText, inputBody, isLocked, isSingleAddress, toCommitRows } from "../src/client/importView";
import type { ImportCandidate, ImportCommitResult, ImportKind, ImportPreviewRow } from "../src/client/types";

const cand = (id: string, name: string, o: Partial<ImportCandidate> = {}): ImportCandidate =>
  ({ id, name, domain: `${id}.com`, website_url: null, address: null, lead_status: "new", archived_at: null, ...o });
const prow = (index: number, kind: ImportKind, candidates: ImportCandidate[] = []): ImportPreviewRow =>
  ({ index, line: index + 2, kind, candidates, row: { name: `R${index}`, url: null, source: "Referral" } });

describe("defaults", () => {
  it("creates new rows, links exact matches, leaves ambiguous undecided, and skips the rest", () => {
    expect(defaultChoice(prow(0, "new"))).toBe("create");
    expect(defaultChoice(prow(1, "exact", [cand("a", "A")]))).toBe("link:a");
    expect(defaultChoice(prow(2, "ambiguous", [cand("a", "A")]))).toBe("");
    for (const k of ["duplicate_in_file", "suppressed", "invalid"] as const) { expect(defaultChoice(prow(3, k))).toBe("skip"); expect(isLocked(k)).toBe(true); }
    expect(isLocked("new") || isLocked("exact") || isLocked("ambiguous")).toBe(false);
  });
});

describe("choiceOptions", () => {
  it("offers create, a link per candidate and skip for an ambiguous row", () => {
    const o = choiceOptions(prow(0, "ambiguous", [cand("a", "Acme"), cand("b", "Acme Co", { archived_at: "x" })]));
    expect(o.map((x) => x.value)).toEqual(["", "create", "link:a", "link:b", "skip"]);
    expect(o[2].label).toBe("Link to Acme (a.com)");
    expect(o[3].label).toMatch(/archived/);
  });
  it("offers only link or skip for an exact match, and only skip for locked rows", () => {
    expect(choiceOptions(prow(0, "exact", [cand("a", "A")])).map((x) => x.value)).toEqual(["link:a", "skip"]);
    expect(choiceOptions(prow(0, "suppressed")).map((x) => x.value)).toEqual(["skip"]);
  });
  it("labels a candidate without a domain by name alone", () => expect(candidateLabel(cand("a", "A", { domain: null }))).toBe("A"));
});

describe("toCommitRows and counts", () => {
  const rows = [prow(0, "new"), prow(1, "exact", [cand("a", "A")]), prow(2, "ambiguous", [cand("b", "B")]), prow(3, "suppressed"), prow(4, "ambiguous", [cand("c", "C")])];
  it("sends defaults, user picks, and skips for undecided and locked rows", () => {
    const body = toCommitRows(rows, { 4: "create" });
    expect(body.map((b) => [b.action, b.businessId])).toEqual([["create", undefined], ["link", "a"], ["skip", undefined], ["skip", undefined], ["create", undefined]]);
  });
  it("a locked row can never be turned into create or link by a stale choice", () => {
    expect(toCommitRows([prow(3, "suppressed")], { 3: "create" })[0].action).toBe("skip");
  });
  it("counts what will happen and how many rows still need a decision", () => {
    expect(choiceCounts(rows, {})).toEqual({ create: 1, link: 1, skip: 3, undecided: 2 });
    expect(choiceCounts(rows, { 2: "link:b", 4: "skip" })).toEqual({ create: 1, link: 2, skip: 2, undecided: 0 });
  });
});

describe("inputBody", () => {
  it("sends a lone address as url, with an optional name, and anything else as CSV text", () => {
    expect(inputBody(" acme.com ", " Acme ", " Referral ")).toEqual({ url: "acme.com", name: "Acme", source: "Referral" });
    expect(inputBody("https://acme.com", "", "x")).toEqual({ url: "https://acme.com", source: "x" });
    expect(inputBody("name,website\nA,a.com", "ignored", "x")).toEqual({ text: "name,website\nA,a.com", source: "x" });
    expect(isSingleAddress("acme.com")).toBe(true);
    expect(isSingleAddress("name\nA")).toBe(false);
  });
});

describe("messages", () => {
  const res = (o: Partial<ImportCommitResult> = {}): ImportCommitResult => ({ created: 0, linked: 0, alreadyExisted: 0, skipped: 0, auditsQueued: 0, searchId: null, refused: [], failures: [], leads: [], ...o });
  it("summarizes the counts and omits zeros", () => {
    expect(commitSummary(res({ created: 2, auditsQueued: 1, skipped: 3 }))).toEqual(["Created 2 leads.", "Skipped 3 rows.", "1 quick scan queued of 2."]);
    expect(commitSummary(res())).toEqual(["Nothing was imported."]);
    expect(commitSummary(res({ created: 1, auditsQueued: 1 }))[0]).toBe("Created 1 lead.");
  });
  it("shows the API message for an ApiError and a fallback otherwise", () => {
    expect(importErrorText(new ApiError(400, "bad csv"), "x")).toBe("bad csv");
    expect(importErrorText(new Error("boom"), "Couldn't preview.")).toBe("Couldn't preview.");
  });
});
