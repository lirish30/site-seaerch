import { describe, it, expect } from "vitest";
import { detectBoard } from "../src/worker/jobs/detect";

describe("detectBoard", () => {
  it.each([
    ["https://boards.greenhouse.io/acme", { ats: "greenhouse", token: "acme" }],
    ["https://boards.greenhouse.io/acme/jobs/4001?gh_src=x", { ats: "greenhouse", token: "acme" }],
    ["https://job-boards.greenhouse.io/Acme-Co", { ats: "greenhouse", token: "acme-co" }],
    ['<iframe src="https://boards.greenhouse.io/embed/job_board?for=acme&b=https%3A%2F%2Facme.com"></iframe>', { ats: "greenhouse", token: "acme" }],
    ['<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>', { ats: "greenhouse", token: "acme" }],
    ["https://boards-api.greenhouse.io/v1/boards/acme/jobs", { ats: "greenhouse", token: "acme" }],
    ["https://jobs.lever.co/acme", { ats: "lever", token: "acme" }],
    ["https://jobs.lever.co/acme/0f3c-aa?lever-source=x", { ats: "lever", token: "acme" }],
    ["https://jobs.ashbyhq.com/Acme", { ats: "ashby", token: "Acme" }],
    ['<a href="https://jobs.ashbyhq.com/acme/1234">Apply</a>', { ats: "ashby", token: "acme" }],
    ["Join us: https://jobs.lever.co/acme.", { ats: "lever", token: "acme" }],
  ] as const)("%s", (text, want) => expect(detectBoard(text)).toEqual(want));

  // Lever board names are case-sensitive (api.lever.co/v0/postings/Spotify is a 404), so a mixed-case link must keep its case.
  it("keeps the case of a Lever board name", () => {
    expect(detectBoard("https://jobs.lever.co/AcmeCo/abc")).toEqual({ ats: "lever", token: "AcmeCo" });
  });

  it("scans a hostile 400KB page in linear time", () => {
    const hostile = "x/boards.greenhouse.io/embed/job_board?".repeat(10_300);
    const t0 = performance.now();
    expect(detectBoard(hostile)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(400);
  });

  it("finds a board link inside a page of HTML", () => {
    const html = `<html><nav><a href="/about">About</a></nav><p>See <a href="https://jobs.lever.co/northwind">open roles</a></p></html>`;
    expect(detectBoard(html)).toEqual({ ats: "lever", token: "northwind" });
  });

  it.each([
    "https://acme.com/careers",
    "https://boards.greenhouse.io/embed/job_board",
    "https://boards.greenhouse.io/",
    "https://www.indeed.com/cmp/acme/jobs",
    "https://jobs.lever.co/",
    "https://notjobs.lever.co.evil.example/acme",
    "https://notjobs.lever.co/acme",
    "https://evilboards.greenhouse.io/acme",
    "https://x.jobs.ashbyhq.com/acme",
    "https://jobs.lever.co/" + "a".repeat(81),
    "",
  ])("%s has no supported board", (text) => expect(detectBoard(text)).toBeNull());

  it("never returns a token that is unsafe to put in a URL", () => {
    expect(detectBoard("https://boards.greenhouse.io/%2e%2e%2fadmin")).toBeNull();
    expect(detectBoard("https://boards-api.greenhouse.io/v1/boards/..%2fx/jobs")).toBeNull();
  });
});
