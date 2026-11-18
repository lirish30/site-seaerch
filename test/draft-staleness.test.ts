import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { regenerateDraft, type LeadDeps } from "../src/worker/pipeline/lead";
import { applySync, citedRole } from "../src/worker/db/jobs";
import { latestDraft } from "../src/worker/db/drafts";
import { saveSettings } from "../src/worker/db/settings";
import { buildToday } from "../src/worker/today";
import { seedBusiness, seedLeadAudit } from "./fixtures/cro";
import type { RoleKind } from "../src/worker/types";

let cookie = "";
const api = (path: string, init: RequestInit = {}) => SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const role = (id: string, title: string, kind: RoleKind = "seo") => ({ external_id: id, title, url: `https://boards.example/${id}`, location: null, department: null, role_kind: kind, posted_at: null });
type Seen = { system: string; user: string }[];
/** Writes three variants; `say` is put in each body so a test can decide whether the model named the role. */
function deps(seen: Seen, say = ""): LeadDeps {
  const out = { variants: [1, 2, 3].map((n) => ({ angle: `A${n}`, subject: `S${n}`, body: `${say} B${n}` })), to_contact_id: null, recipient_reason: "r" };
  return { db: env.DB, raw: env.RAW, pagespeedKey: "K", fetch: async () => new Response(""), now: () => new Date(),
    claude: async (p: { system: string; user: string }) => { seen.push(p); return out; } } as unknown as LeadDeps;
}
async function lead() { const b = await seedBusiness(); await seedLeadAudit(b.id); return b; }
const close = (businessId: string, at = new Date().toISOString()) => env.DB.prepare(`UPDATE job_postings SET closed_at = ? WHERE business_id = ?`).bind(at, businessId).run();

beforeEach(async () => {
  for (const t of ["job_postings", "drafts"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await saveSettings(env.DB, { default_purpose: "full_time", role_kind_order: "web_dev,cro,seo,design,marketing" });
});

describe("the draft remembers the role it cites", () => {
  it("stores the posting id when the text names the role, and nothing when it does not", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [role("1", "Growth SEO Lead")], hoursAgo(1), false);
    const posting = (await env.DB.prepare(`SELECT id FROM job_postings WHERE business_id = ?`).bind(b.id).first<{ id: string }>())!.id;
    await regenerateDraft(deps([], "I saw you are hiring for the Growth SEO Lead role."), b.id);
    expect((await latestDraft(env.DB, b.id))!.posting_id).toBe(posting);
    await regenerateDraft(deps([], "Hello there."), b.id);
    expect((await latestDraft(env.DB, b.id))!.posting_id).toBeNull();
  });

  it("a fresh draft cites the ranked pick, not the newest role: a growth-equity false positive loses to a developer role", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [role("1", "WordPress Developer", "web_dev"), role("2", "Growth Equity Analyst", "marketing")], hoursAgo(1), false);
    const seen: Seen = [];
    await regenerateDraft(deps(seen), b.id);
    expect(seen[0].user).toContain("WordPress Developer");
    expect(seen[0].user).not.toContain("Growth Equity Analyst");
  });

  it("deleting the sentence from the saved draft ends the claim", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [role("1", "Growth SEO Lead")], hoursAgo(1), false);
    await regenerateDraft(deps([], "I saw you are hiring for the Growth SEO Lead role."), b.id);
    const d = (await latestDraft(env.DB, b.id))!;
    const patch = (body: string) => api(`/api/leads/${b.id}/draft`, { method: "PATCH", body: JSON.stringify({ subject: d.subject, body }) });
    await patch(`${d.body} Edited, role still named: growth seo lead.`);
    expect((await latestDraft(env.DB, b.id))!.posting_id).toBe(d.posting_id);
    await patch("Edited and the sentence is gone.");
    expect((await latestDraft(env.DB, b.id))!.posting_id).toBeNull();
  });
});

describe("rewrites and closed roles", () => {
  const named = "I saw you are hiring for the Growth SEO Lead role.";

  it("a rewrite of a draft whose role has closed is told to drop the claim, is not handed the role, and ends with no claim", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [role("1", "Growth SEO Lead")], hoursAgo(5), false);
    await regenerateDraft(deps([], named), b.id);
    await close(b.id);
    const seen: Seen = [];
    await regenerateDraft(deps(seen, "Short note."), b.id, { tweak: "shorter" });
    expect(seen[0].user).toMatch(/no longer open: remove that claim/);
    expect(seen[0].user).not.toContain("Open role on their own job board");
    expect((await latestDraft(env.DB, b.id))!.posting_id).toBeNull();
  });

  it("keeps the claim flagged if the model still names the closed role after the rewrite", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [role("1", "Growth SEO Lead")], hoursAgo(5), false);
    await regenerateDraft(deps([], named), b.id);
    await close(b.id);
    await regenerateDraft(deps([], named), b.id, { tweak: "warmer" });
    const d = (await latestDraft(env.DB, b.id))!;
    expect((await citedRole(env.DB, d, Date.now()))?.state).toBe("closed");
  });

  it("a rewrite also drops a role the board has stopped showing (open on paper, unseen for 3 days)", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [role("1", "Growth SEO Lead")], hoursAgo(1), false);
    await regenerateDraft(deps([], named), b.id);
    await env.DB.prepare(`UPDATE job_postings SET last_seen_at = ? WHERE business_id = ?`).bind(hoursAgo(72), b.id).run();
    const seen: Seen = [];
    await regenerateDraft(deps(seen, "x"), b.id, { tweak: "shorter" });
    expect(seen[0].user).toMatch(/remove that claim/);
  });

  it("a rewrite of a draft whose role is still open keeps it and adds no drop instruction", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [role("1", "Growth SEO Lead")], hoursAgo(1), false);
    await regenerateDraft(deps([], named), b.id);
    const seen: Seen = [];
    await regenerateDraft(deps(seen, named), b.id, { tweak: "shorter" });
    expect(seen[0].user).toContain("Growth SEO Lead");
    expect(seen[0].user).not.toMatch(/remove that claim/);
    expect((await latestDraft(env.DB, b.id))!.posting_id).not.toBeNull();
  });

  it("usePosting false on a rewrite drops the claim even though the role is open", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [role("1", "Growth SEO Lead")], hoursAgo(1), false);
    await regenerateDraft(deps([], named), b.id);
    const seen: Seen = [];
    await regenerateDraft(deps(seen, "x"), b.id, { tweak: "shorter", usePosting: false });
    expect(seen[0].user).toMatch(/remove that claim/);
    expect(seen[0].user).not.toContain("Open role on their own job board");
  });

  it("a rewrite of a draft that claimed nothing adds nothing and says nothing about dropping", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [role("1", "Growth SEO Lead")], hoursAgo(1), false);
    await regenerateDraft(deps([], "Hello."), b.id);
    const seen: Seen = [];
    await regenerateDraft(deps(seen, "Hello."), b.id, { tweak: "shorter" });
    expect(seen[0].user).not.toContain("Growth SEO Lead");
    expect(seen[0].user).not.toMatch(/remove that claim/);
  });
});

describe("export and the composer endpoint", () => {
  async function citing() {
    const b = await lead();
    await applySync(env.DB, b.id, [role("1", "Growth SEO Lead")], hoursAgo(1), false);
    await regenerateDraft(deps([], "I saw you are hiring for the Growth SEO Lead role."), b.id);
    return b;
  }
  const gmail = (id: string, body: object = {}) => api(`/api/leads/${id}/gmail-draft`, { method: "POST", body: JSON.stringify(body) });

  it("blocks the Gmail export with a 409 when the cited role has closed, and the Drive export too", async () => {
    const b = await citing();
    await close(b.id);
    const r = await gmail(b.id);
    const body = await r.json<any>();
    expect([r.status, body.code]).toEqual([409, "stale_role"]);
    expect(body.error).toMatch(/"Growth SEO Lead".*has closed/);
    expect((await api(`/api/leads/${b.id}/drive`, { method: "POST", body: "{}" })).status).toBe(409);
  });

  it("blocks when the role is open on paper but the board has not shown it for 48 hours", async () => {
    const b = await citing();
    await env.DB.prepare(`UPDATE job_postings SET last_seen_at = ? WHERE business_id = ?`).bind(hoursAgo(49), b.id).run();
    const body = await (await gmail(b.id)).json<any>();
    expect(body.code).toBe("stale_role");
    expect(body.error).toMatch(/may be closed/);
  });

  it("lets the owner export anyway with allowStaleRole (it then proceeds to the Google step)", async () => {
    const b = await citing();
    await close(b.id);
    const r = await gmail(b.id, { allowStaleRole: true });
    expect(r.status).toBe(400); // no Google account connected in tests
    expect((await r.json<any>()).error).toMatch(/Connect your Google account/);
  });

  it("does not block while the role is still open, or when the draft cites nothing", async () => {
    const b = await citing();
    expect((await gmail(b.id)).status).toBe(400);
    await regenerateDraft(deps([], "Hello."), b.id);
    await close(b.id);
    expect((await gmail(b.id)).status).toBe(400);
  });

  it("GET draft-role reports the cited role with its warning, and the role a new draft would cite", async () => {
    const b = await citing();
    const ok = await (await api(`/api/leads/${b.id}/draft-role`)).json<any>();
    expect([ok.cited.title, ok.cited.state, ok.cited.warning, ok.next.title]).toEqual(["Growth SEO Lead", "open", null, "Growth SEO Lead"]);
    await close(b.id);
    const gone = await (await api(`/api/leads/${b.id}/draft-role`)).json<any>();
    expect([gone.cited.state, gone.cited.warning, gone.next]).toEqual(["closed", expect.stringContaining("has closed"), null]);
  });

  it("GET draft-role is empty for a lead with no draft and no role", async () => {
    const b = await seedBusiness();
    expect(await (await api(`/api/leads/${b.id}/draft-role`)).json()).toEqual({ cited: null, next: null });
  });
});

describe("Today draft_unsent", () => {
  it("says when the role the unsent draft names has closed", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [role("1", "Growth SEO Lead")], hoursAgo(1), false);
    await regenerateDraft(deps([], "I saw you are hiring for the Growth SEO Lead role."), b.id);
    await env.DB.prepare(`UPDATE drafts SET created_at = ? WHERE business_id = ?`).bind(hoursAgo(72), b.id).run();
    await env.DB.prepare(`UPDATE job_postings SET last_seen_at = ? WHERE business_id = ?`).bind(hoursAgo(80), b.id).run();
    const item = (now: Date) => buildToday(env.DB, now).then((xs) => xs.find((i) => i.kind === "draft_unsent" && i.businessId === b.id));
    // Role is open on paper but was last seen 80 hours ago.
    expect((await item(new Date()))?.reason).toMatch(/never exported\. The role it mentions has not shown on their board in 2 days$/);
    await close(b.id);
    expect((await item(new Date()))?.reason).toMatch(/never exported\. The role it mentions has closed$/);
  });

  it("is unchanged for a draft that cites no role", async () => {
    const b = await lead();
    await regenerateDraft(deps([], "Hello."), b.id);
    await env.DB.prepare(`UPDATE drafts SET created_at = ? WHERE business_id = ?`).bind(hoursAgo(72), b.id).run();
    const item = (await buildToday(env.DB, new Date())).find((i) => i.kind === "draft_unsent" && i.businessId === b.id);
    expect(item?.reason).toMatch(/never exported$/);
  });
});

describe("role priority setting", () => {
  const put = (b: object) => api("/api/settings", { method: "PUT", body: JSON.stringify(b) });
  it("is stored as a full ranking, and a bad kind is rejected", async () => {
    expect(((await (await put({ role_kind_order: "seo, design" })).json()) as any).role_kind_order).toBe("seo,design,web_dev,cro,marketing");
    expect((await put({ role_kind_order: "seo,plumber" })).status).toBe(400);
    expect(((await (await api("/api/settings")).json()) as any).settings.role_kind_order).toBe("seo,design,web_dev,cro,marketing");
  });
});
