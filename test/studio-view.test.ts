import { describe, expect, it } from "vitest";
import { captionWithTags, copyEdit, newPostBody, nextAction, statusLabel } from "../src/client/studioView";
import type { StudioStatus } from "../src/worker/db/studio";

const post = (status: StudioStatus) => ({ id: "p1", kind: "audit_tip" as const, status, businessId: null, source: {}, anonymize: true, agreedAt: null, copy: {}, images: 0, claudeTaskId: null, approvalId: null, postedOn: null, createdAt: "", updatedAt: "" });

describe("studio view", () => {
  it("nextAction per status", () => {
    expect(nextAction(post("draft"))).toEqual({ label: "Write the words", route: "/api/studio/p1/write" });
    expect(nextAction(post("writing"))).toBeNull();
    expect(nextAction(post("review"))).toEqual({ label: "Approve in the inbox", route: "/today" });
    expect(nextAction(post("approved"))).toEqual({ label: "Download and post", route: "/api/studio/p1/posted" });
    expect(nextAction(post("posted"))).toBeNull();
    expect(nextAction(post("discarded"))).toBeNull();
  });

  it("captionWithTags joins the caption and the tags with a blank line", () => {
    expect(captionWithTags({ headline: "H", caption: "Plain tips.", slides: [], tags: ["plumber", "boise"] })).toBe("Plain tips.\n\n#plumber #boise");
    expect(captionWithTags({ headline: "H", caption: "Plain tips.", slides: [], tags: [] })).toBe("Plain tips.");
  });

  it("statusLabel says words not codes", () => {
    const words = (["draft", "writing", "review", "approved", "posted", "discarded"] as StudioStatus[]).map(statusLabel);
    expect(words).toEqual(["Draft", "Waiting for Claude", "Ready to review", "Approved", "Posted", "Discarded"]);
    for (const w of words) expect(w).not.toMatch(/_/);
  });

  it("a new post is anonymous unless the client agreed, and says what is missing", () => {
    const f = { kind: "audit_tip" as const, auditId: " a1 ", businessId: "", anonymous: true, agreed: false };
    expect(newPostBody(f)).toEqual({ body: { kind: "audit_tip", auditId: "a1", anonymize: true } });
    expect(newPostBody({ ...f, auditId: " " })).toEqual({ problem: "Enter the id of the audit this post is about." });
    expect(newPostBody({ ...f, kind: "case_study", businessId: "" })).toEqual({ problem: "Choose the client this case study is about." });
    expect(newPostBody({ ...f, kind: "case_study", businessId: "b1" })).toEqual({ body: { kind: "case_study", businessId: "b1", anonymize: true } });
    // Unticked anonymity counts only with the agreement; without it the post stays anonymous.
    expect(newPostBody({ ...f, kind: "before_after", anonymous: false, agreed: false })).toEqual({ body: { kind: "before_after", anonymize: true } });
    expect(newPostBody({ ...f, kind: "before_after", anonymous: false, agreed: true })).toEqual({ body: { kind: "before_after", anonymize: false, agreed: true } });
  });

  it("a copy edit is cleaned: tags lose hashes and spaces, empty slides are dropped", () => {
    expect(copyEdit({ headline: " H ", caption: " C ", slides: [{ title: " T ", body: " B " }, { title: " ", body: "" }], tagText: "#plumber, boise  #roofing" })).toEqual({
      headline: "H", caption: "C", slides: [{ title: "T", body: "B" }], tags: ["plumber", "boise", "roofing"],
    });
  });
});
