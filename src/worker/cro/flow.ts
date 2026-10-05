import type { CtaEl, PageSnapshot } from "./types";

export const BOOKING_VENDORS: [string, RegExp][] = [
  ["Calendly", /(^|\.)calendly\.com$/], ["Vagaro", /(^|\.)vagaro\.com$/], ["Zocdoc", /(^|\.)zocdoc\.com$/], ["Jane", /(^|\.)janeapp\.com$/],
  ["Mindbody", /(^|\.)mindbody(online)?\.(com|io)$/], ["Square", /(^|\.)(squareup\.com|square\.site)$/], ["Acuity", /(^|\.)acuityscheduling\.com$/],
  ["OpenTable", /(^|\.)opentable\.com$/], ["Resy", /(^|\.)resy\.com$/], ["Toast", /(^|\.)toasttab\.com$/], ["Housecall Pro", /(^|\.)housecallpro\.com$/],
  ["ServiceTitan", /(^|\.)servicetitan\.com$/], ["Jobber", /(^|\.)(getjobber|jobber)\.com$/], ["Booksy", /(^|\.)booksy\.com$/],
  ["Fresha", /(^|\.)fresha\.com$/], ["NexHealth", /(^|\.)nexhealth\.com$/], ["DoorDash", /(^|\.)doordash\.com$/],
  ["Setmore", /(^|\.)setmore\.com$/], ["SimplyBook", /(^|\.)simplybook\.me$/],
];
// Whole words only: "Facebook" must not read as "book".
const ACTION = /\b(?:book(?:ing)?|schedul(?:e|ing)|appointments?|quotes?|estimates?|order(?:s|ing)?|reserv(?:e|ation)s?|buy|shop|get started|sign up|enroll(?:ment)?|requests?|consult(?:ation)?s?|apply|contact|call)\b/i;
const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

export function vendorOf(url: string): string | null {
  try {
    const h = bareHost(new URL(url).hostname);
    return BOOKING_VENDORS.find(([, re]) => re.test(h))?.[0] ?? null;
  } catch { return null; }
}

/** The button a visitor is most likely meant to press: a header action first, else the first action visible before scrolling. */
export function pickPrimaryCta(s: PageSnapshot): CtaEl | null {
  const actions = s.ctas.filter((c) => c.aboveFold && ACTION.test(c.text));
  return actions.find((c) => c.inHeader) ?? actions[0] ?? null;
}

/** A bare "#" or a javascript: link opens a pop-up; "#section" just scrolls the page (no pop-up, nothing to follow). */
export function inPageAction(href: string): "modal" | "anchor" | null {
  const h = href.trim();
  if (h === "#" || /^javascript:/i.test(h)) return "modal";
  return h.startsWith("#") ? "anchor" : null;
}

/** Absolute URL to visit for the flow probe, or null when it must not be followed (phone, email, script, anchor, unknown domain). */
export function followable(href: string | null, base: string): string | null {
  if (!href || /^(tel:|mailto:|sms:|javascript:|#)/i.test(href.trim())) return null;
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (bareHost(u.hostname) === bareHost(new URL(base).hostname)) return u.toString();
    return vendorOf(u.toString()) ? u.toString() : null;
  } catch { return null; }
}

/** True when a navigation produced no usable page: no response at all, or an HTTP error status. */
export const loadFailed = (status: number | null | undefined): boolean => status == null || status >= 400;
