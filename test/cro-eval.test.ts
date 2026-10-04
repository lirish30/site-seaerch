import { describe, it, expect } from "vitest";
import type { CroCaller } from "../src/worker/cro/ai";
import type { Business } from "../src/worker/types";
import { MODELS, esc, parseFixture, runEval, seededRandom, type Fixture } from "../scripts/cro-eval";
import { ev, model, rec } from "./fixtures/cro";

const business = { id: "b1", name: "Ace <b>Plumbing</b>", category: "Plumber", website_url: "https://ace.com" } as Business;
const page = { index: 0, url: "https://ace.com/", kind: "home" as const, ok: true, key: "k" };
const fx: Fixture = {
  business, evidence: [ev("E1"), ev("E2", { family: "martech", page: "site" })],
  pages: [{ ref: page, text: "Call us for fast plumbing repairs in Boise", shots: { desktop: null, mobile: null } }],
};
const [H, S] = MODELS;

// A fake caller per model: Haiku invents a quote that isn't on the page, Sonnet quotes real text.
const fake = (m: string): CroCaller => async ({ stage }) => {
  const haiku = m === H;
  const input = stage === "model" ? model()
    : stage === "pages" ? { five_second_read: { thinks_business_does: "Plumbing", would_do_next: "Call" }, strengths: [],
      issues: [{ observation: "o", quote: haiku ? "Totally made up" : "fast plumbing repairs", principle: "p", evidence_ids: ["E1"] }] }
    : { positioning: { says_now: "a", should_say: "b" }, recommendations: [
      rec({ title: "Fix <script>alert(1)</script>", observation: haiku ? `Says "Totally made up" on the page` : `Says "fast plumbing repairs" on the page` }), rec({ title: "Second" })] };
  return { input, costUsd: 0.01, model: m };
};

describe("cro-eval", () => {
  it("computes per-model metrics and never leaks the model into the blind HTML", async () => {
    const r = await runEval([{ name: "a.json", fx }, { name: "b.json", fx }], fake, { seed: 7, date: "2026-10-04" });
    expect(r.metrics[H].pages).toMatchObject({ calls: 2, items: 2, dropped: 2, quoted: 2 });
    expect(r.metrics[S].pages).toMatchObject({ calls: 2, items: 2, dropped: 0, quoted: 2 });
    expect(r.metrics[H].synthesize).toMatchObject({ items: 4, dropped: 2, quoted: 2 });
    expect(r.verdicts).toEqual({ model: false, pages: true, synthesize: true });
    expect(r.md).toContain("Business-model agreement: 2/2");
    expect(r.md).toContain('set CRO_MODELS.pages = "claude-sonnet-5-5"');
    expect(r.html).not.toMatch(/haiku|sonnet|claude/i);
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("Fix &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(r.html).toContain("Ace &lt;b&gt;Plumbing&lt;/b&gt;");
    expect(Object.keys(r.key.sites)).toEqual(["a.json", "b.json"]);
    for (const s of Object.values(r.key.sites)) expect([s.A, s.B].sort()).toEqual([H, S].sort());
  });

  it("is reproducible from the seed, and the seed is in the key", async () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ name: `s${i}.json`, fx }));
    const a = await runEval(files, fake, { seed: 42, date: "d" });
    const b = await runEval(files, fake, { seed: 42, date: "d" });
    const c = await runEval(files, fake, { seed: 43, date: "d" });
    expect(a.key.seed).toBe(42);
    expect(b.key).toEqual(a.key);
    expect(c.key.sites).not.toEqual(a.key.sites);
    expect(seededRandom(1)()).toBe(seededRandom(1)());
  });

  it("records refusals and API errors as failures instead of crashing the run", async () => {
    const refusing = (m: string): CroCaller => async (req) => {
      if (m === H && req.stage === "pages") throw new Error("Claude declined to review this site");
      if (m === S && req.stage === "model") throw new Error("overloaded");
      return fake(m)(req);
    };
    const r = await runEval([{ name: "a.json", fx }], refusing, { seed: 1, date: "d" });
    expect(r.metrics[H].pages).toMatchObject({ calls: 1, errors: 1, items: 0 });
    expect(r.metrics[H].synthesize.calls).toBe(1);
    expect(r.metrics[S].model.errors).toBe(1);
    expect(r.metrics[S].pages.calls).toBe(0);
    expect(r.failures).toHaveLength(2);
    expect(r.md).toContain("Claude declined to review this site");
    expect(r.md).toContain("Business-model agreement: 0/0");
  });

  it("counts schema failures and rejects a file that is not a fixture", async () => {
    const bad: CroCaller = async () => ({ input: { nope: 1 }, costUsd: 0.01, model: "m" });
    const r = await runEval([{ name: "a.json", fx }], () => bad, { seed: 1, date: "d" });
    expect(r.metrics[H].model).toMatchObject({ calls: 1, schemaFails: 1, costUsd: 0.02 });
    expect(() => parseFixture({ business: {} }, "x.json")).toThrow(/not an eval fixture/);
    expect(parseFixture(fx, "ok.json")).toBe(fx);
    expect(esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});
