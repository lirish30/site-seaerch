import type { Business } from "../../types";
import type { CapturedPage, EvidenceDraft } from "../types";
import { detectMartech } from "../martech";
import { base } from "./layout";

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;

export function martechEvidence(pages: CapturedPage[]): EvidenceDraft[] {
  const home = pages[0];
  if (!home) return [];
  const found = detectMartech({
    hosts: pages.flatMap((p) => p.requestHosts),
    scripts: pages.flatMap((p) => (p.desktop ?? p.mobile)?.scripts ?? []),
    globals: pages.flatMap((p) => (p.desktop ?? p.mobile)?.globals ?? []),
  });
  const names = [...new Set(found.map((f) => f.name))];
  const analytics = found.some((f) => f.kind === "analytics" || f.kind === "tag_manager");
  const callTracking = found.some((f) => f.kind === "call_tracking");
  const fact = !names.length ? "No analytics, conversion or call tracking detected"
    : `Detected tools: ${names.join(", ")}${analytics ? "" : "; no analytics detected"}${callTracking ? "" : "; No call tracking detected"}`;
  return [{ ...base(home), family: "martech", device: "both", data: { analytics, callTracking, tools: names }, fact }];
}

export function listingEvidence(pages: CapturedPage[], business: Business): EvidenceDraft[] {
  const home = pages[0];
  if (!home) return [];
  const snaps = pages.filter((p) => p.index === 0 || p.kind === "contact").flatMap((p) => [p.desktop, p.mobile]).filter((s) => !!s);
  const text = snaps.map((s) => s!.text).join(" ");
  const out: EvidenceDraft[] = [];
  if (business.phone) {
    const sitePhones = [...new Set([...snaps.flatMap((s) => s!.telLinks.map((t) => digits(t.href))), ...(text.match(PHONE) ?? []).map(digits)])].filter((d) => d.length === 10);
    const listed = digits(business.phone);
    if (!sitePhones.length) out.push({ ...base(home), family: "listing", device: "both", fact: `Google listing phone ${business.phone} does not appear anywhere on the site` });
    else if (!sitePhones.includes(listed)) {
      const shown = (text.match(PHONE) ?? [])[0] ?? sitePhones[0];
      out.push({ ...base(home), family: "listing", device: "both", fact: `Phone on the website (${shown.trim()}) differs from the Google listing (${business.phone})` });
    }
  }
  const street = business.address?.split(",")[0]?.trim();
  const num = street?.match(/^\d+/)?.[0];
  if (street && num && !new RegExp(`\\b${num}\\b`).test(text))
    out.push({ ...base(home), family: "listing", device: "both", fact: `Google listing address "${street}" is not shown on the site` });
  return out;
}

export function healthEvidence(p: CapturedPage): EvidenceDraft[] {
  const out: EvidenceDraft[] = [];
  const add = (fact: string, device: "desktop" | "mobile" | "both" = "both") => out.push({ ...base(p), family: "health", device, fact });
  const a = p.axe;
  if (a && a.critical + a.serious > 0) add(`${a.critical + a.serious} serious accessibility problems${a.top[0] ? ` (e.g. ${a.top[0].help})` : ""}`, "desktop");
  if (p.consoleErrors.length) add(`${p.consoleErrors.length} script error${p.consoleErrors.length > 1 ? "s" : ""} while loading (e.g. "${p.consoleErrors[0]}")`);
  if (p.failedRequests.length >= 3) add(`${p.failedRequests.length} files failed to load`);
  if (p.mobile?.overflowX) add("Page scrolls sideways on a phone", "mobile");
  if (p.mobile && p.mobile.smallTextPct > 0.2) add(`${Math.round(p.mobile.smallTextPct * 100)}% of text on mobile is smaller than 12px`, "mobile");
  return out;
}
