import type { Finding } from "../types";

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

export async function activeReportFor(db: D1Database, businessId: string, auditId: string, now = new Date()): Promise<ReportRow | null> {
  return db.prepare(
    `SELECT * FROM audit_reports WHERE business_id = ? AND audit_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(businessId, auditId, now.toISOString()).first<ReportRow>();
}

export async function revokeReports(db: D1Database, businessId: string): Promise<void> {
  await db.prepare(`UPDATE audit_reports SET revoked = 1 WHERE business_id = ?`).bind(businessId).run();
}

export interface PublicReport {
  businessName: string; auditedAt: string; counts: { high: number; medium: number; low: number };
  findings: { severity: Finding["severity"]; evidence: string }[]; partial: boolean;
  sender: { name: string; businessName: string; email: string; logoUrl: string }; expiresAt: string;
}

const SEVERITIES = ["high", "medium", "low"] as const;

/** The ONLY shape exposed publicly. Fields are copied one by one so nothing else can leak in by accident. */
export async function publicReport(db: D1Database, token: string, now = new Date()): Promise<PublicReport | null> {
  const r = await db.prepare(
    `SELECT b.name AS business_name, a.created_at AS audited_at, a.partial AS partial, a.findings AS findings, r.expires_at AS expires_at,
            s.your_name AS your_name, s.business_name AS sender_business, s.contact_email AS contact_email, s.logo_url AS logo_url
     FROM audit_reports r JOIN audits a ON a.id = r.audit_id JOIN businesses b ON b.id = r.business_id JOIN settings s ON s.id = 1
     WHERE r.token = ? AND r.revoked = 0 AND r.expires_at > ?`,
  ).bind(token, now.toISOString()).first<{ business_name: string; audited_at: string; partial: number; findings: string; expires_at: string;
    your_name: string; sender_business: string; contact_email: string; logo_url: string }>();
  if (!r) return null;
  const all = JSON.parse(r.findings) as Finding[];
  const findings = SEVERITIES.flatMap((sev) => all.filter((f) => f.severity === sev).map((f) => ({ severity: sev, evidence: f.evidence })));
  const count = (sev: string) => findings.filter((f) => f.severity === sev).length;
  return {
    businessName: r.business_name, auditedAt: r.audited_at, counts: { high: count("high"), medium: count("medium"), low: count("low") },
    findings, partial: r.partial === 1,
    sender: { name: r.your_name, businessName: r.sender_business, email: r.contact_email, logoUrl: r.logo_url.startsWith("https://") ? r.logo_url : "" },
    expiresAt: r.expires_at,
  };
}
