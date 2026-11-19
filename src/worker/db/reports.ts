import type { Finding } from "../types";
import { businessDomain } from "./businesses";
import { publishedVideoForAudit, type VideoAudit } from "./videoAudits";
import { aiVoiceNote } from "../video/plan";
import { parseConfig } from "../booking/config";
import { hasCalendarScope } from "../google/oauth";
import { getGoogleAuth } from "./google";

export const REPORT_TTL_DAYS = 30;
const DAY_MS = 86_400_000;

export interface ReportRow { token: string; business_id: string; audit_id: string; created_at: string; expires_at: string; revoked: number; }

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

export async function createReport(db: D1Database, businessId: string, auditId: string, now = new Date()): Promise<ReportRow> {
  const row: ReportRow = { token: newToken(), business_id: businessId, audit_id: auditId, created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + REPORT_TTL_DAYS * DAY_MS).toISOString(), revoked: 0 };
  await db.prepare(`INSERT INTO audit_reports (token, business_id, audit_id, created_at, expires_at, revoked) VALUES (?,?,?,?,?,0)`)
    .bind(row.token, row.business_id, row.audit_id, row.created_at, row.expires_at).run();
  return row;
}

/**
 * The live report link for this audit, minted only when there is none. The check and the insert are one statement, so two
 * callers at once end up sharing one token instead of creating two.
 */
export async function ensureReport(db: D1Database, businessId: string, auditId: string, now = new Date()): Promise<ReportRow> {
  const created = now.toISOString(), expires = new Date(now.getTime() + REPORT_TTL_DAYS * DAY_MS).toISOString();
  await db.prepare(`INSERT INTO audit_reports (token, business_id, audit_id, created_at, expires_at, revoked)
    SELECT ?,?,?,?,?,0 WHERE NOT EXISTS (SELECT 1 FROM audit_reports WHERE business_id = ? AND audit_id = ? AND revoked = 0 AND expires_at > ?)`)
    .bind(newToken(), businessId, auditId, created, expires, businessId, auditId, created).run();
  return (await activeReportFor(db, businessId, auditId, now))!;
}

export async function activeReportFor(db: D1Database, businessId: string, auditId: string, now = new Date()): Promise<ReportRow | null> {
  return db.prepare(
    `SELECT * FROM audit_reports WHERE business_id = ? AND audit_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(businessId, auditId, now.toISOString()).first<ReportRow>();
}

/** Other live links for the business (e.g. made for an earlier audit), so the owner can see and revoke them. */
export async function otherActiveCount(db: D1Database, businessId: string, exceptToken: string | null, now = new Date()): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM audit_reports WHERE business_id = ? AND revoked = 0 AND expires_at > ? AND token != ?`)
    .bind(businessId, now.toISOString(), exceptToken ?? "").first<{ n: number }>();
  return r?.n ?? 0;
}

export async function revokeReports(db: D1Database, businessId: string): Promise<void> {
  await db.prepare(`UPDATE audit_reports SET revoked = 1 WHERE business_id = ?`).bind(businessId).run();
}

export interface PublicReport {
  businessName: string; /** Host of the audited site (e.g. "acme.com"), "" when unknown; shown to the recipient, who owns it. */ website: string; auditedAt: string; counts: { high: number; medium: number; low: number };
  findings: { severity: PublicSeverity; evidence: string }[]; partial: boolean;
  sender: { name: string; businessName: string; email: string; logoUrl: string }; expiresAt: string;
  /** The audit's published video, or null. The files are served by the media route, never named here. */
  video: { durationMs: number; aiVoiceNote: boolean } | null;
  /**
   * Where the "book a call" button goes. The per-lead page (`<link base>/r/<token>/book`) when booking is on: Google connected with both calendar
   * scopes and at least one availability window. Otherwise the owner's own booking link (https only), and only when there is a video to put it beside.
   * "" when neither applies.
   */
  bookingUrl: string;
}

const SEVERITIES = ["high", "medium", "low"] as const;
export type PublicSeverity = (typeof SEVERITIES)[number];
// The public page speaks high / medium / low. Audit findings use critical / important / nice; findings stored before
// audit v2 already used high / medium / low. Anything else is never shown.
const PUBLIC_SEVERITY: Record<string, PublicSeverity> = {
  critical: "high", important: "medium", nice: "low", high: "high", medium: "medium", low: "low",
};

/** The live report link's audit and the audit's published video (null when it has none). Decided exactly as `publicReport` decides a link is live. */
export async function publishedVideoForToken(db: D1Database, token: string, now = new Date()): Promise<VideoAudit | null> {
  const r = await db.prepare(
    `SELECT r.audit_id AS audit_id FROM audit_reports r JOIN audits a ON a.id = r.audit_id AND a.business_id = r.business_id JOIN businesses b ON b.id = r.business_id
     WHERE r.token = ? AND r.revoked = 0 AND r.expires_at > ?`,
  ).bind(token, now.toISOString()).first<{ audit_id: string }>();
  return r ? publishedVideoForAudit(db, r.audit_id) : null;
}

/**
 * The lead and audit a report link is live for: not revoked, not expired, its audit still the lead's own. Decided exactly as `publicReport` and
 * `publishedVideoForToken` decide a link is live. Null for anything else.
 */
export async function liveReportTarget(db: D1Database, token: string, now = new Date()): Promise<{ businessId: string; auditId: string } | null> {
  const r = await db.prepare(
    `SELECT r.business_id AS business_id, r.audit_id AS audit_id FROM audit_reports r JOIN audits a ON a.id = r.audit_id AND a.business_id = r.business_id JOIN businesses b ON b.id = r.business_id
     WHERE r.token = ? AND r.revoked = 0 AND r.expires_at > ?`,
  ).bind(token, now.toISOString()).first<{ business_id: string; audit_id: string }>();
  return r ? { businessId: r.business_id, auditId: r.audit_id } : null;
}

/** The cold-link base without a trailing slash, or "" when it is missing or not https. */
const httpsBase = (raw: string | undefined) => { const v = raw?.trim().replace(/\/+$/, "") ?? ""; return /^https:\/\/[^/\s]+/.test(v) ? v : ""; };

/** The ONLY shape exposed publicly. Fields are copied one by one so nothing else can leak in by accident. `linkBase` is OUTREACH_LINK_BASE. */
export async function publicReport(db: D1Database, token: string, now = new Date(), o: { linkBase?: string } = {}): Promise<PublicReport | null> {
  const r = await db.prepare(
    `SELECT b.name AS business_name, b.domain AS domain, b.website_url AS website_url, a.created_at AS audited_at, a.partial AS partial, a.findings AS findings, r.expires_at AS expires_at, r.audit_id AS audit_id,
            s.your_name AS your_name, s.business_name AS sender_business, s.contact_email AS contact_email, s.logo_url AS logo_url, s.booking_url AS booking_url, s.ai_voice_note AS ai_voice_note, s.booking_config AS booking_config
     FROM audit_reports r JOIN audits a ON a.id = r.audit_id AND a.business_id = r.business_id JOIN businesses b ON b.id = r.business_id JOIN settings s ON s.id = 1
     WHERE r.token = ? AND r.revoked = 0 AND r.expires_at > ?`,
  ).bind(token, now.toISOString()).first<{ business_name: string; domain: string | null; website_url: string | null; audited_at: string; partial: number; findings: string; expires_at: string; audit_id: string;
    your_name: string; sender_business: string; contact_email: string; logo_url: string; booking_url: string; ai_voice_note: number; booking_config: string }>();
  if (!r) return null;
  // Booking is on only when there is somewhere to send the person (a link base), times to offer (a window) and a calendar to book into (Google, both scopes).
  const base = httpsBase(o.linkBase);
  const bookingOn = !!base && parseConfig(r.booking_config).windows.length > 0 && hasCalendarScope((await getGoogleAuth(db))?.scope);
  const all = (JSON.parse(r.findings) as Pick<Finding, "severity" | "evidence">[]).filter((f) => typeof f?.evidence === "string" && f.evidence);
  const findings = SEVERITIES.flatMap((sev) => all.filter((f) => PUBLIC_SEVERITY[f.severity] === sev).map((f) => ({ severity: sev, evidence: f.evidence })));
  const published = await publishedVideoForAudit(db, r.audit_id);
  const count = (sev: string) => findings.filter((f) => f.severity === sev).length;
  return {
    businessName: r.business_name, website: businessDomain({ domain: r.domain, website_url: r.website_url }) ?? "", auditedAt: r.audited_at, counts: { high: count("high"), medium: count("medium"), low: count("low") },
    findings, partial: r.partial === 1,
    sender: { name: r.your_name, businessName: r.sender_business, email: r.contact_email, logoUrl: r.logo_url.startsWith("https://") ? r.logo_url : "" },
    expiresAt: r.expires_at,
    video: published ? { durationMs: published.duration_ms ?? 0, aiVoiceNote: aiVoiceNote(r, published.plan) } : null,
    bookingUrl: bookingOn ? `${base}/r/${token}/book` : published && r.booking_url.startsWith("https://") ? r.booking_url : "",
  };
}
