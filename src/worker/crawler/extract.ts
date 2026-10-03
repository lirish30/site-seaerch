import { parse, type HTMLElement } from "node-html-parser";
import type { Platform } from "../types";

export interface PageFacts {
  title: string | null; metaDescription: string | null; hasViewport: boolean; hasForm: boolean;
  emails: { value: string; personName: string | null; role: string | null }[];
  phones: string[]; socials: string[]; copyrightYear: number | null;
  dates: string[]; eventDates: string[]; internalLinks: string[]; isParked: boolean; platform: Platform;
  h1Count: number; wordCount: number; imageCount: number; imagesMissingAlt: number; hasTelLink: boolean; hasLocalBusinessSchema: boolean;
  mixedContentCount: number; datedBuildMarkers: string[]; isLikelyJsRendered: boolean;
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

const PLATFORM_GENERATORS: [Exclude<Platform, "other">, RegExp][] = [
  ["wix", /\bwix\b/i], ["squarespace", /squarespace/i], ["godaddy", /go\s?daddy|starfield/i], ["wordpress", /wordpress/i],
  ["weebly", /weebly/i], ["shopify", /shopify/i], ["webflow", /webflow/i],
];
// Asset HOSTS only (never bare brand domains or free text): a footer link to wix.com says nothing about the site's own platform.
const PLATFORM_HOSTS: [Exclude<Platform, "wordpress" | "other">, RegExp][] = [
  ["wix", /(^|\.)(wixstatic|parastorage)\.com$/], ["squarespace", /^(static\d*|assets)\.squarespace\.com$|(^|\.)(squarespace-cdn|sqspcdn)\.com$/],
  ["godaddy", /(^|\.)wsimg\.com$/], ["weebly", /(^|\.)(editmysite|weeblycloud)\.com$/],
  ["shopify", /^cdn\.shopify\.com$/], ["webflow", /(^|\.)website-files\.com$/],
];
const WP_PATH = /(^|\/)wp-(content|includes)\//i;

function urlsIn(el: HTMLElement): string[] {
  // getAttribute is case-insensitive; `attributes` keeps the source case (<IMG SRC=...>).
  const out: string[] = []; const g = (k: string) => el.getAttribute(k);
  for (const k of ["src", "href", "data-src"]) { const v = g(k); if (v) out.push(v); }
  const content = g("content"); if (content && /^(https?:)?\/\//i.test(content.trim())) out.push(content);
  const srcset = g("srcset"); if (srcset) for (const c of srcset.split(",")) out.push(c.trim().split(/\s+/)[0]);
  const style = g("style"); if (style) for (const m of style.matchAll(/url\(\s*["']?([^"')]+)/gi)) out.push(m[1]);
  return out;
}

// Reads the DOM, never raw HTML: no regex runs over the whole page, and markup inside scripts/comments/text is never a node.
export function detectPlatform(root: HTMLElement, pageHost: string): Platform {
  const site = pageHost.toLowerCase().replace(/^www\./, "");
  for (const m of root.querySelectorAll("meta")) {
    if (!/^generator$/i.test(m.getAttribute("name") ?? "")) continue;
    const g = m.getAttribute("content") ?? "";
    for (const [p, re] of PLATFORM_GENERATORS) if (re.test(g)) return p;
  }
  const hosts = new Set<Platform>();
  for (const el of root.querySelectorAll("[src],[href],[srcset],[data-src],[content],[style]")) {
    for (const raw of urlsIn(el)) {
      const u = raw.trim();
      const host = u.match(/^(?:https?:)?\/\/([^/?#:@]+)/i)?.[1].toLowerCase();
      // WordPress is checked first: a builder never serves its own /wp-content/, while WordPress pages commonly embed foreign builder assets.
      // But only the site's own (or relative) wp paths count: builder pages often hotlink images/PDFs from someone's WordPress blog, and
      // "wordpress" is the label that later means "not JS-rendered", so misreading a builder as WordPress is the unsafe direction.
      const own = !host || host.replace(/^www\./, "") === site || host.endsWith(`.${site}`);
      if ((own && WP_PATH.test(u.replace(/^(https?:)?\/\/[^/?#]*/i, "").split(/[?#]/)[0])) || (host && /^i\d\.wp\.com$/.test(host))) return "wordpress";
      const hit = host && PLATFORM_HOSTS.find(([, re]) => re.test(host));
      if (hit) hosts.add(hit[0]);
    }
  }
  for (const [p] of PLATFORM_HOSTS) if (hosts.has(p)) return p;
  const html = root.querySelector("html");
  if (html && Object.keys(html.attributes).some((k) => /^data-wf-/i.test(k))) return "webflow";
  return "other";
}

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

const BUSINESS_TYPES = new Set([
  "Plumber", "Electrician", "HVACBusiness", "RoofingContractor", "GeneralContractor", "HomeAndConstructionBusiness", "Locksmith", "MovingCompany",
  "Restaurant", "FoodEstablishment", "CafeOrCoffeeShop", "Bakery", "BarOrPub", "Dentist", "Physician", "MedicalBusiness", "MedicalClinic",
  "HealthAndBeautyBusiness", "BeautySalon", "HairSalon", "DaySpa", "NailSalon", "AutoRepair", "AutomotiveBusiness", "AutoDealer", "RealEstateAgent",
  "LegalService", "Attorney", "AccountingService", "FinancialService", "InsuranceAgency", "ProfessionalService", "Store", "LodgingBusiness", "Hotel",
  "SportsActivityLocation", "ChildCare", "VeterinaryCare", "PetStore",
]);

function isBusinessType(t: unknown): boolean {
  if (typeof t !== "string" || t.length > 200) return false;
  const name = t.trim().split(/[/:#]/).pop()!;
  return name.endsWith("LocalBusiness") || BUSINESS_TYPES.has(name);
}

// The main parse (script:false) discards script text, so JSON-LD needs its own default-options parse. It only runs when the page mentions
// ld+json at all, and reads rawText: script data is not entity-decoded by browsers, while .text would turn &quot; into a JSON-breaking quote.
function hasLocalBusinessSchema(html: string): boolean {
  if (!html.toLowerCase().includes("ld+json")) return false;
  for (const s of parse(html).querySelectorAll("script")) {
    if ((s.getAttribute("type") ?? "").trim().toLowerCase() !== "application/ld+json") continue;
    let data: unknown; try { data = JSON.parse(s.rawText.replace(/^﻿/, "")); } catch { continue; }
    const stack: unknown[] = [data]; // iterative: hostile JSON can nest deeper than the call stack allows
    for (let n = 0; stack.length && n < 100_000; n++) {
      const v = stack.pop();
      if (!v || typeof v !== "object") continue;
      if (Array.isArray(v)) { stack.push(...v); continue; }
      const type = (v as Record<string, unknown>)["@type"];
      if (Array.isArray(type) ? type.some(isBusinessType) : isBusinessType(type)) return true;
      stack.push(...Object.values(v));
    }
  }
  return false;
}

const SWF_URL = /\.swf(?:[?#]|$)/i;
const FLASH_CLASSID = /d27cdb6e-ae6d-11cf-96b8-444553540000/i;
const MOUNT_IDS = new Set(["root", "app", "__next", "___gatsby"]);
const TABLE_ROLES = new Set(["table", "grid", "treegrid"]);
const BLOCK_IN_CELL = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "IMG"]);
const MIXED_SRC_TAGS = new Set(["IMG", "SCRIPT", "IFRAME", "VIDEO", "AUDIO", "SOURCE"]);
const MARKER_ORDER = ["old-style font tags", "scrolling or blinking text", "frames", "Flash", "old-style centering tags", "an outdated jQuery version", "table-based page layout"];

const isInsecure = (v: string | undefined) => !!v && /^http:\/\//i.test(v.trim());
const roleOf = (el: HTMLElement) => (el.getAttribute("role") ?? "").trim().toLowerCase().split(/\s+/)[0];

// Only a jQuery that is demonstrably old: a versioned filename, or a jquery/<version>/ CDN directory. Plugins (migrate, ui, cookie) never match.
function isOldJquery(src: string): boolean {
  const parts = src.trim().split(/[?#]/)[0].toLowerCase().split("/");
  const file = parts[parts.length - 1];
  let v = file.match(/^jquery[-.]v?(\d+)\.(\d+)(?:\.\d+)?(?:\.min)?\.js$/);
  if (!v && /^jquery(?:\.min)?\.js$/.test(file) && parts[parts.length - 3] === "jquery") v = parts[parts.length - 2].match(/^(\d+)\.(\d+)(?:\.\d+)?$/);
  return !!v && (+v[1] < 1 || (+v[1] === 1 && +v[2] < 12));
}

interface TableFrame { legacy: boolean; cells: number; openCells: number; block: boolean; dataLike: boolean }

// One iterative walk over real element nodes (comments/scripts/text never are), linear even for pathologically nested markup.
function scanDom(root: HTMLElement, isHttps: boolean) {
  const r = { h1Count: 0, imageCount: 0, imagesMissingAlt: 0, hasTelLink: false, mixedContentCount: 0, hasMount: false };
  const markers = new Set<string>(); const tables: TableFrame[] = []; let roleTables = 0;
  const stack: [HTMLElement, boolean][] = [];
  const push = (el: HTMLElement) => { for (let i = el.childNodes.length - 1; i >= 0; i--) if (el.childNodes[i].nodeType === 1) stack.push([el.childNodes[i] as HTMLElement, false]); };
  push(root);
  while (stack.length) {
    const [el, exiting] = stack.pop()!; const tag = el.tagName;
    const inRoleTable = TABLE_ROLES.has(roleOf(el));
    if (exiting) {
      if (tag === "TD" && tables.length) tables[tables.length - 1].openCells--;
      // roleTables still includes this table's own role here, so a role=table/grid table or one nested in such an element is treated as data.
      if (tag === "TABLE") { const t = tables.pop()!; if (t.legacy && t.cells >= 3 && t.block && !t.dataLike && roleTables === 0) markers.add("table-based page layout"); }
      if (inRoleTable) roleTables--;
      continue;
    }
    stack.push([el, true]); push(el);
    if (inRoleTable) roleTables++;
    const top = tables[tables.length - 1];
    if (top && BLOCK_IN_CELL.has(tag) && top.openCells > 0) top.block = true;
    switch (tag) {
      case "H1": r.h1Count++; break;
      case "A": if (/^tel:/i.test((el.getAttribute("href") ?? "").trim())) r.hasTelLink = true; break;
      case "FONT": markers.add("old-style font tags"); break;
      case "MARQUEE": case "BLINK": markers.add("scrolling or blinking text"); break;
      case "FRAME": case "FRAMESET": markers.add("frames"); break;
      case "CENTER": markers.add("old-style centering tags"); break;
      case "EMBED": case "OBJECT":
        if (SWF_URL.test(el.getAttribute("src") ?? "") || SWF_URL.test(el.getAttribute("data") ?? "") || /x-shockwave-flash/i.test(el.getAttribute("type") ?? "")
          || FLASH_CLASSID.test(el.getAttribute("classid") ?? "")) markers.add("Flash");
        break;
      case "PARAM": if (/^movie$/i.test((el.getAttribute("name") ?? "").trim()) && SWF_URL.test(el.getAttribute("value") ?? "")) markers.add("Flash"); break;
      case "TABLE": tables.push({ legacy: ["cellspacing", "cellpadding", "bgcolor"].some((a) => el.getAttribute(a) !== undefined), cells: 0, openCells: 0, block: false, dataLike: false }); break;
      case "TD": if (top) { top.cells++; top.openCells++; } break;
      case "TH": case "CAPTION": case "THEAD": if (top) top.dataLike = true; break;
    }
    if (tag === "IMG") {
      const role = roleOf(el);
      if (role !== "presentation" && role !== "none" && (el.getAttribute("aria-hidden") ?? "").trim().toLowerCase() !== "true") {
        r.imageCount++; if (el.getAttribute("alt") === undefined) r.imagesMissingAlt++;
      }
    }
    if (tag === "SCRIPT" && isOldJquery(el.getAttribute("src") ?? "")) markers.add("an outdated jQuery version");
    if (isHttps && (MIXED_SRC_TAGS.has(tag) ? isInsecure(el.getAttribute("src")) : tag === "LINK" && /(^|\s)stylesheet(\s|$)/i.test(el.getAttribute("rel") ?? "") && isInsecure(el.getAttribute("href")))) r.mixedContentCount++;
    if (MOUNT_IDS.has(el.getAttribute("id") ?? "") || tag === "APP-ROOT" || el.getAttribute("ng-app") !== undefined || el.getAttribute("data-ng-app") !== undefined) r.hasMount = true;
  }
  return { ...r, datedBuildMarkers: MARKER_ORDER.filter((m) => markers.has(m)) };
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

  // The main parse drops script/style/noscript text, so structuredText is visible text; the head (title) is not, hence body when there is one.
  const visible = (root.querySelector("body") ?? root).structuredText.replace(/\s+/g, " ").trim();
  const dom = scanDom(root, base.protocol === "https:");
  const platform = detectPlatform(root, base.hostname);

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
    platform,
    h1Count: dom.h1Count,
    wordCount: visible.match(/\S+/g)?.length ?? 0,
    imageCount: dom.imageCount,
    imagesMissingAlt: dom.imagesMissingAlt,
    hasTelLink: dom.hasTelLink,
    hasLocalBusinessSchema: hasLocalBusinessSchema(html),
    mixedContentCount: dom.mixedContentCount,
    datedBuildMarkers: dom.datedBuildMarkers,
    // Absence checks are unreliable on builders that render client-side; Shopify/WordPress serve real HTML so they are deliberately excluded.
    isLikelyJsRendered: ["wix", "squarespace", "webflow"].includes(platform) || (visible.length < 200 && dom.hasMount),
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
