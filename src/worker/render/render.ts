import puppeteer from "@cloudflare/puppeteer";
import type { MobileFacts } from "../scoring/scorer";

export interface RenderResult {
  finalUrl: string;
  /** Rendered desktop DOM; empty when the desktop view was a bot-block page. */
  html: string;
  /** null when that view showed a bot-block/challenge page instead of the site. */
  desktopJpeg: Uint8Array | null;
  mobileJpeg: Uint8Array | null;
  mobile: MobileFacts | null;
}
/** Loads a page in a real browser. Injected so tests and local runs without the binding can skip it. */
export type Renderer = (url: string) => Promise<RenderResult | null>;

const DESKTOP = { width: 1280, height: 1800 };
const MOBILE = { width: 390, height: 1500, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const NAV_TIMEOUT_MS = 25_000;
export const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

// A firewall/challenge page is our crawler being refused, not a problem with the prospect's site.
export const BLOCK_PROBE = `(() => {
  const t = (document.title + " " + (document.body ? document.body.innerText : "")).slice(0, 2000);
  return /you have been blocked|access denied|attention required|just a moment|verify you are (a )?human|checking your browser|are you a robot|request unsuccessful|incapsula|ddos protection/i.test(t);
})()`;

// Runs inside the page: horizontal overflow and the share of visible text set below 12px.
const MOBILE_PROBE = `(() => {
  const vw = window.innerWidth;
  const overflowX = document.documentElement.scrollWidth > vw + 4;
  let total = 0, small = 0;
  for (const el of document.querySelectorAll("p, li, a, span, td, label, button")) {
    const t = (el.textContent || "").trim();
    if (!t || el.children.length > 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    total += t.length;
    if (parseFloat(getComputedStyle(el).fontSize) < 12) small += t.length;
  }
  return { overflowX, smallTextPct: total ? small / total : 0 };
})()`;

export function browserRenderer(binding: Fetcher): Renderer {
  return async (url) => {
    const browser = await puppeteer.launch(binding);
    try {
      const page = await browser.newPage();
      await page.setViewport(DESKTOP);
      await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
      const finalUrl = page.url();
      const desktopBlocked = await page.evaluate(BLOCK_PROBE) as boolean;
      const html = desktopBlocked ? "" : await page.content();
      const desktopJpeg = desktopBlocked ? null : await page.screenshot({ type: "jpeg", quality: 60 }) as Uint8Array;

      await page.setUserAgent(MOBILE_UA);
      await page.setViewport(MOBILE);
      await page.goto(finalUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
      const mobileBlocked = await page.evaluate(BLOCK_PROBE) as boolean;
      const mobile = mobileBlocked ? null : await page.evaluate(MOBILE_PROBE) as MobileFacts;
      const mobileJpeg = mobileBlocked ? null : await page.screenshot({ type: "jpeg", quality: 60 }) as Uint8Array;
      if (desktopBlocked && mobileBlocked) return null;
      return { finalUrl, html, desktopJpeg, mobileJpeg, mobile };
    } finally {
      await browser.close();
    }
  };
}

/** Prints self-contained HTML (the audit deck) to a 16:9 PDF in a real browser. */
export async function htmlToPdf(binding: Fetcher, html: string): Promise<Uint8Array> {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ width: "1280px", height: "720px", printBackground: true, preferCSSPageSize: true }) as Uint8Array;
  } finally {
    await browser.close();
  }
}
