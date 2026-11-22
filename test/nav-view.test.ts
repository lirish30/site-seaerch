import { describe, expect, it } from "vitest";
import { sectionOf, sidebarOf } from "../src/client/navView";

describe("rail sections (Figma: Home, Approvals, Leads, Find, Outreach, Sales, Clients, Work, Money)", () => {
  it("puts each page in its section", () => {
    const cases: [string, string][] = [
      ["/today", "home"], ["/approvals", "approvals"], ["/leads", "leads"], ["/leads/abc", "leads"], ["/promising", "leads"],
      ["/", "find"], ["/searches", "find"], ["/radar", "find"], ["/outreach", "outreach"], ["/studio", "outreach"],
      ["/pipeline", "sales"], ["/campaigns", "sales"], ["/deals/d1", "sales"], ["/deals/d1/deck", "sales"],
      ["/clients", "clients"], ["/clients/c1", "clients"], ["/care", "clients"], ["/care/reports", "clients"], ["/care/updates", "clients"], ["/seo", "clients"],
      ["/projects", "work"], ["/projects/p1", "work"], ["/tasks/t1", "work"], ["/timesheet", "work"], ["/batches", "work"],
      ["/money", "money"], ["/billing", "money"], ["/settings/profile", "settings"],
    ];
    for (const [p, s] of cases) expect(sectionOf(p), p).toBe(s);
  });
  it("does not match a path that only starts with a section's name", () => {
    expect(sectionOf("/projectsfoo")).toBe("find");
    expect(sectionOf("/clientsfoo")).toBe("find");
  });
  it("gives list pages a sidebar and one record the full width", () => {
    for (const p of ["/clients", "/care", "/seo"]) expect(sidebarOf(p), p).toBe("clients");
    for (const p of ["/projects", "/timesheet", "/batches"]) expect(sidebarOf(p), p).toBe("work");
    for (const p of ["/money", "/billing"]) expect(sidebarOf(p), p).toBe("money");
    for (const p of ["/pipeline", "/campaigns"]) expect(sidebarOf(p), p).toBe("sales");
    for (const p of ["/leads/abc", "/clients/abc", "/deals/d1", "/projects/p1", "/approvals"]) expect(sidebarOf(p), p).toBeNull();
  });
});
