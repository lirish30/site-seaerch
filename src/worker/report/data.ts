import type { Env } from "../env";
import { getBusiness } from "../db/businesses";
import { latestAudit } from "../db/audits";
import { getSettings } from "../db/settings";
import { renderReport, type ReportData } from "./html";
import { croReportFor } from "./cro";

async function b64(raw: R2Bucket, key: string | null): Promise<string | null> {
  if (!key) return null;
  const o = await raw.get(key);
  return o ? Buffer.from(await o.arrayBuffer()).toString("base64") : null;
}

/** Loads a lead's latest audit and renders the client-facing deck; null when there is no audit yet. */
export async function reportFor(env: Pick<Env, "DB" | "RAW">, id: string, now = new Date()): Promise<{ html: string; data: ReportData } | null> {
  const [business, audit, settings, cro] = await Promise.all([getBusiness(env.DB, id), latestAudit(env.DB, id), getSettings(env.DB), croReportFor(env, id).catch((e) => { console.warn("CRO chapter skipped", e); return null; })]);
  if (!business || !audit) return null;
  const [desktopJpegB64, mobileJpegB64] = await Promise.all([b64(env.RAW, audit.screenshots.desktop), b64(env.RAW, audit.screenshots.mobile)]);
  const data: ReportData = { business, audit, settings, now, desktopJpegB64, mobileJpegB64, cro };
  return { html: renderReport(data), data };
}

export const reportFileName = (name: string, ext: string) =>
  `${name.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "website"}-website-audit.${ext}`;
