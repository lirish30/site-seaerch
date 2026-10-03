import { parse, type HTMLElement } from "node-html-parser";

export interface PageFacts {
  title: string | null; metaDescription: string | null; hasViewport: boolean; hasForm: boolean;
  emails: { value: string; personName: string | null; role: string | null }[];
  phones: string[]; socials: string[]; copyrightYear: number | null;
  dates: string[]; eventDates: string[]; internalLinks: string[]; isParked: boolean;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const OBFUSCATED_RE = /([a-z0-9._%+-]+)\s*[\[(]\s*at\s*[\])]\s*([a-z0-9-]+(?:\s*[\[(]\s*dot\s*[\])]\s*[a-z0-9-]+)+)/gi;
const JUNK_EMAIL = /(@(example\.(com|org|net)|domain\.com|email\.com|yourdomain\.com)$|@([a-z0-9-]+\.)*sentry\.io$|@([a-z0-9-]+\.)*wixpress\.com$|\.(png|jpe?g|gif|svg|webp)$|^[0-9a-f]{20,}@|^yourname@)/i;
const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;
const SOCIAL_HOSTS = /(^|\.)(facebook|instagram|twitter|x|linkedin|youtube|tiktok|yelp|nextdoor)\.com$/i;
const SOCIAL_ONLY = /(^|\.)(facebook\.com|fb\.com|instagram\.com|yelp\.com|linktr\.ee|business\.site|nextdoor\.com|twitter\.com|x\.com|tiktok\.com|square\.site|google\.com)$/i;
const NON_HTML = /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4|mp3)(\?|$)/i;
const PARKED = /(domain (may be|is) for sale|buy this domain|this domain is parked|parked free|godaddy\.com\/domainsearch|\bsedo\.com\b|\bhugedomains\b|\bdan\.com\b)/i;
const ROLE_RE = /^(owner|co-owner|founder|co-founder|president|ceo|manager|office manager|general manager|principal|director|partner|administrator|marketing( manager| director)?)$/i;
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const MONTH_DATE_RE = new RegExp(`\\b(${MONTHS.join("|")}|${MONTHS.map((m) => m.slice(0, 3)).join("|")})\\.?\\s+(\\d{1,2}),?\\s+(20\\d{2}|19\\d{2})\\b`, "gi");
const ISO_DATE_RE = /\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/g;
const SLASH_DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g;

const pad = (n: number) => String(n).padStart(2, "0");

function isoFromMonthName(m: string, d: string, y: string): string | null {
  const idx = MONTHS.findIndex((x) => x.startsWith(m.toLowerCase().slice(0, 3)));
  if (idx < 0) return null;
  return `${y}-${pad(idx + 1)}-${pad(Number(d))}`;
}

function findDates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MONTH_DATE_RE)) { const iso = isoFromMonthName(m[1], m[2], m[3]); if (iso) out.add(iso); }
  for (const m of text.matchAll(ISO_DATE_RE)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(SLASH_DATE_RE)) out.add(`${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`);
  return [...out];
}

function cleanEmail(e: string): string | null {
  const v = e.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  if (JUNK_EMAIL.test(v)) return null;
  return v;
}

const NAME_STOP = /\b(events?|contact|services?|welcome|about|home|hours|location|news|blog|upcoming)\b/i;

function distinctEmails(node: HTMLElement): Set<string> {
  const out = new Set<string>();
  for (const a of node.querySelectorAll('a[href^="mailto:"]')) { const v = cleanEmail(a.getAttribute("href")!); if (v) out.add(v); }
  for (const m of node.structuredText.matchAll(EMAIL_RE)) { const v = cleanEmail(m[0]); if (v) out.add(v); }
  return out;
}

function personFor(el: HTMLElement | null): { personName: string | null; role: string | null } {
  // Walk up to 3 ancestors; stop at the first one holding a name-like heading, and give up
  // once a container holds more than one email (it would be ambiguous who the heading is).
  let node: HTMLElement | null = el;
  for (let i = 0; i < 3 && node; i++) {
    node = node.parentNode as HTMLElement | null;
    if (!node || typeof node.querySelectorAll !== "function") break;
    if (distinctEmails(node).size > 1) break;
    const heading = node.querySelectorAll("h2, h3, h4, strong")
      .find((h) => { const t = h.text.trim(); return /^[A-Z][a-z]+(\s[A-Z][a-z'.-]+){1,2}$/.test(t) && !NAME_STOP.test(t); });
    if (heading) {
      const role = node.querySelectorAll("p, span, em").map((x) => x.text.trim()).find((t) => ROLE_RE.test(t));
      return { personName: heading.text.trim(), role: role ?? null };
    }
  }
  return { personName: null, role: null };
}

function isContactForm(f: HTMLElement): boolean {
  const fields = f.querySelectorAll("input, textarea");
  if (fields.length >= 2) return true;
  return fields.some((x) =>
    x.tagName === "TEXTAREA" || /^email$/i.test(x.getAttribute("type") ?? "") || /email|message/i.test(x.getAttribute("name") ?? ""));
}

export function isSocialOnlyUrl(url: string): boolean {
  try { return SOCIAL_ONLY.test(new URL(url).hostname.toLowerCase().replace(/^www\./, "")); } catch { return false; }
}

export function extractPage(html: string, pageUrl: string): PageFacts {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false } });
  const base = new URL(pageUrl);
  const text = root.structuredText.replace(/\s+/g, " ");

  const emails = new Map<string, { value: string; personName: string | null; role: string | null }>();
  for (const a of root.querySelectorAll('a[href^="mailto:"]')) {
    const v = cleanEmail(a.getAttribute("href")!);
    if (v && !emails.has(v)) emails.set(v, { value: v, ...personFor(a) });
  }
  for (const p of root.querySelectorAll("p, li, td, footer, span, div")) {
    if (p.childNodes.some((c) => (c as HTMLElement).tagName && ["DIV", "P", "TD"].includes((c as HTMLElement).tagName))) continue;
    for (const m of p.text.matchAll(EMAIL_RE)) {
      const v = cleanEmail(m[0]);
      if (v && !emails.has(v)) emails.set(v, { value: v, ...personFor(p) });
    }
  }
  for (const m of text.matchAll(OBFUSCATED_RE)) {
    const v = cleanEmail(`${m[1]}@${m[2].replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".")}`);
    if (v && !emails.has(v)) emails.set(v, { value: v, personName: null, role: null });
  }

  const years = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1]));
  const copyrightYear = years.length ? Math.max(...years) : null;

  const dates = new Set(findDates(text));
  for (const t of root.querySelectorAll("time[datetime]")) {
    const v = t.getAttribute("datetime")!.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) dates.add(v);
  }

  const eventDates = new Set<string>();
  for (const h of root.querySelectorAll("h1, h2, h3, h4")) {
    if (!/event|calendar|upcoming|schedule/i.test(h.text)) continue;
    let sib = h.nextElementSibling; let hops = 0;
    while (sib && hops < 3 && !/^H[1-4]$/.test(sib.tagName)) { if (!/posted|published|updated/i.test(sib.text)) findDates(sib.text).forEach((d) => eventDates.add(d)); sib = sib.nextElementSibling; hops++; }
  }

  const internal = new Set<string>(); const socials = new Set<string>();
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")!.trim();
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let u: URL; try { u = new URL(href, base); } catch { continue; }
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (SOCIAL_HOSTS.test(host)) { socials.add(u.toString()); continue; }
    if (host !== base.hostname.toLowerCase().replace(/^www\./, "")) continue;
    if (NON_HTML.test(u.pathname)) continue;
    internal.add(u.toString());
  }

  const title = root.querySelector("title")?.text.trim() || null;
  return {
    title,
    metaDescription: root.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || null,
    hasViewport: !!root.querySelector('meta[name="viewport"]'),
    hasForm: root.querySelectorAll("form").some(isContactForm),
    emails: [...emails.values()],
    phones: [...new Set([...text.matchAll(PHONE_RE)].map((m) => m[0].trim()))],
    socials: [...socials],
    copyrightYear,
    dates: [...dates],
    eventDates: [...eventDates],
    internalLinks: [...internal],
    isParked: PARKED.test(`${title ?? ""} ${text.slice(0, 3000)}`),
  };
}

const TARGET_PATTERNS = [/contact/i, /about/i, /team|staff|people/i, /blog/i, /news|updates/i, /event|calendar/i];

export function pickCrawlTargets(links: string[], baseUrl: string, max: number): string[] {
  const base = new URL(baseUrl);
  const baseHost = base.hostname.toLowerCase().replace(/^www\./, "");
  const seen = new Set<string>([base.toString()]);
  const candidates: URL[] = [];
  for (const l of links) {
    let u: URL;
    try { u = new URL(l, base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.toLowerCase().replace(/^www\./, "") !== baseHost) continue;
    u.hash = "";
    candidates.push(u);
  }
  const out: string[] = [];
  for (const pat of TARGET_PATTERNS) {
    for (const u of candidates) {
      const s = u.toString();
      if (seen.has(s) || !pat.test(u.pathname)) continue;
      seen.add(s); out.push(s);
      break;
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
