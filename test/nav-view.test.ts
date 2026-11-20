import { describe, expect, it } from "vitest";
import { sectionOf, sidebarOf } from "../src/client/navView";

describe("the Projects section", () => {
  it("sectionOf maps /projects/abc and /timesheet to work and sidebarOf gives it a sidebar", () => {
    for (const p of ["/projects", "/projects/abc", "/timesheet", "/tasks/t1", "/billing"]) expect(sectionOf(p), p).toBe("work");
    for (const p of ["/projects", "/projects/abc", "/timesheet", "/billing"]) expect(sidebarOf(p), p).toBe("work");
  });
  it("does not disturb the other sections", () => {
    expect(sectionOf("/today")).toBe("home");
    expect(sectionOf("/leads/abc")).toBe("leads");
    expect(sectionOf("/pipeline")).toBe("outreach");
    expect(sectionOf("/")).toBe("find");
    expect(sectionOf("/projectsfoo")).toBe("find");
    expect(sidebarOf("/leads/abc")).toBeNull();
  });
});
