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

  it("quick fix and care only are light and get no items", () => {
    expect(onboardingKindOf(["quick_fix"])).toBe("light");
    expect(onboardingKindOf(["care", "care_plus"])).toBe("light");
    expect(itemsFor(["quick_fix", "care"])).toEqual([]);
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
  it("light kinds get the first 6 and build gets all", () => {
    expect(questionsFor("light").map((q) => q.id)).toEqual(QUESTIONS.slice(0, 6).map((q) => q.id));
    expect(questionsFor("build").length).toBe(QUESTIONS.length);
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(13);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
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
    for (const s of ["password: x", "Password = x", "my login: bob", "api key: abc", "API_KEY=abc", "secret: s", "token=abc", "pwd: z", "passphrase : z"]) expect(looksLikeCredential(s), s).toBe(true);
    for (const s of ["We take passwords seriously", "Call us: 555-1234", "Tokens of appreciation", "Our service area: Tacoma"]) expect(looksLikeCredential(s), s).toBe(false);
  });
});
