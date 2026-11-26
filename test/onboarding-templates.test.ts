import { describe, expect, it } from "vitest";
import { ITEM_TEMPLATES, QUESTIONS, cleanText, itemsFor, looksLikeCredential, onboardingKindOf, questionsFor, validateAnswers } from "../src/worker/onboarding/templates";
import type { PackageKey } from "../src/worker/db/packages";

const keysOf = (k: PackageKey[]) => itemsFor(k).map((i) => i.key);

describe("item templates", () => {
  it("a starter site gets homepage and one service page in phase 1", () => {
    const items = itemsFor(["starter_site", "care"]);
    const p1 = items.filter((i) => i.phase === 1).map((i) => i.key);
    expect(p1).toEqual(expect.arrayContaining(["homepage_text", "homepage_photos", "service_page_text", "service_photos", "logo_files", "brand_text"]));
    expect(items.filter((i) => i.phase === 2).map((i) => i.key)).toContain("extra_pages_text");
    expect(items.every((i) => i.label && i.instructions && (i.kind === "text" || i.kind === "files"))).toBe(true);
  });

  it("growth adds service-area but starter does not", () => {
    expect(keysOf(["growth_site"])).toContain("service_area_text");
    expect(keysOf(["growth_site"])).not.toContain("extra_pages_text");
    expect(keysOf(["starter_site"])).not.toContain("service_area_text");
  });

  it("quick fix and care only are light and get just the six access items", () => {
    expect(onboardingKindOf(["quick_fix"])).toBe("light");
    expect(onboardingKindOf(["care", "care_plus"])).toBe("light");
    expect(keysOf(["quick_fix", "care"])).toEqual(["access_hosting", "access_dns", "access_registrar", "access_admin", "access_gbp", "access_analytics"]);
    expect(itemsFor(["hourly"])).toEqual([]);
    expect(onboardingKindOf(["starter_site", "care"])).toBe("build");
    expect(onboardingKindOf(["website_subscription"])).toBe("build");
  });

  it("unknown package keys are ignored", () => {
    const keys = ["starter_site", "no_such_package", ""] as unknown as PackageKey[];
    expect(onboardingKindOf(keys)).toBe("build");
    expect(keysOf(keys)).toEqual(keysOf(["starter_site"]));
    expect(itemsFor(["nope" as PackageKey])).toEqual([]);
  });

  it("item keys are unique and every template has phase 1 or 2", () => {
    const k = ITEM_TEMPLATES.map((t) => t.key);
    expect(new Set(k).size).toBe(k.length);
    expect(ITEM_TEMPLATES.every((t) => t.phase === 1 || t.phase === 2)).toBe(true);
  });
});

describe("questions", () => {
  it("light kinds get the original six and how_found, and build gets all", () => {
    expect(questionsFor("light").map((q) => q.id)).toEqual([...QUESTIONS.slice(0, 6).map((q) => q.id), "how_found"]);
    expect(questionsFor("build").length).toBe(QUESTIONS.length);
    expect(QUESTIONS.length).toBe(26);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
  });

  it("the discovery questions are on the build form, and only how_found also reaches light", () => {
    const added = ["ideal_customer", "supporting_services", "proof_stats", "visitor_actions", "key_info", "pages_wanted", "update_pages", "competitor_sites", "look_and_feel", "public_details", "business_emails", "how_found"];
    const required = ["ideal_customer", "visitor_actions", "pages_wanted", "competitor_sites", "look_and_feel", "public_details"];
    const byId = new Map(QUESTIONS.map((q) => [q.id, q] as const));
    for (const id of added) {
      const q = byId.get(id);
      expect(q, id).toBeDefined();
      expect(q!.required, id).toBe(required.includes(id));
      expect(q!.kinds, id).toEqual(id === "how_found" ? ["build", "light"] : ["build"]);
      expect(q!.label.trim().length, id).toBeGreaterThan(0);
      expect(`${q!.label} ${q!.help ?? ""}`, id).not.toMatch(/[\u2014!]/);
    }
    expect(byId.get("pages_wanted")!.help).toMatch(/Starter is up to 5 pages, Growth is up to 12|Starter is up to 5 pages and Growth is up to 12/);
    expect(byId.get("pages_wanted")!.help).toContain("Extra pages are quoted separately");
    expect(`${byId.get("pages_wanted")!.help}`).not.toMatch(/\$/);
  });

  it("each new required question blocks submit when blank, for a build and not for a light onboarding", () => {
    for (const id of ["ideal_customer", "visitor_actions", "pages_wanted", "competitor_sites", "look_and_feel", "public_details"]) {
      const blank = validateAnswers("build", { [id]: "   " }, { requireAll: true });
      expect(blank.problems.some((p) => p.startsWith(`${id}:`)), id).toBe(true);
      expect(validateAnswers("build", { [id]: "An answer." }, { requireAll: true }).problems.some((p) => p.startsWith(`${id}:`)), id).toBe(false);
      // A light form does not ask it: an answer is an unknown id.
      expect(validateAnswers("light", { [id]: "An answer." }, { requireAll: false }).problems.length, id).toBe(1);
    }
    // The optional new ones never block, and how_found is accepted on both forms.
    const optional = validateAnswers("build", {}, { requireAll: true }).problems.map((p) => p.split(":")[0]);
    for (const id of ["supporting_services", "proof_stats", "key_info", "update_pages", "business_emails", "how_found"]) expect(optional).not.toContain(id);
    expect(validateAnswers("light", { how_found: "A neighbor told me." }, { requireAll: false }).problems).toEqual([]);
  });

  it("the business email question refuses a typed login like every other answer", () => {
    expect(validateAnswers("build", { business_emails: "Google, password: hunter2hunter2" }, { requireAll: false }).problems).toEqual(["business_emails: this looks like a login or password. Please never send those here; remove it."]);
  });

  it("required questions block submit", () => {
    const r = validateAnswers("build", {}, { requireAll: true });
    const required = QUESTIONS.filter((q) => q.required).map((q) => q.id);
    expect(required.length).toBeGreaterThan(0);
    for (const id of required) expect(r.problems.some((p) => p.includes(id))).toBe(true);
    // A draft save does not need them.
    expect(validateAnswers("build", {}, { requireAll: false }).problems).toEqual([]);
    // Blank (whitespace only) counts as missing.
    expect(validateAnswers("light", { [required[0]]: "   " }, { requireAll: true }).problems.some((p) => p.includes(required[0]))).toBe(true);
  });

  it(`a free-text answer with "password: x" is refused and the problem does not echo it`, () => {
    const secret = "hunter2-very-secret";
    const r = validateAnswers("build", { business: `We fix roofs. password: ${secret}` }, { requireAll: false });
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toContain("business");
    expect(r.problems.join(" ")).not.toContain(secret);
    expect(r.problems.join(" ")).not.toContain("password:");
  });

  it("an unknown id is refused without echoing it", () => {
    const r = validateAnswers("build", { "<script>x</script>": "a" }, { requireAll: false });
    expect(r.problems.length).toBe(1);
    expect(r.problems.join(" ")).not.toContain("script");
    // A question that exists only for build is unknown for light.
    const build = QUESTIONS[8].id;
    expect(validateAnswers("light", { [build]: "a" }, { requireAll: false }).problems.length).toBe(1);
  });

  it("caps: short 300, long 3000", () => {
    const short = QUESTIONS.find((q) => q.type === "short")!, long = QUESTIONS.find((q) => q.type === "long")!;
    expect(validateAnswers("build", { [short.id]: "a".repeat(300) }, { requireAll: false }).problems).toEqual([]);
    expect(validateAnswers("build", { [short.id]: "a".repeat(301) }, { requireAll: false }).problems.length).toBe(1);
    expect(validateAnswers("build", { [long.id]: "a".repeat(3000) }, { requireAll: false }).problems).toEqual([]);
    expect(validateAnswers("build", { [long.id]: "a".repeat(3001) }, { requireAll: false }).problems.length).toBe(1);
  });

  it("choice must match an option", () => {
    const q = QUESTIONS.find((x) => x.type === "choice")!;
    expect(q.options!.length).toBeGreaterThan(1);
    expect(validateAnswers("build", { [q.id]: q.options![0] }, { requireAll: false }).problems).toEqual([]);
    const bad = validateAnswers("build", { [q.id]: "something else" }, { requireAll: false });
    expect(bad.problems.length).toBe(1);
    expect(bad.problems[0]).toContain(q.id);
    expect(bad.problems[0]).not.toContain("something else");
  });

  it("a non-string answer is a problem, not a throw", () => {
    const r = validateAnswers("build", { business: 5 as unknown as string }, { requireAll: false });
    expect(r.problems.length).toBe(1);
  });
});

describe("cleanText", () => {
  it("an answer with bidi controls is cleaned", () => {
    const dirty = "‮evil‬ ​name⁦x⁩\u0007\u0000 ok";
    expect(cleanText(dirty, 100)).toBe("evil namex ok");
    expect(/[‪-‮⁦-⁩​\u0007\u0000]/.test(cleanText(dirty, 100))).toBe(false);
  });

  it("keeps newline and tab, trims, and cuts", () => {
    expect(cleanText("  a\tb\nc  ", 100)).toBe("a\tb\nc");
    expect(cleanText("abcdef", 3)).toBe("abc");
    expect(cleanText("a\r\nb", 100)).toBe("a\nb");
  });

  it("does not cut a surrogate pair in half", () => {
    const s = cleanText("ab\u{1F600}cd", 3);
    expect(s).toBe("ab");
  });

  it("a cleaned answer passes validation as stored", () => {
    expect(validateAnswers("build", { business: "We fix roofs.‮" }, { requireAll: false }).problems).toEqual([]);
  });
});

describe("looksLikeCredential", () => {
  it("matches the usual shapes and not plain prose", () => {
    for (const s of ["password: x", "Password = x", "my login: bob", "api key: abc", "API_KEY=abc", "secret: s", "token=abc", "pwd: z", "passphrase : z", "my pass: x", "wifi password=abc"]) expect(looksLikeCredential(s), s).toBe(true);
    for (const s of ["We take passwords seriously", "Call us: 555-1234", "Tokens of appreciation", "Our service area: Tacoma", "compass: north", "bypass: the main road", "Tollpass: 5 dollars"]) expect(looksLikeCredential(s), s).toBe(false);
  });
});
