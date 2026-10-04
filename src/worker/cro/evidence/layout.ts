import type { CapturedPage, EvidenceDraft, PageSnapshot } from "../types";

export const base = (p: CapturedPage) => ({ page: p.url, pageKind: p.kind });
const list = (xs: string[], n = 8) => xs.slice(0, n).map((x) => `"${x}"`).join(", ");
const HIGH_INTENT = /financ|pricing|price|book|appointment|insurance|quote|estimate|menu|order|shop|reserv/i;

export function ctaEvidence(p: CapturedPage): EvidenceDraft[] {
  const out: EvidenceDraft[] = [];
  const views: [PageSnapshot | null, "desktop" | "mobile"][] = [[p.desktop, "desktop"], [p.mobile, "mobile"]];
  for (const [s, device] of views) {
    if (!s) continue;
    const above = s.ctas.filter((c) => c.aboveFold);
    const where = device === "mobile" ? "On a phone" : "On desktop";
    if (!above.length) out.push({ ...base(p), family: "cta", device, fact: `${where}, no action button is visible before scrolling` });
    else if (above.length >= 3) out.push({ ...base(p), family: "cta", device, data: { count: above.length },
      crop: { ...above[0].box, device, pageIndex: p.index }, fact: `${where}, ${above.length} competing buttons show before scrolling: ${list(above.map((c) => c.text), 5)}` });
    for (const c of s.ctas.filter((c) => c.contrast !== null && c.contrast < 3).slice(0, 2))
      out.push({ ...base(p), family: "cta", device, crop: { ...c.box, device, pageIndex: p.index },
        fact: `Button "${c.text}" has low text contrast (${c.contrast}:1; 4.5:1 is the readable minimum)` });
    if (device === "mobile") {
      const tiny = s.ctas.filter((c) => c.box.h > 0 && c.box.h < 44);
      if (tiny.length) out.push({ ...base(p), family: "cta", device, crop: { ...tiny[0].box, device, pageIndex: p.index },
        fact: `${tiny.length} button${tiny.length > 1 ? "s" : ""} on mobile ${tiny.length > 1 ? "are" : "is"} smaller than a thumb-sized 44px (e.g. "${tiny[0].text}", ${tiny[0].box.h}px tall)` });
    }
  }
  if (p.index === 0 && p.desktop) {
    const head = p.desktop.ctas.filter((c) => c.inHeader);
    out.push(head.length
      ? { ...base(p), family: "cta", device: "desktop", crop: { ...head[0].box, device: "desktop", pageIndex: p.index }, fact: `Desktop header button: "${head[0].text}"` }
      : { ...base(p), family: "cta", device: "desktop", fact: "No action button in the desktop header (only text links)" });
  }
  if (p.desktop?.ctas.length) out.push({ ...base(p), family: "cta", device: "desktop", fact: `Buttons on this page: ${list(p.desktop.ctas.map((c) => c.text))}` });
  return out;
}

export function navEvidence(p: CapturedPage): EvidenceDraft[] {
  if (p.index !== 0 || !p.desktop) return [];
  const nav = p.desktop.nav;
  if (!nav.length) return [{ ...base(p), family: "nav", device: "desktop", fact: "No navigation menu found on desktop" }];
  const out: EvidenceDraft[] = [{ ...base(p), family: "nav", device: "desktop", data: { count: nav.length },
    fact: `Main menu has ${nav.length} top-level items: ${nav.map((n) => n.text).join(", ")}` }];
  for (const parent of nav) for (const child of parent.children)
    if (HIGH_INTENT.test(child.text)) out.push({ ...base(p), family: "nav", device: "desktop", fact: `"${child.text}" is nested under "${parent.text}" in the menu` });
  if (p.mobile) out.push({ ...base(p), family: "nav", device: "mobile",
    fact: p.mobile.stickyHeader ? "Header stays visible on mobile while scrolling" : "Header does not stay visible on mobile while scrolling" });
  return out;
}

export function contactEvidence(p: CapturedPage): EvidenceDraft[] {
  const out: EvidenceDraft[] = [];
  const m = p.mobile;
  if (m && p.index === 0) {
    const headTel = m.telLinks.find((t) => t.inHeader);
    if (headTel) out.push({ ...base(p), family: "contact", device: "mobile", crop: { ...headTel.box, device: "mobile", pageIndex: p.index },
      fact: `Phone number is a tap-to-call link in the mobile header: "${headTel.text}"` });
    else if (m.headerPhoneText) out.push({ ...base(p), family: "contact", device: "mobile", fact: `Phone number in the mobile header is plain text, not tappable: "${m.headerPhoneText}"` });
  }
  const s = p.desktop;
  if (s && !s.telLinks.length && !(m?.telLinks.length)) out.push({ ...base(p), family: "contact", device: "both", fact: "No tap-to-call phone link on this page" });
  if (s && p.kind === "contact" && !s.forms.length && !s.mailtoCount) out.push({ ...base(p), family: "contact", device: "both", fact: "Contact page has no form and no email link" });
  return out;
}
