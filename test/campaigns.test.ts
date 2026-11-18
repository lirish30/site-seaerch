import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { saveSettings } from "../src/worker/db/settings";
import { estimateSearchCost } from "../src/worker/cost";
import { startSearchRun } from "../src/worker/search-start";
import { StepInvariantError, createCampaign, getCampaign, listCampaigns, listSteps, saveStep, updateCampaign } from "../src/worker/db/campaigns";
import { MissingFieldError, PROBLEM_ONE_FALLBACK, pickVariant, renderTemplate } from "../src/worker/sequence/template";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const send = (method: string, path: string, body?: unknown) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

let created: any[] = [];
let failTown: string | null = null;
let origCreate: any;
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.prepare(`UPDATE fixed_costs SET active = 0`).run(); // these tests budget metered usage only
  await env.DB.batch([env.DB.prepare(`DELETE FROM campaigns`), env.DB.prepare(`DELETE FROM searches`), env.DB.prepare(`DELETE FROM usage`)]);
  await saveSettings(env.DB, { physical_address: "1 Main St, Boise, ID", opt_out_line: "Reply 'no thanks'.", monthly_spend_limit_usd: 25 });
  created = []; failTown = null;
  origCreate = env.SEARCH_WORKFLOW.create;
  (env.SEARCH_WORKFLOW as any).create = async (o: any) => {
    if (failTown) throw new Error(failTown);
    created.push(o); return {} as any;
  };
});
afterEach(async () => {
  (env.SEARCH_WORKFLOW as any).create = origCreate;
  await saveSettings(env.DB, { monthly_spend_limit_usd: 25 });
});

const NEW = { name: "Boise plumbers", niche: "plumber", region: "Treasure Valley, ID", towns: ["Boise, ID", "Meridian, ID"] };
const searchRows = () => env.DB.prepare(`SELECT * FROM searches ORDER BY created_at, id`).all<any>().then((r) => r.results);

describe("default steps", () => {
  it("new campaign gets five default steps in order", async () => {
    const c = await createCampaign(env.DB, NEW);
    expect(c).toMatchObject({ name: "Boise plumbers", niche: "plumber", region: "Treasure Valley, ID", towns: ["Boise, ID", "Meridian, ID"], status: "testing", est_job_value_usd: null });
    const steps = await listSteps(env.DB, c.id);
    expect(steps.map((s) => [s.idx, s.kind, s.offset_days, s.offset_kind])).toEqual([
      [0, "email", 0, "business"], [1, "email", 5, "business"], [2, "call", 7, "calendar"], [3, "email", 12, "business"], [4, "checkin", 90, "calendar"],
    ]);
    expect(steps[0]).toMatchObject({ variants: [], body_source: "draft" });
    expect(steps[1].subject).toBe("Re: Quick video about {Business}'s website");
    expect(steps[1].variants).toHaveLength(2);
    expect(steps[3].variants).toHaveLength(2);
    expect(steps[4].variants.length).toBeGreaterThanOrEqual(1);
    expect(steps[2].variants).toEqual([]);
  });

  it("every default body renders once its merge fields are filled, and carries no price", async () => {
    const c = await createCampaign(env.DB, NEW);
    const vars = { Business: "Acme Plumbing", Name: "Sam", link: "https://go.example.test/x", problem_one: "contact form" };
    for (const s of await listSteps(env.DB, c.id)) {
      expect(renderTemplate(s.subject, vars)).not.toMatch(/[{}]/);
      for (const v of s.variants) {
        const out = renderTemplate(v, vars);
        expect(out, `step ${s.idx}`).not.toMatch(/[{}]/);
        expect(out, `step ${s.idx}`).not.toMatch(/\$|\d/);
      }
    }
  });

  it("both Email 3 variants render with the problem_one fallback", async () => {
    expect(PROBLEM_ONE_FALLBACK).toBe("website");
    const c = await createCampaign(env.DB, NEW);
    const email3 = (await listSteps(env.DB, c.id))[3];
    const vars = { Business: "Acme", Name: "Sam", link: "https://go.example.test/x", problem_one: PROBLEM_ONE_FALLBACK };
    const [a, b] = email3.variants.map((v) => renderTemplate(v, vars));
    expect(a).toContain("If the website ever becomes a priority");
    expect(b).toContain("If the website ever moves up your list");
  });

  it("check-in copy claims no re-visit of the site and nothing about what changed", async () => {
    const c = await createCampaign(env.DB, NEW);
    for (const v of (await listSteps(env.DB, c.id))[4].variants) expect(v).not.toMatch(/\b(took|another|again|changed|new|still)\b/i);
  });

  it("two campaigns each get their own steps", async () => {
    const a = await createCampaign(env.DB, NEW);
    const b = await createCampaign(env.DB, { ...NEW, name: "Other" });
    expect(await listSteps(env.DB, a.id)).toHaveLength(5);
    expect(await listSteps(env.DB, b.id)).toHaveLength(5);
    expect((await listCampaigns(env.DB)).map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("saveStep replaces a step in place and updateCampaign patches fields", async () => {
    const c = await createCampaign(env.DB, NEW);
    await saveStep(env.DB, c.id, { idx: 1, kind: "email", offset_days: 4, offset_kind: "business", subject: "Hello", variants: ["One {Name}"] });
    const steps = await listSteps(env.DB, c.id);
    expect(steps).toHaveLength(5);
    expect(steps[1]).toMatchObject({ offset_days: 4, subject: "Hello", variants: ["One {Name}"] });
    const u = await updateCampaign(env.DB, c.id, { status: "active", est_job_value_usd: 1200, towns: ["Nampa, ID"] });
    expect(u).toMatchObject({ status: "active", est_job_value_usd: 1200, towns: ["Nampa, ID"], name: "Boise plumbers" });
    expect(await getCampaign(env.DB, c.id)).toEqual(u);
    expect((await updateCampaign(env.DB, c.id, { est_job_value_usd: null }))!.est_job_value_usd).toBeNull();
    expect(await updateCampaign(env.DB, "nope", { name: "x" })).toBeNull();
  });
});

describe("saveStep body rules", () => {
  const email = { kind: "email" as const, offset_days: 3, offset_kind: "business" as const, subject: "S" };
  const rejects = async (idx: number, step: Parameters<typeof saveStep>[2], field: string) => {
    const c = await createCampaign(env.DB, NEW);
    const before = await listSteps(env.DB, c.id);
    await expect(saveStep(env.DB, c.id, { ...step, idx })).rejects.toMatchObject({ name: "StepInvariantError", field });
    expect(await listSteps(env.DB, c.id)).toEqual(before);
  };

  it("rejects draft on a step other than 0", async () => {
    await rejects(3, { ...email, idx: 3, variants: [], body_source: "draft" }, "body_source");
    await rejects(4, { ...email, kind: "checkin", idx: 4, variants: ["x"], body_source: "draft" }, "body_source");
  });
  it("rejects variants or a 'variants' body_source on step 0", async () => {
    await rejects(0, { ...email, idx: 0, variants: ["x"] }, "variants");
    await rejects(0, { ...email, idx: 0, variants: [], body_source: "variants" }, "body_source");
  });
  it("rejects empty variants on an email or check-in, and more than 5 anywhere", async () => {
    await rejects(1, { ...email, idx: 1, variants: [] }, "variants");
    await rejects(4, { ...email, kind: "checkin", idx: 4, variants: [] }, "variants");
    await rejects(1, { ...email, idx: 1, variants: ["1", "2", "3", "4", "5", "6"] }, "variants");
  });
  it("editing step 0's offset keeps the draft marker, with or without body_source in the input", async () => {
    const c = await createCampaign(env.DB, NEW);
    const a = await saveStep(env.DB, c.id, { ...email, idx: 0, offset_days: 2, variants: [] });
    expect(a).toMatchObject({ offset_days: 2, body_source: "draft", variants: [] });
    const b = await saveStep(env.DB, c.id, { ...email, idx: 0, offset_days: 1, subject: "New", variants: [], body_source: "draft" });
    expect(b).toMatchObject({ offset_days: 1, subject: "New", body_source: "draft" });
  });
  it("omitting body_source on another step keeps 'variants'", async () => {
    const c = await createCampaign(env.DB, NEW);
    expect(await saveStep(env.DB, c.id, { ...email, idx: 1, variants: ["Only {Name}"] })).toMatchObject({ body_source: "variants", variants: ["Only {Name}"] });
  });
  it("exports the error class", () => { expect(new StepInvariantError("variants", "m").field).toBe("variants"); });
});

describe("renderTemplate", () => {
  it("renderTemplate fills fields", () => {
    expect(renderTemplate("Hi {Name}, about {Business}: {link} {Name}", { Name: "Sam", Business: "Acme", link: "https://x.test" }))
      .toBe("Hi Sam, about Acme: https://x.test Sam");
  });

  it("missing field throws with its name", () => {
    let err: unknown;
    try { renderTemplate("The {problem_one} on {Business} and {problem_one} again", { Business: "Acme" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MissingFieldError);
    expect((err as MissingFieldError).fields).toEqual(["problem_one"]);
    expect((err as Error).message).toContain("problem_one");
  });

  it("lists every missing field, treats empty or blank values as missing, ignores extra vars", () => {
    try { renderTemplate("{A} {B} {C}", { A: "a", B: "", C: "  ", D: "extra" }); expect.unreachable(); }
    catch (e) { expect((e as MissingFieldError).fields).toEqual(["B", "C"]); }
    try { renderTemplate("{A} {B}", { A: undefined }); expect.unreachable(); }
    catch (e) { expect((e as MissingFieldError).fields).toEqual(["A", "B"]); }
    expect(renderTemplate("{A}", { A: "a", D: "extra" })).toBe("a");
  });

  it("inherited names like {constructor} or {toString} are missing fields, not a TypeError", () => {
    for (const f of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      try { renderTemplate(`Hi {${f}}`, { Name: "Sam" }); expect.unreachable(); }
      catch (e) { expect(e, f).toBeInstanceOf(MissingFieldError); expect((e as MissingFieldError).fields).toEqual([f]); }
    }
    expect(() => renderTemplate("{A}", { A: 5 as unknown as string })).toThrow(MissingFieldError);
  });

  it("leaves literal braces that are not fields alone, and does not re-expand values or treat $ specially", () => {
    expect(renderTemplate("{} { x } {a b} {{Name}} {", { Name: "Sam" })).toBe("{} { x } {a b} {Sam} {");
    expect(renderTemplate("{A} {B}", { A: "{B}", B: "$& $1" })).toBe("{B} $& $1");
  });
});

describe("pickVariant", () => {
  it("pickVariant is stable per seed and varies across seeds", () => {
    const v = ["first", "second"];
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const seed = `lead-${i}`;
      const a = pickVariant(v, seed);
      expect(pickVariant(v, seed)).toBe(a);
      seen.add(a);
    }
    expect(seen).toEqual(new Set(v));
    expect(pickVariant(["only"], "anything")).toBe("only");
  });

  it("throws for an empty list", () => {
    expect(() => pickVariant([], "seed")).toThrow(/no variants/);
  });
});

describe("campaign routes", () => {
  it("routes require auth", async () => {
    for (const [m, p] of [["GET", "/api/campaigns"], ["POST", "/api/campaigns"], ["GET", "/api/campaigns/x"], ["PATCH", "/api/campaigns/x"], ["PUT", "/api/campaigns/x/steps/1"], ["POST", "/api/campaigns/x/run-searches"]]) {
      expect((await SELF.fetch(`https://x${p}`, { method: m, body: m === "GET" ? undefined : "{}", headers: { "content-type": "application/json" } })).status, `${m} ${p}`).toBe(401);
    }
  });

  it("POST creates with steps, GET lists and reads, unknown id is 404", async () => {
    const r = await send("POST", "/api/campaigns", NEW);
    expect(r.status).toBe(201);
    const c = await r.json<any>();
    expect(c).toMatchObject({ ...NEW, status: "testing", est_job_value_usd: null });
    expect(c.steps).toHaveLength(5);
    const list = await (await send("GET", "/api/campaigns")).json<any[]>();
    expect(list.map((x) => x.id)).toEqual([c.id]);
    const one = await (await send("GET", `/api/campaigns/${c.id}`)).json<any>();
    expect(one.steps.map((s: any) => s.idx)).toEqual([0, 1, 2, 3, 4]);
    expect((await send("GET", "/api/campaigns/nope")).status).toBe(404);
    expect((await send("PATCH", "/api/campaigns/nope", { name: "x" })).status).toBe(404);
  });

  it("POST validates name, niche, region and 1-10 non-empty towns", async () => {
    const bad: Record<string, unknown>[] = [
      { name: "" }, { niche: " " }, { region: "" }, { towns: [] }, { towns: [" "] }, { towns: Array.from({ length: 11 }, (_, i) => `Town ${i}`) },
      { towns: "Boise" }, { towns: [5] },
    ];
    for (const b of bad) {
      const r = await send("POST", "/api/campaigns", { ...NEW, ...b });
      expect(r.status, JSON.stringify(b)).toBe(400);
      const j = await r.json<any>();
      expect(j.error).toBe("invalid body");
      expect(Object.keys(j.fields).length).toBeGreaterThan(0);
    }
    expect((await api("/api/campaigns", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await listCampaigns(env.DB))).toHaveLength(0);
  });

  it("towns are deduplicated case-insensitively on create and PATCH, keeping the first spelling", async () => {
    const r = await send("POST", "/api/campaigns", { ...NEW, towns: ["Boise, ID", " boise, id", "Meridian, ID", "MERIDIAN, id"] });
    expect(r.status).toBe(201);
    const c = await r.json<any>();
    expect(c.towns).toEqual(["Boise, ID", "Meridian, ID"]);
    const p = await (await send("PATCH", `/api/campaigns/${c.id}`, { towns: ["Nampa", "nampa", "Eagle"] })).json<any>();
    expect(p.towns).toEqual(["Nampa", "Eagle"]);
    expect((await getCampaign(env.DB, c.id))!.towns).toEqual(["Nampa", "Eagle"]);
  });

  it("PATCH updates fields, accepts a nullable est_job_value_usd, and validates status and value", async () => {
    const c = await createCampaign(env.DB, NEW);
    const r = await send("PATCH", `/api/campaigns/${c.id}`, { status: "active", est_job_value_usd: 850.5, towns: ["Nampa, ID"] });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "active", est_job_value_usd: 850.5, towns: ["Nampa, ID"] });
    expect(await (await send("PATCH", `/api/campaigns/${c.id}`, { est_job_value_usd: null })).json()).toMatchObject({ est_job_value_usd: null });
    for (const b of [{ status: "paused" }, { est_job_value_usd: -1 }, { est_job_value_usd: "5" }, { towns: [] }, {}, { bogus: 1 }]) {
      expect((await send("PATCH", `/api/campaigns/${c.id}`, b)).status, JSON.stringify(b)).toBe(400);
    }
  });

  it("PUT step body rules: draft only on step 0 and never with variants, no silent reset of the draft marker", async () => {
    const c = await createCampaign(env.DB, NEW);
    const put = (idx: number, b: unknown) => send("PUT", `/api/campaigns/${c.id}/steps/${idx}`, b);
    const e = { kind: "email", offset_days: 3, offset_kind: "business", subject: "S" };
    const field = async (r: Response) => Object.keys((await r.json<any>()).fields);
    const r1 = await put(3, { ...e, variants: [], body_source: "draft" });
    expect(r1.status).toBe(400); expect(await field(r1)).toEqual(["body_source"]);
    const r2 = await put(0, { ...e, variants: ["x"] });
    expect(r2.status).toBe(400); expect(await field(r2)).toEqual(["variants"]);
    const r3 = await put(0, { ...e, variants: [], body_source: "variants" });
    expect(r3.status).toBe(400); expect(await field(r3)).toEqual(["body_source"]);
    const r4 = await put(0, { ...e, variants: ["x"], body_source: "draft" });
    expect(r4.status).toBe(400);
    expect((await put(1, { ...e, variants: [] })).status).toBe(400);
    expect((await put(4, { ...e, kind: "checkin", variants: [] })).status).toBe(400);
    expect((await listSteps(env.DB, c.id))[0]).toMatchObject({ body_source: "draft", variants: [], offset_days: 0 });
    // Editing step 0's offset or subject, with or without body_source, keeps it a draft step.
    const ok = await put(0, { ...e, offset_days: 2, variants: [] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ offset_days: 2, body_source: "draft", variants: [] });
    expect((await put(0, { ...e, offset_days: 1, subject: "Edited", variants: [], body_source: "draft" })).status).toBe(200);
    expect((await listSteps(env.DB, c.id))[0]).toMatchObject({ offset_days: 1, subject: "Edited", body_source: "draft" });
  });

  it("PUT step saves kind, offset, subject and variants, and validates", async () => {
    const c = await createCampaign(env.DB, NEW);
    const ok = { kind: "email", offset_days: 6, offset_kind: "business", subject: "Re: {Business}", variants: ["A {Name}", "B {Name}", "C {Name}"] };
    const r = await send("PUT", `/api/campaigns/${c.id}/steps/1`, ok);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ idx: 1, ...ok });
    expect((await listSteps(env.DB, c.id))[1]).toMatchObject({ offset_days: 6, variants: ok.variants });
    const bad: Record<string, unknown>[] = [
      { kind: "sms" }, { offset_kind: "weekly" }, { offset_days: -1 }, { offset_days: 1.5 }, { offset_days: 400 },
      { subject: "x".repeat(201) }, { variants: [] }, { variants: ["a", " "] }, { variants: ["x".repeat(3001)] },
      { variants: ["1", "2", "3", "4", "5", "6"] }, { variants: "text" },
    ];
    for (const b of bad) expect((await send("PUT", `/api/campaigns/${c.id}/steps/1`, { ...ok, ...b })).status, JSON.stringify(b).slice(0, 60)).toBe(400);
    expect((await send("PUT", `/api/campaigns/${c.id}/steps/9`, ok)).status).toBe(404);
    expect((await send("PUT", `/api/campaigns/${c.id}/steps/abc`, ok)).status).toBe(400);
    expect((await send("PUT", `/api/campaigns/nope/steps/1`, ok)).status).toBe(404);
    // The call step has no body, and Email 1 keeps coming from the lead's draft.
    expect((await send("PUT", `/api/campaigns/${c.id}/steps/2`, { kind: "call", offset_days: 8, offset_kind: "calendar", subject: "", variants: [] })).status).toBe(200);
    expect((await send("PUT", `/api/campaigns/${c.id}/steps/0`, { kind: "email", offset_days: 0, offset_kind: "business", subject: "", variants: [], body_source: "draft" })).status).toBe(200);
    expect((await listSteps(env.DB, c.id))[0].body_source).toBe("draft");
  });
});

describe("startSearchRun campaignId", () => {
  it("stores campaignId when given and leaves campaign_id null otherwise", async () => {
    const input = { location: "Boise", businessType: "plumber" };
    const a = await startSearchRun({ db: env.DB, startWorkflow: async () => {} }, input, { campaignId: "camp-1" });
    const b = await startSearchRun({ db: env.DB, startWorkflow: async () => {} }, input, { newOnly: true });
    expect(a.ok && a.search.campaign_id).toBe("camp-1");
    expect(b.ok && b.search.campaign_id).toBeNull();
  });
});

describe("POST /api/campaigns/:id/run-searches", () => {
  it("run-searches starts one search per town tagged with the campaign", async () => {
    const c = await createCampaign(env.DB, { ...NEW, towns: ["Boise, ID", "Meridian, ID", "Nampa"] });
    const r = await send("POST", `/api/campaigns/${c.id}/run-searches`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ started: 3, blocked: [] });
    expect(created).toHaveLength(3);
    const rows = await searchRows();
    expect(rows.map((s) => s.location).sort()).toEqual(["Boise, ID", "Meridian, ID", "Nampa"]);
    for (const s of rows) expect(s).toMatchObject({ campaign_id: c.id, business_type: "plumber", status: "running", radius_km: 15, max_results: 50, new_only: 0 });
  });

  it("run-searches reports a spend-blocked town", async () => {
    const est = estimateSearchCost(50);
    await saveSettings(env.DB, { monthly_spend_limit_usd: est * 1.5 }); // room for one search, not two
    const c = await createCampaign(env.DB, NEW);
    const j = await (await send("POST", `/api/campaigns/${c.id}/run-searches`)).json<any>();
    expect(j.started).toBe(1);
    expect(j.blocked).toEqual([{ town: "Meridian, ID", reason: expect.stringMatching(/^Spend limit: \$0\.00 spent of \$/) }]);
    const rows = await searchRows();
    expect(rows.filter((s) => s.status === "running").map((s) => s.location)).toEqual(["Boise, ID"]);
    expect(rows.every((s) => s.campaign_id === c.id)).toBe(true);
  });

  it("a workflow that fails to start blocks only that town", async () => {
    const c = await createCampaign(env.DB, { ...NEW, towns: ["Boise, ID"] });
    failTown = "workflow down";
    expect(await (await send("POST", `/api/campaigns/${c.id}/run-searches`)).json()).toEqual({ started: 0, blocked: [{ town: "Boise, ID", reason: "workflow down" }] });
  });

  it("404 for an unknown campaign, 409 for an archived one", async () => {
    expect((await send("POST", "/api/campaigns/nope/run-searches")).status).toBe(404);
    const c = await createCampaign(env.DB, NEW);
    await updateCampaign(env.DB, c.id, { status: "archived" });
    expect((await send("POST", `/api/campaigns/${c.id}/run-searches`)).status).toBe(409);
    expect(await searchRows()).toHaveLength(0);
  });
});
