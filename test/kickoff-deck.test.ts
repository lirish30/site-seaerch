import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { insertTasks } from "../src/worker/db/tasks";
import { kickoffDeckRoutes } from "../src/worker/routes/deck";
import { buildKickoffDeck, type KickoffStep } from "../src/worker/sales/kickoffDeck";
import { renderDeckHtml } from "../src/worker/sales/deckHtml";
import { newTask, seedProject } from "./fixtures/projects";

const step = (o: Partial<KickoffStep> = {}): KickoffStep => ({
  phaseKey: "design", phaseTitle: "Design", title: "A step", owner: "logan", clientSummary: null, status: "todo", ...o,
});
const deck = (steps: KickoffStep[], o: { clientName?: string; yourName?: string } = {}) => buildKickoffDeck({ clientName: o.clientName ?? "Ace Plumbing", yourName: o.yourName ?? "Logan Irish", steps });
const textOf = (slides: ReturnType<typeof deck>) => JSON.stringify(slides);
const listOf = (slide: ReturnType<typeof deck>[number], heading: string) => {
  const b = slide.blocks.find((x) => x.type === "list" && x.heading === heading);
  return b && b.type === "list" ? b.items.map((i) => i.text) : null;
};

describe("buildKickoffDeck", () => {
  it("phases appear in task order with their titles", () => {
    const slides = deck([
      step({ phaseKey: "strategy", phaseTitle: "Strategy", clientSummary: "We map your pages." }),
      step({ phaseKey: "design", phaseTitle: "Design", clientSummary: "We design the homepage." }),
      step({ phaseKey: "strategy", phaseTitle: "Strategy", clientSummary: "We pick your towns." }),
      step({ phaseKey: "launch", phaseTitle: "Launch", clientSummary: "We go live." }),
    ]);
    expect(slides.map((s) => s.key)).toEqual(["title", "agenda", "timeline", "timeline", "timeline"]);
    expect(slides[0].title).toBe("Ace Plumbing");
    expect(slides[1].title).toBe("How we will work");
    const agenda = slides[1].blocks.find((b) => b.type === "list");
    expect(agenda && agenda.type === "list" && agenda.items.map((i) => i.text)).toEqual(["Strategy", "Design", "Launch"]);
    expect(slides.slice(2).map((s) => s.title)).toEqual(["Strategy", "Design", "Launch"]);
    expect(listOf(slides[2], "What we do")).toEqual(["We map your pages.", "We pick your towns."]);
  });

  it("a skipped step is absent and a phase left empty is absent", () => {
    const slides = deck([
      step({ phaseKey: "a", phaseTitle: "Alpha", clientSummary: "Alpha work." }),
      step({ phaseKey: "a", phaseTitle: "Alpha", clientSummary: "SKIPPED-SENTENCE", status: "skipped" }),
      step({ phaseKey: "b", phaseTitle: "Beta", clientSummary: "SKIPPED-ONLY", status: "skipped" }),
      step({ phaseKey: "c", phaseTitle: "Gamma", clientSummary: "Gamma work." }),
    ]);
    const all = textOf(slides);
    expect(all).not.toContain("SKIPPED");
    expect(all).not.toContain("Beta");
    expect(slides.map((s) => s.title)).toEqual(["Ace Plumbing", "How we will work", "Alpha", "Gamma"]);
  });

  it("a step without a client summary shows no sentence and is not invented", () => {
    const slides = deck([
      step({ title: "INTERNAL-TITLE one", clientSummary: "We design the homepage." }),
      step({ title: "INTERNAL-TITLE two", clientSummary: null }),
      step({ title: "INTERNAL-TITLE three", clientSummary: "  ", owner: "claude" }),
    ]);
    const phase = slides[2];
    expect(listOf(phase, "What we do")).toEqual(["We design the homepage."]);
    expect(listOf(phase, "What we need from you")).toBeNull();
    expect(textOf(slides)).not.toContain("INTERNAL-TITLE");
  });

  it("what we need from you is only a waiting_client step that carries a client summary", () => {
    const slides = deck([
      step({ clientSummary: "We design the homepage." }),
      step({ clientSummary: "Send us your logo.", status: "waiting_client" }),
      step({ clientSummary: null, status: "waiting_client" }),
    ]);
    expect(listOf(slides[2], "What we do")).toEqual(["We design the homepage."]);
    expect(listOf(slides[2], "What we need from you")).toEqual(["Send us your logo."]);
  });

  it("carries no date", () => {
    expect(textOf(deck([step({ clientSummary: "We design the homepage." })]))).not.toMatch(/\b(20\d\d|Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)\b/);
  });

  it("the client name is escaped in the html", () => {
    const name = `<script>alert(1)</script> & "Sons"`;
    const html = renderDeckHtml(deck([step({ clientSummary: "We design the homepage." })], { clientName: name }), { title: `${name} - Kickoff`, print: true });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Sons&quot;");
  });
});

describe("kickoff deck route", () => {
  let cookie = "";
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });
  const BROWSER = { marker: "browser" } as unknown as Fetcher;
  const fakePdf = () => {
    const calls: { binding: unknown; html: string }[] = [];
    const pdf = async (binding: Fetcher, html: string) => { calls.push({ binding, html }); return new Uint8Array([37, 80, 68, 70]); };
    return { calls, app: kickoffDeckRoutes({ pdf }) };
  };
  const get = (app: ReturnType<typeof kickoffDeckRoutes>, id: string, e: Record<string, unknown> = { ...env, BROWSER }) => app.request(`/${id}/kickoff-deck.pdf`, { method: "GET" }, e);

  it("requires sign-in", async () => {
    expect((await SELF.fetch("https://x/api/projects/x/kickoff-deck.pdf")).status).toBe(401);
  });

  it("the route 422s a non-build project, 501s without BROWSER, and sends a PDF with the deck file name when a fake renderer is injected", async () => {
    const { app, calls } = fakePdf();
    const quick = await seedProject({ kind: "quick_fix" });
    const res422 = await get(app, quick.project.id);
    expect(res422.status).toBe(422);
    expect(((await res422.json()) as { error: string }).error).toMatch(/build/i);
    expect((await get(app, "not-a-project")).status).toBe(404);

    const { project, businessId } = await seedProject();
    await insertTasks(env.DB, [
      newTask(project.id, businessId, { position: 0, phaseKey: "design", phaseTitle: "Design", clientSummary: "We design the homepage.", owner: "claude" }),
      newTask(project.id, businessId, { position: 1, phaseKey: "design", phaseTitle: "Design", clientSummary: "NOT-A-STEP", isStep: false }),
    ]);
    expect((await get(app, project.id, { ...env, BROWSER: undefined })).status).toBe(501);
    expect(calls).toHaveLength(0);

    const ok = await get(app, project.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(ok.headers.get("content-disposition")).toMatch(/^attachment; filename=".* - Kickoff - \d{4}-\d{2}-\d{2}\.pdf"; filename\*=UTF-8''/);
    expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([37, 80, 68, 70]);
    expect(calls).toHaveLength(1);
    expect(calls[0].binding).toBe(BROWSER);
    expect(calls[0].html).toContain("We design the homepage.");
    expect(calls[0].html).not.toContain("NOT-A-STEP");
  });

  it("is mounted under /api behind the session (a signed-in call for a missing project is the route's own 404)", async () => {
    const res = await SELF.fetch("https://x/api/projects/not-a-project/kickoff-deck.pdf", { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
