import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createPerson } from "../src/worker/db/people";
import { upsertProfile } from "../src/worker/db/seo";
import { PERSONAL_LINE_MAX, REFERRAL_SENTENCE, ladderMail, type LadderMailStep } from "../src/worker/ladder/mail";
import { ladderRecipient, reviewLinkFor } from "../src/worker/ladder/recipient";
import { seedBusiness } from "./fixtures/cro";
import { resetProjectWork } from "./fixtures/projects";

const STEPS: LadderMailStep[] = ["review_request", "testimonial", "check_in", "december_letter"];
const c = { contactName: "  Pat   Jones ", yourName: "Logan Irish", link: "https://search.google.com/local/writereview?placeid=ChIJace", year: 2026, personalLine: "" };

describe("ladder mail", () => {
  it("each of the four mails fills the contact name and your name; none contains a dollar sign, \"guarantee\" or \"#1\"; check_in has the referral sentence; december_letter shows the personal line only when given", () => {
    for (const step of STEPS) {
      const m = ladderMail(step, c);
      expect(m.body.startsWith("Hi Pat,\n\n"), step).toBe(true);
      expect(m.body.endsWith("Thanks,\nLogan Irish"), step).toBe(true);
      for (const text of [m.subject, m.body]) {
        expect(text, step).not.toContain("$");
        expect(text.toLowerCase(), step).not.toContain("guarantee");
        expect(text, step).not.toContain("#1");
      }
      expect(m.subject.length, step).toBeGreaterThan(0);
      expect(m.subject, step).not.toMatch(/\n/);
    }
    expect(ladderMail("check_in", c).body).toContain(REFERRAL_SENTENCE);
    for (const step of ["review_request", "testimonial", "december_letter"] as const) expect(ladderMail(step, c).body, step).not.toContain(REFERRAL_SENTENCE);
    expect(ladderMail("review_request", c).body).toContain(c.link);
    expect(ladderMail("review_request", { ...c, link: null }).body).not.toContain("https://");

    const plain = ladderMail("december_letter", c);
    expect(plain.subject).toContain("2026");
    expect(plain.body).toContain("2027");
    const line = "Your fence photos from June are still my favourite.";
    const personal = ladderMail("december_letter", { ...c, personalLine: `  ${line}\n  ` });
    expect(personal.body.split("\n\n")).toContain(line); // its own paragraph
    expect(personal.body.split("\n\n")).toHaveLength(plain.body.split("\n\n").length + 1);
    expect(plain.body).not.toContain(line);
    expect(ladderMail("december_letter", { ...c, personalLine: "   " }).body).toBe(plain.body);
  });

  it("puts what a person typed on one line and caps the personal line; with no name it says Hi, and with a saved signature no name is added", () => {
    const m = ladderMail("december_letter", { ...c, contactName: "", yourName: "", personalLine: `a\n\nb ${"x".repeat(PERSONAL_LINE_MAX)}` });
    expect(m.body.startsWith("Hi,\n\n")).toBe(true);
    expect(m.body.endsWith("Thanks,")).toBe(true);
    const para = m.body.split("\n\n").find((p) => p.startsWith("a b "))!;
    expect(para.length).toBe(PERSONAL_LINE_MAX);
  });
});

describe("ladder recipient and review link", () => {
  beforeEach(async () => { await resetProjectWork(); await env.DB.prepare(`DELETE FROM people`).run(); await env.DB.prepare(`DELETE FROM seo_profiles`).run(); });
  const person = (businessId: string, name: string, role: string | null, email: string | null, poc = false) => createPerson(env.DB, businessId, { name, role, email, is_poc: poc });

  it("takes the first person with an email: owner, then decision maker, then billing, then anyone, matching the free-text role in any case", async () => {
    const b = await seedBusiness();
    expect(await ladderRecipient(env.DB, b.id)).toBeNull();
    await person(b.id, "Sam", null, null, true); // the point of contact has no email
    expect(await ladderRecipient(env.DB, b.id)).toBeNull();
    await person(b.id, "Alex", "Office manager", "alex@ace.test");
    expect(await ladderRecipient(env.DB, b.id)).toEqual({ to: "alex@ace.test", contactName: "Alex" });
    await person(b.id, "Bea", "Accounts / BILLING contact", "bea@ace.test");
    expect((await ladderRecipient(env.DB, b.id))?.to).toBe("bea@ace.test");
    await person(b.id, "Dee", "Final Decision-maker", "dee@ace.test");
    expect((await ladderRecipient(env.DB, b.id))?.to).toBe("dee@ace.test");
    await person(b.id, "Ola", "Owner", "not an address");
    expect((await ladderRecipient(env.DB, b.id))?.to).toBe("dee@ace.test"); // an unusable address is never chosen
    await person(b.id, "Pat  Jones", "co-OWNER", "pat@ace.test");
    expect(await ladderRecipient(env.DB, b.id)).toEqual({ to: "pat@ace.test", contactName: "Pat Jones" });
  });

  it("the review link is the step's own https link, else the Google write-a-review page of the Local SEO place id, else null", async () => {
    const b = await seedBusiness();
    expect(await reviewLinkFor(env.DB, b.id, { link: null })).toBeNull();
    expect(await reviewLinkFor(env.DB, b.id, { link: "http://insecure.test/r" })).toBeNull();
    await upsertProfile(env.DB, b.id, { placeId: "ChIJ abc/1" }, "2026-11-01T00:00:00.000Z");
    expect(await reviewLinkFor(env.DB, b.id, { link: null })).toBe("https://search.google.com/local/writereview?placeid=ChIJ%20abc%2F1");
    expect(await reviewLinkFor(env.DB, b.id, { link: "https://g.page/r/own" })).toBe("https://g.page/r/own");
  });
});
