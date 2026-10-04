import type { PageKind } from "../types";
import type { CroPage } from "./types";
import { CRO_LIMITS } from "./config";

// Pages that decide whether a visitor converts come first.
const PRIORITY: PageKind[] = ["contact", "booking", "services", "shop", "menu", "pricing", "about", "locations", "portfolio", "testimonials", "team", "faq"];

const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");
const key = (u: URL) => `${host(u)}${u.pathname.replace(/\/+$/, "") || "/"}`;

export function selectPages(home: string, links: Partial<Record<PageKind, string>>, max = CRO_LIMITS.maxPages): CroPage[] {
  const base = new URL(/^https?:\/\//i.test(home) ? home : `https://${home}`);
  base.hash = "";
  const out: CroPage[] = [{ url: base.toString(), kind: "home" }];
  const seen = new Set([key(base)]);
  for (const kind of PRIORITY) {
    const raw = links[kind];
    if (!raw || out.length >= max) continue;
    let u: URL;
    try { u = new URL(raw, base); } catch { continue; }
    u.hash = "";
    if (host(u) !== host(base) || seen.has(key(u))) continue;
    seen.add(key(u));
    out.push({ url: u.toString(), kind });
  }
  return out;
}
