// The name, address and phone check (Plan 14): do a client's own pages say what their Google listing says?
// Pure: the pages come in as `{ url, html }` and nothing is fetched or stored here. Everything on a page is untrusted text, read and compared, never followed or echoed.

export type NapPart = "match" | "mismatch" | "missing";
export interface NapResult { phone: NapPart; address: NapPart; name: NapPart; checkedPages: number }

/** The directories every client's citation list starts with. */
export const CITATION_DIRECTORIES: readonly string[] = [
  "Apple Business Connect", "Bing Places", "Yelp", "Facebook", "BBB", "Nextdoor", "Angi", "HomeAdvisor", "Thumbtack", "Yellow Pages", "Chamber of commerce", "Manta",
];

/** A North American phone number as its ten digits (a leading 1 dropped), or null when it is not one. */
export function normalizePhone(s: string): string | null {
  let digits = s.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[body.toLowerCase()] ?? all;
  });
}

interface PageText { text: string; telHrefs: string[] }

const MAX_HTML = 2_000_000;
const TEL_HREF = /\bhref\s*=\s*["']?\s*tel:([^"'>\s]+)/i;
const BLOCKS = /^<(script|style|noscript|template)\b/i;

/**
 * What a visitor reads on the page (scripts, styles and comments left out, tags removed, entities decoded, spaces collapsed, lower case) and the numbers in its tel: links.
 * One pass with `indexOf`, so a page built to be slow to read (thousands of unclosed tags) costs no more than its length. An unclosed script or comment hides the rest of the page, as a browser would.
 */
function pageText(html: string): PageText {
  const src = html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html;
  const lower = src.toLowerCase();
  const parts: string[] = [];
  const telHrefs: string[] = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { parts.push(src.slice(i)); break; }
    parts.push(src.slice(i, lt), " ");
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    const block = BLOCKS.exec(src.slice(lt, lt + 12));
    if (block) {
      const close = lower.indexOf(`</${block[1].toLowerCase()}`, lt);
      const gt = close < 0 ? -1 : src.indexOf(">", close);
      i = gt < 0 ? src.length : gt + 1;
      continue;
    }
    const gt = src.indexOf(">", lt);
    if (gt < 0) { parts.push(src.slice(lt)); break; }
    const tel = TEL_HREF.exec(src.slice(lt, gt));
    if (tel) {
      let v = tel[1];
      try { v = decodeURIComponent(v); } catch { /* keep the raw text */ }
      telHrefs.push(v.split(/[;,]/)[0]);
    }
    i = gt + 1;
  }
  return { text: decodeEntities(parts.join("")).replace(/\s+/g, " ").trim().toLowerCase(), telHrefs };
}

// Phones as people write them: a separator between the groups, so order numbers, licence numbers and dates are not read as phones (a bare run of ten digits is only taken from a tel: link).
const PHONE_RE = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g;

const DIRECTIONS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"]);
const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The street number and the street's name word of an address ("12345 SW Main St" is 12345 and main), or null when there is no number followed by a name. */
function addressKey(address: string): { number: string; street: string } | null {
  const t = tokens(address);
  const i = t.findIndex((x) => /^\d+$/.test(x));
  if (i < 0) return null;
  const street = t.slice(i + 1).find((x) => !DIRECTIONS.has(x));
  return street ? { number: t[i], street } : null;
}

/**
 * Compares what the pages say with the expected name, address and phone.
 * phone: `match` when any phone on the pages is the expected one, `mismatch` when the pages show phones and none is, `missing` when they show none.
 * address: `match` when one page has both the street number and the street's name word, else `missing`.
 * name: `match` when the name is on any page (case, spacing and entities ignored), else `missing`.
 */
export function napCheck(pages: { url: string; html: string }[], nap: { name: string; address: string; phone: string }): NapResult {
  const texts = pages.map((p) => pageText(p.html));

  const expectedPhone = normalizePhone(nap.phone);
  const shown = new Set<string>();
  for (const t of texts) {
    for (const m of t.text.matchAll(PHONE_RE)) { const n = normalizePhone(m[0]); if (n) shown.add(n); }
    for (const h of t.telHrefs) { const n = normalizePhone(h); if (n) shown.add(n); }
  }
  const phone: NapPart = expectedPhone !== null && shown.has(expectedPhone) ? "match" : shown.size > 0 ? "mismatch" : "missing";

  const key = addressKey(nap.address);
  const address: NapPart = key && texts.some((t) => { const w = new Set(tokens(t.text)); return w.has(key.number) && w.has(key.street); }) ? "match" : "missing";

  const name = decodeEntities(nap.name).replace(/\s+/g, " ").trim().toLowerCase();
  const found: NapPart = name !== "" && texts.some((t) => t.text.includes(name)) ? "match" : "missing";

  return { phone, address, name: found, checkedPages: pages.length };
}

const PARTS: readonly string[] = ["match", "mismatch", "missing"];

/** A result the checker stored, or null when the text is not one (nothing stored yet, or something else). */
export function parseNapResult(s: string | null): NapResult | null {
  if (s === null) return null;
  try {
    const v = JSON.parse(s) as Partial<Record<keyof NapResult, unknown>> | null;
    if (!v || typeof v !== "object") return null;
    const { phone, address, name, checkedPages } = v;
    if (typeof phone !== "string" || typeof address !== "string" || typeof name !== "string" || !PARTS.includes(phone) || !PARTS.includes(address) || !PARTS.includes(name)) return null;
    if (typeof checkedPages !== "number" || !Number.isInteger(checkedPages) || checkedPages < 0) return null;
    return { phone: phone as NapPart, address: address as NapPart, name: name as NapPart, checkedPages };
  } catch { return null; }
}
