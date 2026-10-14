import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { regenerateDraft, type LeadDeps } from "../src/worker/pipeline/lead";
import { latestDraft, listDrafts, selectDraft, variantsOf } from "../src/worker/db/drafts";
import { createWorkSample } from "../src/worker/db/workSamples";
import { saveSettings } from "../src/worker/db/settings";
import { seedBusiness, seedLeadAudit } from "./fixtures/cro";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const send = (path: string, method: string, body: unknown) => api(path, { method, body: JSON.stringify(body) });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

beforeEach(async () => { await env.DB.prepare(`DELETE FROM work_samples`).run(); });

const three = (tag = "") => ({
  variants: [1, 2, 3].map((n) => ({ angle: `Angle ${n}`, subject: `Subject ${n}${tag}`, body: `Body ${n}${tag}` })),
  to_contact_id: null, recipient_reason: "r",
});
function leadDeps(reply: (p: { system: string; user: string }) => unknown, seen: { system: string; user: string }[] = []): LeadDeps {
  return { db: env.DB, raw: env.RAW, pagespeedKey: "K", fetch: async () => new Response(""), now: () => new Date(),
    claude: async (p: { system: string; user: string }) => { seen.push(p); return reply(p); } } as unknown as LeadDeps;
}
async function lead() {
  const b = await seedBusiness();
  await seedLeadAudit(b.id);
  return b;
}

describe("writing a draft for a purpose", () => {
  it("full-time: stores every variant in one group, first one current, footer off", async () => {
    const b = await lead();
    await saveSettings(env.DB, { default_purpose: "full_time" });
    const d = await regenerateDraft(leadDeps(() => three()), b.id);
    expect([d.purpose, d.include_footer, d.angle, d.subject, d.variant_index]).toEqual(["full_time", false, "Angle 1", "Subject 1", 0]);
    const current = (await latestDraft(env.DB, b.id))!;
    expect(current.id).toBe(d.id);
    const group = await variantsOf(env.DB, current);
    expect(group.map((v) => [v.variant_index, v.angle, v.purpose, v.include_footer])).toEqual([
      [0, "Angle 1", "full_time", false], [1, "Angle 2", "full_time", false], [2, "Angle 3", "full_time", false]]);
    expect(new Set(group.map((v) => v.variant_group)).size).toBe(1);
    expect(new Set(group.map((v) => v.created_at)).size).toBe(1);
  });

  it("freelance: footer on, and the full-time work samples stay out of the prompt", async () => {
    const b = await lead();
    await createWorkSample(env.DB, { title: "Secret Sample", url: "https://logan.dev/secret", result_line: "", tags: "" });
    const seen: { system: string; user: string }[] = [];
    const d = await regenerateDraft(leadDeps(() => three(), seen), b.id, { purpose: "freelance" });
    expect([d.purpose, d.include_footer]).toEqual(["freelance", true]);
    expect(seen[0].system).toContain("mini proposal");
    expect(seen[0].user).not.toContain("Secret Sample");
  });

  it("uses the account's default purpose when none is given", async () => {
    const b = await lead();
    await saveSettings(env.DB, { default_purpose: "freelance" });
    expect((await regenerateDraft(leadDeps(() => three()), b.id)).purpose).toBe("freelance");
    await saveSettings(env.DB, { default_purpose: "full_time" });
    expect((await regenerateDraft(leadDeps(() => three()), b.id)).purpose).toBe("full_time");
  });

  it("full-time cites only the work samples that fit, and a pick overrides the match", async () => {
    const b = await lead();
    await createWorkSample(env.DB, { title: "Alpha Build", url: "https://logan.dev/alpha", result_line: "Did a thing", tags: "zzzz" });
    const z = await createWorkSample(env.DB, { title: "Zeta Build", url: "https://logan.dev/zeta", result_line: "", tags: "yyyy" });
    const seen: { system: string; user: string }[] = [];
    await regenerateDraft(leadDeps(() => three(), seen), b.id, { purpose: "full_time", sampleIds: [z.id] });
    expect(seen[0].user).toContain("https://logan.dev/zeta");
    expect(seen[0].user).not.toContain("https://logan.dev/alpha");
  });
});

describe("tweaking the current draft", () => {
  it("rewrites it with one instruction, keeps purpose and footer choice, and writes one new draft", async () => {
    const b = await lead();
    await regenerateDraft(leadDeps(() => three()), b.id, { purpose: "full_time" });
    const before = (await listDrafts(env.DB, b.id)).length;
    const seen: { system: string; user: string }[] = [];
    const d = await regenerateDraft(leadDeps(() => ({ variants: [{ angle: "Shorter", subject: "Tight", body: "Short body" }], to_contact_id: null, recipient_reason: "r" }), seen), b.id, { tweak: "shorter" });
    expect(seen[0].user).toContain("Current draft to revise:");
    expect(seen[0].user).toContain("Subject: Subject 1");
    expect(seen[0].user).toContain("cut it by about a third");
    expect(seen[0].system).toMatch(/exactly 1 variant/);
    expect([d.purpose, d.include_footer, d.subject]).toEqual(["full_time", false, "Tight"]);
    expect((await listDrafts(env.DB, b.id)).length).toBe(before + 1);
    expect((await latestDraft(env.DB, b.id))!.id).toBe(d.id);
  });

  it("refuses to tweak when there is no draft yet", async () => {
    const b = await lead();
    await expect(regenerateDraft(leadDeps(() => three()), b.id, { tweak: "warmer" })).rejects.toThrow(/Write a draft first/);
  });

  it("swap_samples sets aside the samples the current draft already links", async () => {
    const b = await lead();
    await createWorkSample(env.DB, { title: "First Work", url: "https://logan.dev/first", result_line: "", tags: "" });
    await createWorkSample(env.DB, { title: "Second Work", url: "https://logan.dev/second", result_line: "", tags: "" });
    await regenerateDraft(leadDeps(() => ({ variants: [{ angle: "a", subject: "s", body: "See https://logan.dev/first for more" }], to_contact_id: null, recipient_reason: "r" })), b.id, { purpose: "full_time" });
    const seen: { system: string; user: string }[] = [];
    await regenerateDraft(leadDeps(() => ({ variants: [{ angle: "a", subject: "s", body: "b" }], to_contact_id: null, recipient_reason: "r" }), seen), b.id, { tweak: "swap_samples" });
    const listed = seen[0].user.split("Work samples you may cite (only these):")[1].split("Contacts:")[0];
    expect(listed).not.toContain("https://logan.dev/first");
    expect(listed).toContain("https://logan.dev/second");
  });
});

describe("picking a variant", () => {
  it("makes it the current draft while the group keeps its order", async () => {
    const b = await lead();
    const first = await regenerateDraft(leadDeps(() => three()), b.id);
    const group = await variantsOf(env.DB, first);
    const picked = await selectDraft(env.DB, b.id, group[2].id, new Date(Date.now() + 5000));
    expect(picked!.id).toBe(group[2].id);
    expect((await latestDraft(env.DB, b.id))!.id).toBe(group[2].id);
    expect((await variantsOf(env.DB, picked!)).map((v) => v.id)).toEqual(group.map((v) => v.id));
  });

  it("will not select a draft that belongs to another lead", async () => {
    const mine = await lead();
    const other = await lead();
    const d = await regenerateDraft(leadDeps(() => three()), other.id);
    expect(await selectDraft(env.DB, mine.id, d.id)).toBeNull();
  });
});

describe("draft routes", () => {
  it("lead detail returns the variants, select switches the current one, patch toggles the footer", async () => {
    const b = await lead();
    const first = await regenerateDraft(leadDeps(() => three()), b.id);
    const group = await variantsOf(env.DB, first);

    const detail = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(detail.draft.id).toBe(first.id);
    expect(detail.variants.map((v: any) => v.id)).toEqual(group.map((v) => v.id));

    const sel = await send(`/api/leads/${b.id}/draft/select`, "POST", { draftId: group[1].id });
    expect(sel.status).toBe(200);
    expect((await sel.json<any>()).id).toBe(group[1].id);
    expect((await (await api(`/api/leads/${b.id}`)).json<any>()).draft.id).toBe(group[1].id);
    expect((await send(`/api/leads/${b.id}/draft/select`, "POST", { draftId: "nope" })).status).toBe(404);
    expect((await send(`/api/leads/${b.id}/draft/select`, "POST", {})).status).toBe(400);

    expect((await send(`/api/leads/${b.id}/draft`, "PATCH", { subject: "Edited", body: "Edited body", include_footer: true })).status).toBe(200);
    const after = (await latestDraft(env.DB, b.id))!;
    expect([after.subject, after.body, after.include_footer, after.edited]).toEqual(["Edited", "Edited body", true, true]);
    // Omitting the flag leaves the choice alone.
    await send(`/api/leads/${b.id}/draft`, "PATCH", { subject: "Edited 2", body: "Edited body 2" });
    expect((await latestDraft(env.DB, b.id))!.include_footer).toBe(true);
  });

  it("previews the composed email without saving anything", async () => {
    await saveSettings(env.DB, { signature: "Logan\nIrish Web", physical_address: "1 Main St", opt_out_line: "Reply stop." });
    const b = await lead();
    await regenerateDraft(leadDeps(() => three()), b.id);
    const before = (await latestDraft(env.DB, b.id))!;
    const r = await send(`/api/leads/${b.id}/draft/preview`, "POST", { subject: "Hi", body: "Hello there", include_footer: true });
    const e = await r.json<any>();
    expect(e.text).toBe("Hello there\n\nLogan\nIrish Web\n\n1 Main St\nReply stop.");
    expect(e.html).toContain("Hello there");
    expect((await (await send(`/api/leads/${b.id}/draft/preview`, "POST", { subject: "Hi", body: "Hello there", include_footer: false })).json<any>()).text).toBe("Hello there\n\nLogan\nIrish Web");
    expect((await send(`/api/leads/${b.id}/draft/preview`, "POST", { subject: "", body: "x" })).status).toBe(400);
    expect((await latestDraft(env.DB, b.id))!.body).toBe(before.body);
  });

  it("rejects an unknown purpose or tweak on regenerate", async () => {
    const b = await lead();
    expect((await send(`/api/leads/${b.id}/regenerate`, "POST", { purpose: "spam" })).status).toBe(400);
    expect((await send(`/api/leads/${b.id}/regenerate`, "POST", { tweak: "louder" })).status).toBe(400);
  });
});

describe("work sample routes", () => {
  it("creates, lists, updates and deletes samples", async () => {
    const created = await send("/api/work-samples", "POST", { title: "  Acme redesign ", url: "https://logan.dev/acme", result_line: "+40% leads", tags: "dental" });
    expect(created.status).toBe(201);
    const s = await created.json<any>();
    expect(s).toMatchObject({ title: "Acme redesign", url: "https://logan.dev/acme", result_line: "+40% leads", tags: "dental" });
    expect((await (await api("/api/work-samples")).json<any[]>()).some((x) => x.id === s.id)).toBe(true);
    const up = await send(`/api/work-samples/${s.id}`, "PUT", { result_line: "+55% leads" });
    expect((await up.json<any>()).result_line).toBe("+55% leads");
    expect((await api(`/api/work-samples/${s.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/api/work-samples/${s.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await send(`/api/work-samples/${s.id}`, "PUT", { title: "x" })).status).toBe(404);
  });

  it("only accepts https links and a title", async () => {
    for (const bad of [{ title: "x", url: "http://logan.dev" }, { title: "x", url: "javascript:alert(1)" }, { title: "", url: "https://logan.dev" }, { title: "x", url: "logan.dev" }]) {
      expect((await send("/api/work-samples", "POST", bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("keeps at most 20 samples", async () => {
    const have = (await (await api("/api/work-samples")).json<any[]>()).length;
    for (let i = have; i < 20; i++) expect((await send("/api/work-samples", "POST", { title: `S${i}`, url: `https://logan.dev/${i}` })).status).toBe(201);
    const over = await send("/api/work-samples", "POST", { title: "one too many", url: "https://logan.dev/over" });
    expect(over.status).toBe(400);
    expect((await over.json<any>()).error).toMatch(/20/);
  });
});

describe("profile and signature settings", () => {
  const put = (body: unknown) => send("/api/settings", "PUT", body);

  it("saves the profile fields", async () => {
    const r = await put({ role_title: "Front-end developer", bio: "I build things.", availability: "January", goal_line: "A full-time role", resume_url: "https://logan.dev/resume.pdf", default_purpose: "freelance" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ role_title: "Front-end developer", resume_url: "https://logan.dev/resume.pdf", default_purpose: "freelance" });
    await put({ default_purpose: "full_time" });
  });

  it("rejects a bad purpose or resume link", async () => {
    expect((await put({ default_purpose: "spam" })).status).toBe(400);
    expect((await put({ resume_url: "javascript:alert(1)" })).status).toBe(400);
    expect((await put({ resume_url: "" })).status).toBe(200);
  });

  it("stores the signature cleaned up, and clears it with an empty value", async () => {
    const r = await put({ signature_json: JSON.stringify({ name: "Logan", website: "logan.dev", image_url: "https://logan.dev/l.png", links: [{ label: "GitHub", url: "github.com/logan" }], image_width: 9999 }) });
    expect(r.status).toBe(200);
    const stored = JSON.parse((await r.json<any>()).signature_json);
    expect(stored).toMatchObject({ name: "Logan", website: "https://logan.dev/", image_width: 300, links: [{ label: "GitHub", url: "https://github.com/logan" }] });
    const cleared = await put({ signature_json: "" });
    expect((await cleared.json<any>()).signature_json).toBe("");
  });

  it("previews a signature without saving it, leaving out anything unsafe", async () => {
    await put({ signature_json: "" });
    const r = await send("/api/settings/signature-preview", "POST", { signature_json: JSON.stringify({ name: "Logan", image_url: "http://logan.dev/l.png", links: [{ label: "x", url: "javascript:alert(1)" }, { label: "Site", url: "https://logan.dev" }] }) });
    const p = await r.json<any>();
    expect(p.html).toContain("Logan");
    expect(p.html).toContain("https://logan.dev/");
    expect(p.html).not.toContain("<img");
    expect(p.html).not.toContain("javascript");
    expect(p.text).toBe("Logan\nSite: https://logan.dev/");
    expect(await (await send("/api/settings/signature-preview", "POST", { signature_json: "" })).json()).toEqual({ html: "", text: "" });
    expect((await (await api("/api/settings")).json<any>()).settings.signature_json).toBe("");
  });

  it("refuses a signature link or image it would have to drop", async () => {
    for (const bad of [{ name: "L", image_url: "http://logan.dev/l.png" }, { name: "L", links: [{ label: "x", url: "javascript:alert(1)" }] }, { name: "L", website: "not a url" }]) {
      const r = await put({ signature_json: JSON.stringify(bad) });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect((await r.json<any>()).fields).toContain("signature_json");
    }
    expect((await put({ signature_json: "{broken" })).status).toBe(400);
  });
});
