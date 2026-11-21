import { describe, expect, it } from "vitest";
import { lastFailedLabel, riskLabel, runLabel, whyLabel } from "../src/client/careUpdatesView";
import type { CareRunView, CareUpdateView } from "../src/worker/care/views";

const NOW = new Date("2026-11-21T20:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const update = (over: Partial<CareUpdateView> = {}): CareUpdateView => ({
  id: "u1", type: "plugin", slug: "akismet", name: "Akismet", fromVersion: "5.0", toVersion: "5.1", risk: "minor",
  rollbackable: true, security: false, held: false, needsTick: false, due: true, firstSeenAt: daysAgo(1), lastFailedAt: null, ...over,
});

describe("lastFailedLabel (I3)", () => {
  it("says the day a run last failed it, in the zone, and nothing when it never did", () => {
    expect(lastFailedLabel(update({ lastFailedAt: "2026-11-18T03:00:00Z" }), "America/Los_Angeles")).toBe("failed last time on 17 Nov");
    expect(lastFailedLabel(update({ lastFailedAt: "2026-11-18T03:00:00Z" }), "Australia/Sydney")).toBe("failed last time on 18 Nov");
    expect(lastFailedLabel(update(), "America/Los_Angeles")).toBe("");
  });
});

describe("riskLabel", () => {
  it("a major first seen 3 days ago waits until 7 days after, in the zone", () => {
    expect(riskLabel(update({ risk: "major", due: false, firstSeenAt: daysAgo(3) }), NOW, "America/Los_Angeles")).toBe("major · waits until 25 Nov");
  });
  it("uses the date in the given zone, not UTC", () => {
    const seen = "2026-11-18T03:00:00Z"; // due 2026-11-25 03:00Z: still 24 Nov in Los Angeles, 25 Nov in Sydney
    expect(riskLabel(update({ risk: "major", due: false, firstSeenAt: seen }), NOW, "America/Los_Angeles")).toBe("major · waits until 24 Nov");
    expect(riskLabel(update({ risk: "major", due: false, firstSeenAt: seen }), NOW, "Australia/Sydney")).toBe("major · waits until 25 Nov");
  });
  it("a bad zone falls back instead of throwing", () => {
    expect(riskLabel(update({ risk: "major", due: false, firstSeenAt: daysAgo(3) }), NOW, "Nowhere/Land")).toBe("major · waits until 25 Nov");
  });
  it("held reads held, even when it is also a major", () => {
    expect(riskLabel(update({ held: true }), NOW, "America/Los_Angeles")).toBe("held");
    expect(riskLabel(update({ held: true, risk: "major", due: false, needsTick: true }), NOW, "America/Los_Angeles")).toBe("held");
  });
  it("security reads security, whatever its size", () => {
    expect(riskLabel(update({ risk: "security", security: true }), NOW, "America/Los_Angeles")).toBe("security");
  });
  it("a major past its wait is plain major, and needs-your-OK is appended", () => {
    expect(riskLabel(update({ risk: "major", firstSeenAt: daysAgo(8), needsTick: true }), NOW, "America/Los_Angeles")).toBe("major · needs your OK");
    expect(riskLabel(update({ risk: "major", due: false, firstSeenAt: daysAgo(3), needsTick: true }), NOW, "America/Los_Angeles")).toBe("major · waits until 25 Nov · needs your OK");
  });
  it("an ordinary update is its risk word", () => {
    expect(riskLabel(update({ risk: "mild" }), NOW, "America/Los_Angeles")).toBe("mild");
    expect(riskLabel(update({ risk: "minor", needsTick: true }), NOW, "America/Los_Angeles")).toBe("minor · needs your OK");
  });
});

const run = (status: CareRunView["status"], summary: string | null = null): CareRunView => ({ id: "r1", batchId: "b1", wave: 0, status, summary, createdAt: daysAgo(0), finishedAt: null });

describe("runLabel", () => {
  it("has a sentence for every status", () => {
    for (const s of ["queued", "running", "ok", "changed", "rolled_back", "failed", "dropped"] as const) {
      expect(runLabel(run(s)).length).toBeGreaterThan(10);
    }
    expect(runLabel(run("queued"))).toBe("Waiting for the helper to start");
    expect(runLabel(run("changed"))).toMatch(/look/i);
    expect(runLabel(run("rolled_back"))).toMatch(/put back/i);
  });
  it("adds the server's summary when there is one", () => {
    expect(runLabel(run("failed", "Backup failed."))).toBe("The run failed. Backup failed.");
  });
});

describe("whyLabel", () => {
  it("turns the server's reason into a sentence", () => {
    expect(whyLabel("no SSH access")).toBe("Can't update this site: no SSH access.");
    expect(whyLabel("on billing hold")).toBe("Can't update this site: on billing hold.");
  });
  it("is empty when there is no reason", () => { expect(whyLabel(null)).toBe(""); });
});

import { canMarkFine, pageFacts, reviewLabel, verdictLabel } from "../src/client/careUpdatesView";

describe("run view words", () => {
  it("Looks fine shows for pending, unsure and broken only", () => {
    expect(["none", "pending", "fine", "broken", "unsure", "logan_ok"].filter((r) => canMarkFine(r as never))).toEqual(["pending", "broken", "unsure"]);
  });
  it("labels are words", () => {
    expect(verdictLabel("changed")).toBe("Looks different");
    expect(reviewLabel("logan_ok")).toBe("You said it's fine");
  });
  it("page facts leave out what was not measured", () => {
    expect(pageFacts({ statusBefore: 200, statusAfter: 500, formsBefore: 1, formsAfter: null, ssim: 0.984 })).toBe("Status 200 → 500 · forms 1 → ? · 98% alike");
    expect(pageFacts({ statusBefore: 200, statusAfter: 200, formsBefore: 0, formsAfter: 0, ssim: null })).toBe("Status 200 → 200 · forms 0 → 0");
  });
});
