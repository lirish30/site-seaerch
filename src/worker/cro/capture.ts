import puppeteer from "@cloudflare/puppeteer";
import { BLOCK_PROBE, MOBILE_UA } from "../render/render";
import { AXE_RUN, FLOW_PROBE, PROBE_SCRIPT } from "./probe";
import { followable, pickPrimaryCta, vendorOf } from "./flow";
import { CRO_DESKTOP, CRO_LIMITS, CRO_MOBILE } from "./config";
import type { AxeSummary, FlowResult, PageCapture, PageSnapshot } from "./types";

/** Captures one page at desktop and mobile. Injected so tests run without Browser Rendering. */
export type CroBrowser = (url: string, o: { runFlow: boolean }) => Promise<PageCapture>;

const AXE_URL = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>;
type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;

const failed = (finalUrl: string): PageCapture => ({ ok: false, finalUrl, desktop: null, mobile: null, desktopJpeg: null, mobileJpeg: null,
  desktopTopJpeg: null, mobileTopJpeg: null, axe: null, consoleErrors: [], failedRequests: [], requestHosts: [], flow: null });

async function shots(page: Page, width: number, topHeight: number): Promise<[Uint8Array, Uint8Array]> {
  const full = Math.min(await page.evaluate("document.documentElement.scrollHeight") as number, CRO_LIMITS.shotMaxHeight);
  const clip = (height: number) => page.screenshot({ type: "jpeg", quality: 55, captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: Math.max(1, Math.min(full, height)) } }) as Promise<Uint8Array>;
  return [await clip(full), await clip(topHeight)];
}

async function runAxe(page: Page): Promise<AxeSummary> {
  await page.addScriptTag({ url: AXE_URL });
  return await page.evaluate(AXE_RUN) as AxeSummary;
}

// Visits the main button's destination in a separate tab. Never clicks, types or submits.
async function probeFlow(browser: Browser, s: PageSnapshot, base: string): Promise<FlowResult | null> {
  const cta = pickPrimaryCta(s);
  if (!cta || !cta.href || /^(tel:|mailto:|sms:)/i.test(cta.href)) return null;
  if (/^(#|javascript:)/i.test(cta.href.trim()))
    return { ctaText: cta.text, href: cta.href, finalUrl: base, offDomain: false, vendor: null, formFields: null, opensModal: true };
  const target = followable(cta.href, base);
  if (!target) {
    let abs = cta.href; try { abs = new URL(cta.href, base).toString(); } catch { /* keep raw */ }
    return { ctaText: cta.text, href: cta.href, finalUrl: abs, offDomain: true, vendor: null, formFields: null, opensModal: false };
  }
  const tab = await browser.newPage();
  try {
    await tab.setViewport(CRO_DESKTOP);
    await tab.goto(target, { waitUntil: "networkidle2", timeout: CRO_LIMITS.flowTimeoutMs });
    const finalUrl = tab.url();
    const r = await tab.evaluate(FLOW_PROBE) as { fields: number; iframes: string[] };
    const vendor = vendorOf(finalUrl) ?? r.iframes.map(vendorOf).find(Boolean) ?? null;
    const offDomain = new URL(finalUrl).hostname.replace(/^www\./, "") !== new URL(base).hostname.replace(/^www\./, "");
    return { ctaText: cta.text, href: cta.href, finalUrl, offDomain, vendor, formFields: r.fields, opensModal: false };
  } finally { await tab.close(); }
}

export function puppeteerCroBrowser(binding: Fetcher): CroBrowser {
  return async (url, o) => {
    const browser = await puppeteer.launch(binding);
    try {
      const page = await browser.newPage();
      const consoleErrors: string[] = [], failedRequests: string[] = [], hosts = new Set<string>();
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
      page.on("pageerror", (e) => consoleErrors.push(String((e as Error)?.message ?? e).slice(0, 200)));
      page.on("requestfailed", (r) => failedRequests.push(r.url().slice(0, 200)));
      page.on("request", (r) => { try { hosts.add(new URL(r.url()).hostname); } catch { /* data: urls */ } });

      await page.setViewport(CRO_DESKTOP);
      await page.goto(url, { waitUntil: "networkidle2", timeout: CRO_LIMITS.navTimeoutMs });
      const finalUrl = page.url();
      if (await page.evaluate(BLOCK_PROBE)) return failed(finalUrl);
      const desktop = await page.evaluate(PROBE_SCRIPT) as PageSnapshot;
      const [desktopJpeg, desktopTopJpeg] = await shots(page, CRO_DESKTOP.width, CRO_LIMITS.desktopTopHeight);
      const axe = await runAxe(page).catch(() => null);
      const flow = o.runFlow ? await probeFlow(browser, desktop, finalUrl).catch(() => null) : null;

      await page.setUserAgent(MOBILE_UA);
      await page.setViewport(CRO_MOBILE);
      await page.goto(finalUrl, { waitUntil: "networkidle2", timeout: CRO_LIMITS.navTimeoutMs });
      const mobileBlocked = await page.evaluate(BLOCK_PROBE) as boolean;
      const mobile = mobileBlocked ? null : await page.evaluate(PROBE_SCRIPT) as PageSnapshot;
      const [mobileJpeg, mobileTopJpeg] = mobile ? await shots(page, CRO_MOBILE.width, CRO_LIMITS.mobileTopHeight) : [null, null];
      return { ok: true, finalUrl, desktop, mobile, desktopJpeg, mobileJpeg, desktopTopJpeg, mobileTopJpeg, axe,
        consoleErrors: consoleErrors.slice(0, 20), failedRequests: failedRequests.slice(0, 20), requestHosts: [...hosts].slice(0, 100), flow };
    } finally {
      await browser.close();
    }
  };
}
