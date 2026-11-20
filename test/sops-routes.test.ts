import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTemplate, listTemplates } from "../src/worker/db/sops";
import { SEED_SOPS } from "../src/worker/sop/seeds";
import type { SopStep, SopTemplateInput } from "../src/worker/sop/model";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
});

const owner = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" } });
const json = async (method: string, path: string, body?: unknown) => { const r = await owner(method, path, body); return { status: r.status, body: await r.json<any>() }; };

const step = (key: string, position: number, o: Partial<SopStep> = {}): SopStep => ({
  key, phaseKey: "p1", phaseTitle: "Phase one", position, title: `Step ${key}`, owner: "logan", estMinutes: 10, doneWhen: "It is done.", docTemplate: null, emailTemplate: null,
  requires: [], milestone: null, clientSummary: null, skippable: false, ...o,
});
const template = (o: Partial<SopTemplateInput> = {}): SopTemplateInput => ({
  key: "MINE", name: "My checklist", kind: "project", cadence: null, cadenceDay: null, appliesTo: [], active: true, steps: [step("a", 1), step("b", 2, { requires: ["a"] })], ...o,
});

describe("SOP routes", () => {
  it("every route is 401 without a session", async () => {
    const calls: [string, string, unknown?][] = [["GET", "/sops"], ["GET", "/sops/BUILD"], ["PUT", "/sops/MINE", template()], ["POST", "/sops/BUILD/active", { active: false }]];
    for (const [m, p, b] of calls) expect((await owner(m, p, b, false)).status, `${m} ${p}`).toBe(401);
  });

  it("GET /sops seeds on first call and a second call adds nothing", async () => {
    expect(await listTemplates(env.DB, { includeInactive: true })).toEqual([]);
    const first = await json("GET", "/sops");
    expect(first.status).toBe(200);
    expect(first.body.templates.map((t: any) => t.key)).toEqual(SEED_SOPS.map((t) => t.key));
    expect(first.body.templates[0].steps.length).toBeGreaterThan(5);
    const count = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM sop_templates`).first<{ n: number }>())!.n;
    expect(await count()).toBe(SEED_SOPS.length);
    const stepsBefore = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM sop_template_steps`).first<{ n: number }>())!.n;
    const second = await json("GET", "/sops");
    expect(second.body.templates).toEqual(first.body.templates);
    expect(await count()).toBe(SEED_SOPS.length);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM sop_template_steps`).first<{ n: number }>())!.n).toBe(stepsBefore);
  });

  it("lists inactive templates too, so the editor can turn them on again", async () => {
    await json("GET", "/sops");
    expect((await json("POST", "/sops/CARE-4/active", { active: false })).body.template.active).toBe(false);
    const list = await json("GET", "/sops");
    expect(list.body.templates.find((t: any) => t.key === "CARE-4").active).toBe(false);
  });

  it("GET /sops/:key returns one template, 404 for an unknown key", async () => {
    await json("GET", "/sops");
    const r = await json("GET", "/sops/BUILD");
    expect(r.status).toBe(200);
    expect(r.body.template).toMatchObject({ key: "BUILD", version: 1 });
    expect((await json("GET", "/sops/NOPE")).status).toBe(404);
  });

  it("PUT saves a new template at version 1 and an existing one as the next version", async () => {
    const made = await json("PUT", "/sops/MINE", template());
    expect(made.status).toBe(201);
    expect(made.body.template).toMatchObject({ key: "MINE", version: 1, name: "My checklist" });
    expect(made.body.template.steps.map((s: any) => s.key)).toEqual(["a", "b"]);
    const edited = await json("PUT", "/sops/MINE", template({ name: "Renamed", steps: [step("a", 1)] }));
    expect(edited.status).toBe(200);
    expect(edited.body.template).toMatchObject({ version: 2, name: "Renamed" });
    expect((await getTemplate(env.DB, "MINE"))!.steps).toHaveLength(1);
  });

  it("editing a seed template saves the next version and the seed text is not put back by a later read", async () => {
    await json("GET", "/sops");
    const seed = (await json("GET", "/sops/CARE-1")).body.template;
    const edited = await json("PUT", "/sops/CARE-1", { ...seed, name: "My own Care check-in", id: undefined, version: undefined, updatedAt: undefined });
    expect(edited.status).toBe(200);
    expect(edited.body.template).toMatchObject({ key: "CARE-1", name: "My own Care check-in", version: seed.version + 1 });
    expect((await json("GET", "/sops/CARE-1")).body.template.name).toBe("My own Care check-in");
  });

  it("PUT with a key that differs from the path is 400", async () => {
    const r = await json("PUT", "/sops/OTHER", template());
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/key/i);
    expect(await getTemplate(env.DB, "OTHER")).toBeNull();
    expect(await getTemplate(env.DB, "MINE")).toBeNull();
  });

  it("PUT with a requires cycle is 400 with the problem sentence", async () => {
    const r = await json("PUT", "/sops/MINE", template({ steps: [step("a", 1, { requires: ["b"] }), step("b", 2, { requires: ["a"] })] }));
    expect(r.status).toBe(400);
    expect(r.body.problems).toEqual([expect.stringMatching(/wait on each other in a loop: a → b → a|wait on each other in a loop: b → a → b/)]);
    expect(r.body.error).toContain("loop");
    expect(await getTemplate(env.DB, "MINE")).toBeNull();
  });

  it("PUT with a step that requires one that does not exist, two milestones, or a bad cadence is 400 with every problem", async () => {
    const r = await json("PUT", "/sops/MINE", template({ steps: [step("a", 1, { requires: ["zzz"], milestone: "design_approved" }), step("b", 2, { milestone: "design_approved" })] }));
    expect(r.status).toBe(400);
    expect(r.body.problems.join(" ")).toMatch(/zzz/);
    expect(r.body.problems.join(" ")).toMatch(/more than one step/);
    const weekly = await json("PUT", "/sops/MINE", template({ kind: "recurring", cadence: "weekly", cadenceDay: 9 }));
    expect(weekly.status).toBe(400);
    expect(weekly.body.problems.join(" ")).toMatch(/weekday/);
  });

  it("PUT with a body of the wrong shape is 400 and never a 500", async () => {
    expect((await json("PUT", "/sops/MINE", { key: "MINE" })).status).toBe(400);
    expect((await json("PUT", "/sops/MINE", template({ name: "" }))).status).toBe(400);
    expect((await json("PUT", "/sops/MINE", template({ steps: Array.from({ length: 121 }, (_, i) => step(`s${i}`, i + 1)) }))).status).toBe(400);
    expect((await owner("PUT", "/sops/MINE", undefined)).status).toBe(400);
    const bad = await owner("PUT", "/sops/MINE");
    expect(bad.status).toBe(400);
    expect(await getTemplate(env.DB, "MINE")).toBeNull();
  });

  it("POST /sops/:key/active turns a template off and on, and 404s for an unknown key", async () => {
    await json("GET", "/sops");
    const off = await json("POST", "/sops/BUILD/active", { active: false });
    expect(off.body.template).toMatchObject({ key: "BUILD", active: false });
    expect((await getTemplate(env.DB, "BUILD"))!.active).toBe(false);
    expect((await json("POST", "/sops/BUILD/active", { active: true })).body.template.active).toBe(true);
    expect((await json("POST", "/sops/NOPE/active", { active: true })).status).toBe(404);
    expect((await json("POST", "/sops/BUILD/active", {})).status).toBe(400);
    expect((await json("POST", "/sops/BUILD/active", { active: "yes" })).status).toBe(400);
  });
});
