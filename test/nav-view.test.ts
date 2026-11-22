import { describe, expect, it } from "vitest";
import { sectionOf, sidebarOf } from "../src/client/navView";

describe("the Projects section", () => {
  it("sectionOf maps /projects/abc and /timesheet to work and sidebarOf gives it a sidebar", () => {
    for (const p of ["/projects", "/projects/abc", "/timesheet", "/tasks/t1", "/billing", "/money", "/care", "/seo"]) expect(sectionOf(p), p).toBe("work");
    for (const p of ["/projects", "/projects/abc", "/timesheet", "/billing", "/money", "/care", "/seo"]) expect(sidebarOf(p), p).toBe("work");
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

describe("the Clients pages", () => {
  it("sit in the Projects section: the list has its sidebar, one client's page uses the full width", () => {
    for (const p of ["/clients", "/clients/abc"]) expect(sectionOf(p), p).toBe("work");
    expect(sidebarOf("/clients")).toBe("work");
    expect(sidebarOf("/clients/abc")).toBeNull();
    expect(sectionOf("/clientsfoo")).toBe("find");
  });
});
