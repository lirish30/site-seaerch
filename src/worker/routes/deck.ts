import { Hono } from "hono";
import type { Env } from "../env";
import { latestAudit } from "../db/audits";
import { lastBookingFor } from "../db/bookings";
import { getBusiness } from "../db/businesses";
import { logActivity } from "../db/activity";
import { freezeDeckOn, getDeal, stampDeckFrozen, type Deal } from "../db/deals";
import { getPackage, listCurrentPackages, snapshotOf } from "../db/packages";
import { getSettings } from "../db/settings";
import { latestVideoFor } from "../db/videoAudits";
import { listWorkSamples } from "../db/workSamples";
import { offerOf } from "../queue/callRecap";
import { buildDeck, planProblems, problemsOf, scorecardOf, type DeckInput, type DeckPackage } from "../sales/deck";
import { renderDeckHtml } from "../sales/deckHtml";
import { emptyNotes } from "../sales/notes";
import { htmlToPdf } from "../render/render";

/** A screenshot bigger than this is left out of the deck rather than bloat it (the PDF would carry it too). */
export const MAX_DECK_IMAGE_BYTES = 400 * 1024;

const base64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** An R2 image as a `data:` URI, or null when it is missing, over the size limit, or cannot be read: a deck never fails over a picture. */
export async function imageDataUri(bucket: R2Bucket, key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  try {
    const obj = await bucket.get(key);
    if (!obj || obj.size > MAX_DECK_IMAGE_BYTES) return null;
    const type = obj.httpMetadata?.contentType;
    const mime = type && /^image\/(jpeg|png|webp|gif)$/.test(type) ? type : /\.png$/i.test(key) ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${base64(new Uint8Array(await obj.arrayBuffer()))}`;
  } catch {
    return null;
  }
}

/** Letters that do not split into a base letter and a mark, folded by hand (the rest is handled by Unicode decomposition). */
const FOLD: Record<string, string> = { "Ł": "L", "ł": "l", "Ø": "O", "ø": "o", "Đ": "D", "đ": "d", "ß": "ss", "Æ": "AE", "æ": "ae", "Œ": "OE", "œ": "oe", "Þ": "Th", "þ": "th", "Ð": "D", "ð": "d" };
const asciiFold = (s: string) => s.replace(/[ŁłØøĐđßÆæŒœÞþÐð]/g, (c) => FOLD[c]).normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^A-Za-z0-9 ._-]/g, " ");

/**
 * A file name base with anything a header or a file system would object to taken out. Letters of any script stay (this is the name for `filename*`);
 * with `ascii` they are folded to plain letters (a name with none, such as Chinese, becomes the fallback) for the plain `filename=`.
 */
export function safeFileName(name: string, o: { ascii?: boolean; fallback?: string } = {}): string {
  const safe = name.replace(/[^\p{L}\p{N} ._-]/gu, " ");
  return (o.ascii ? asciiFold(safe) : safe).replace(/\s+/g, " ").trim().slice(0, 80).trim() || o.fallback || "Website";
}

/** "<Business> - Recommendation - <YYYY-MM-DD>.pdf", the business name made safe by `safeFileName`. */
export function deckFileName(name: string, now: Date, o: { ascii?: boolean } = {}): string {
  return `${safeFileName(name, o)} - Recommendation - ${now.toISOString().slice(0, 10)}.pdf`;
}

/** The download header: a plain ASCII `filename` for old clients and the real name in `filename*` (RFC 6266), so a name outside Latin-1 never reaches a header raw. */
export const deckContentDisposition = (name: string, now: Date): string =>
  `attachment; filename="${deckFileName(name, now, { ascii: true })}"; filename*=UTF-8''${encodeURIComponent(deckFileName(name, now)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

/**
 * The packages the deck reads inclusions from. A deal with a snapshot gets the exact versions it froze (so editing a package later changes nothing in the
 * deck); a snapshot entry whose version row is missing is kept without inclusions (never an error). A deal with no snapshot gets the current catalog.
 */
async function catalogFor(db: D1Database, deal: Deal): Promise<DeckPackage[]> {
  if (deal.priceSnapshot.length === 0) return (await listCurrentPackages(db)).map((p) => ({ ...snapshotOf(p), includes: p.includes, summary: p.summary }));
  return Promise.all(deal.priceSnapshot.map(async (s): Promise<DeckPackage> => {
    const p = await getPackage(db, s.key, s.version).catch(() => null);
    return p ? { ...s, includes: p.includes, summary: p.summary } : { ...s };
  }));
}

/** Everything the deck is built from, read now. Only a deal with its recap and options has one. */
async function loadInput(env: Env, deal: Deal, now: Date): Promise<DeckInput | null> {
  if (!deal.recap || !deal.options) return null;
  const business = await getBusiness(env.DB, deal.businessId);
  if (!business) return null;
  const [audit, video, settings, samples, catalog, discovery] = await Promise.all([
    latestAudit(env.DB, deal.businessId), latestVideoFor(env.DB, deal.businessId), getSettings(env.DB), listWorkSamples(env.DB), catalogFor(env.DB, deal),
    lastBookingFor(env.DB, deal.businessId, "discovery"),
  ]);
  const plan = video?.plan ?? null;
  const images: Record<string, string | null> = {};
  for (const p of planProblems(plan).slice(0, 3)) if (!(p.shotId in images)) images[p.shotId] = await imageDataUri(env.RAW, p.previewKey);
  return {
    deal, now,
    business: { name: business.name, ownerName: discovery?.contactName?.trim() || null },
    notes: deal.notes ?? emptyNotes(), recap: deal.recap,
    problems: problemsOf(plan, audit?.findings ?? [], images),
    scorecard: audit ? scorecardOf(audit) : [],
    // Work samples carry a link and a result line, not a picture.
    samples: samples.map((s) => ({ name: s.title, blurb: s.result_line, imageDataUri: null })),
    settings: { your_name: settings.your_name, bio: settings.bio, contact_email: settings.contact_email, role_title: settings.role_title },
    catalog,
  };
}

const NEED_RECAP = { error: "draft the recap first" };

/** The deck's own pieces, as a function of what it may use: tests hand in a fake PDF renderer. */
export function deckRoutes(deps: { pdf?: (binding: Fetcher, html: string) => Promise<Uint8Array> } = {}) {
  const pdf = deps.pdf ?? htmlToPdf;
  const app = new Hono<{ Bindings: Env }>();
  const headers = {
    "cache-control": "no-store",
    // The deck makes no request of its own; the page that frames it is this app's.
    "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'",
  };

  /** The deck as the deal stands, from the stored snapshot. It does not freeze: the caller stamps `deckFrozenAt` once the deck has actually been delivered. */
  async function render(env: Env, id: string, print: boolean, now: Date) {
    const deal = await getDeal(env.DB, id);
    if (!deal) return { status: 404 as const, error: "not found" };
    const input = await loadInput(env, deal, now);
    if (!input) return { status: 409 as const, error: NEED_RECAP.error };
    const html = renderDeckHtml(buildDeck(input), { title: `${input.business.name} - Recommendation`, print });
    return { status: 200 as const, html, deal, name: input.business.name };
  }

  app.get("/:id/deck.html", async (c) => {
    const now = new Date();
    const r = await render(c.env, c.req.param("id"), false, now);
    if (r.status === 200 && !r.deal.deckFrozenAt) await stampDeckFrozen(c.env.DB, r.deal.id, now);
    return r.status === 200 ? c.html(r.html, 200, headers) : c.json({ error: r.error }, r.status);
  });

  app.get("/:id/deck.pdf", async (c) => {
    if (!c.env.BROWSER) return c.json({ error: "PDF export needs the Browser Rendering binding" }, 501);
    const now = new Date();
    const r = await render(c.env, c.req.param("id"), true, now);
    if (r.status !== 200) return c.json({ error: r.error }, r.status);
    let bytes: Uint8Array;
    try { bytes = await pdf(c.env.BROWSER, r.html); }
    catch (e) {
      console.error("deck pdf failed", e instanceof Error ? e.message : "unknown error");
      return c.json({ error: "could not make the PDF, please try again" }, 502);
    }
    // Frozen only once the PDF exists: a failed render leaves the deck a draft.
    if (!r.deal.deckFrozenAt) await stampDeckFrozen(c.env.DB, r.deal.id, now);
    await logActivity(c.env.DB, r.deal.businessId, "export", "Downloaded recommendation deck PDF");
    return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": deckContentDisposition(r.name, now) } });
  });

  /** Freezes the deck on today's catalog: the options' packages are snapshotted again at their current prices. */
  app.post("/:id/deck/freeze", async (c) => {
    const deal = await getDeal(c.env.DB, c.req.param("id"));
    if (!deal) return c.json({ error: "not found" }, 404);
    if (!deal.recap || !deal.options) return c.json(NEED_RECAP, 409);
    if (deal.stage === "won" || deal.stage === "lost") return c.json({ error: "the deal is closed" }, 409);
    await freezeDeckOn(c.env.DB, deal.id, offerOf(deal.options, await listCurrentPackages(c.env.DB)));
    return c.json(await getDeal(c.env.DB, deal.id));
  });

  return app;
}
