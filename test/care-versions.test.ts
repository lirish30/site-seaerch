import { describe, expect, it } from "vitest";
import { groupOf, isDue, needsTick, pickCanaries, riskOf, MAJOR_WAIT_DAYS, SSIM_CHANGED, MAX_PATHS } from "../src/worker/care/versions";
import type { CareUpdate } from "../src/worker/db/careUpdates";

const upd = (o: Partial<CareUpdate> = {}): CareUpdate => ({
  id: "u1", siteId: "s1", type: "plugin", slug: "akismet", name: "Akismet", fromVersion: "1.0.0", toVersion: "1.0.1", risk: "minor",
  rollbackable: true, security: false, held: false, firstSeenAt: "2026-11-01T00:00:00.000Z", lastSeenAt: "2026-11-01T00:00:00.000Z", status: "available", ...o,
});

describe("constants", () => {
  it("has the plan values", () => { expect([MAJOR_WAIT_DAYS, SSIM_CHANGED, MAX_PATHS]).toEqual([7, 0.95, 5]); });
});

describe("riskOf", () => {
  it("classifies core", () => {
    expect(riskOf("core", "6.6.2", "6.6.3")).toBe("minor");
    expect(riskOf("core", "6.6.2", "6.7")).toBe("major");
    expect(riskOf("core", "6.9", "7.0")).toBe("major");
  });
  it("classifies plugins and themes", () => {
    expect(riskOf("plugin", "3.2.1", "3.2.2")).toBe("minor");
    expect(riskOf("plugin", "3.2.1", "3.3.0")).toBe("mild");
    expect(riskOf("plugin", "3.2.1", "4.0")).toBe("major");
    expect(riskOf("theme", "2.1", "2.2")).toBe("mild");
    expect(riskOf("plugin", "1.0", "1.0.0.1")).toBe("minor");
  });
  it("treats unreadable versions as major", () => {
    expect(riskOf("plugin", "beta", "1.0")).toBe("major");
    expect(riskOf("plugin", "1.0", "")).toBe("major");
    expect(riskOf("core", "", "6.7")).toBe("major");
  });
  it("reads leading digits of each part", () => {
    expect(riskOf("plugin", "3.2.1-beta", "3.2.2rc1")).toBe("minor");
  });
});

describe("needsTick", () => {
  it("ticks risky slugs, core, majors and non-rollbackable", () => {
    expect(needsTick({ type: "plugin", slug: "akismet", risk: "minor", rollbackable: true })).toBe(false);
    expect(needsTick({ type: "plugin", slug: "woocommerce", risk: "minor", rollbackable: true })).toBe(true);
    expect(needsTick({ type: "plugin", slug: "woocommerce-subscriptions", risk: "minor", rollbackable: true })).toBe(true);
    expect(needsTick({ type: "plugin", slug: "my-booking-calendar", risk: "minor", rollbackable: true })).toBe(true);
    expect(needsTick({ type: "plugin", slug: "elementor-pro", risk: "minor", rollbackable: true })).toBe(true);
    expect(needsTick({ type: "plugin", slug: "contact-form-7", risk: "mild", rollbackable: true })).toBe(true);
    expect(needsTick({ type: "theme", slug: "divi", risk: "minor", rollbackable: true })).toBe(true);
    expect(needsTick({ type: "core", slug: "wordpress", risk: "minor", rollbackable: true })).toBe(true);
    expect(needsTick({ type: "plugin", slug: "akismet", risk: "major", rollbackable: true })).toBe(true);
    expect(needsTick({ type: "plugin", slug: "akismet", risk: "mild", rollbackable: false })).toBe(true);
    expect(needsTick({ type: "plugin", slug: "akismet", risk: "mild", rollbackable: true })).toBe(false);
  });
});

describe("isDue", () => {
  const now = new Date("2026-11-21T12:00:00.000Z");
  it("waits a week for majors", () => {
    expect(isDue(upd({ risk: "major", firstSeenAt: "2026-11-14T13:00:00.000Z" }), now)).toBe(false);
    expect(isDue(upd({ risk: "major", firstSeenAt: "2026-11-14T12:00:00.000Z" }), now)).toBe(true);
  });
  it("skips the wait for security", () => {
    expect(isDue(upd({ risk: "major", security: true, firstSeenAt: "2026-11-21T11:00:00.000Z" }), now)).toBe(true);
    expect(isDue(upd({ risk: "security", firstSeenAt: "2026-11-21T11:00:00.000Z" }), now)).toBe(true);
  });
  it("is due at once for minor and mild", () => {
    expect(isDue(upd({ risk: "minor", firstSeenAt: "2026-11-21T11:00:00.000Z" }), now)).toBe(true);
    expect(isDue(upd({ risk: "mild", firstSeenAt: "2026-11-21T11:00:00.000Z" }), now)).toBe(true);
  });
  it("never when held", () => {
    expect(isDue(upd({ held: true }), now)).toBe(false);
    expect(isDue(upd({ held: true, security: true }), now)).toBe(false);
  });
});

describe("groupOf", () => {
  it("applies precedence woocommerce > booking > builder > brochure", () => {
    expect(groupOf(["akismet"], "twentytwenty")).toBe("brochure");
    expect(groupOf([], null)).toBe("brochure");
    expect(groupOf(["elementor", "woocommerce"], null)).toBe("woocommerce");
    expect(groupOf(["woocommerce/woocommerce.php"], null)).toBe("woocommerce");
    expect(groupOf(["elementor", "bookly-responsive-appointment-booking-tool"], null)).toBe("booking");
    expect(groupOf(["amelia"], null)).toBe("booking");
    expect(groupOf(["bookly"], null)).toBe("booking");
    expect(groupOf(["elementor"], null)).toBe("builder");
    expect(groupOf(["beaver-builder-lite-version"], null)).toBe("builder");
    expect(groupOf(["js_composer"], null)).toBe("builder");
    expect(groupOf(["divi-builder"], null)).toBe("builder");
    expect(groupOf([], "Divi")).toBe("builder");
  });
});

describe("pickCanaries", () => {
  const mk = (n: number, group: "brochure" | "builder", prefix: string, cents = 1000) =>
    Array.from({ length: n }, (_, i) => ({ siteId: `${prefix}${i}`, group, careCents: cents + i * 100, domain: `${prefix}${i}.example` }));
  it("picks the cheapest of fewer than six", () => {
    expect([...pickCanaries(mk(3, "brochure", "b"))]).toEqual(["b0"]);
  });
  it("picks two for six or more", () => {
    expect(pickCanaries(mk(6, "brochure", "b"))).toEqual(new Set(["b0", "b1"]));
    expect(pickCanaries(mk(5, "brochure", "b")).size).toBe(1);
  });
  it("breaks price ties by domain", () => {
    const s = [
      { siteId: "z", group: "brochure" as const, careCents: 500, domain: "zeta.example" },
      { siteId: "a", group: "brochure" as const, careCents: 500, domain: "alpha.example" },
    ];
    expect([...pickCanaries(s)]).toEqual(["a"]);
  });
  it("keeps groups independent", () => {
    expect(pickCanaries([...mk(3, "brochure", "b", 900), ...mk(2, "builder", "d", 5000)])).toEqual(new Set(["b0", "d0"]));
    expect(pickCanaries([])).toEqual(new Set());
  });
});
