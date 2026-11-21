import tls from "node:tls";
import type { JobHandler } from "../loop.ts";
import { payloadOf } from "./clone.ts";

const MAX_HOSTS = 500;
const AT_A_TIME = 5;
const TIMEOUT_MS = 10_000;
/** The same pattern the Worker checks: a plain DNS name with a letter-only last label, so an IP literal never matches. */
const HOST = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

export interface CertSocket {
  once(event: string, fn: (...args: any[]) => void): unknown;
  getPeerCertificate(): { valid_to?: string };
  destroy(): unknown;
}
export type CertConnect = (o: { host: string; port: number; servername: string; rejectUnauthorized: boolean; timeout: number }) => CertSocket;

const realConnect: CertConnect = (o) => tls.connect(o) as unknown as CertSocket;

/** "Dec 11 23:59:59 2026 GMT" as YYYY-MM-DD in UTC, or null for anything else. */
export function isoDate(validTo: unknown): string | null {
  if (typeof validTo !== "string") return null;
  const t = new Date(validTo).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Never a name this Mac should connect to: an IP literal, a name that is not a plain DNS name, or a .local/.internal one. */
const connectable = (host: string): boolean => HOST.test(host) && !/\.(local|internal)$/i.test(host);

/** One host's certificate expiry date, or null (refused, connection error, timeout, no date). The certificate is read, not trusted: an expired or self-signed one is still read. */
function expiryOf(host: string, connect: CertConnect): Promise<string | null> {
  if (!connectable(host)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let sock: CertSocket | undefined;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock?.destroy(); } catch { /* already closed */ }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), TIMEOUT_MS + 1_000);
    try {
      sock = connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: TIMEOUT_MS });
      sock.once("secureConnect", () => { try { done(isoDate(sock!.getPeerCertificate().valid_to)); } catch { done(null); } });
      sock.once("error", () => done(null));
      sock.once("timeout", () => done(null));
    } catch { done(null); }
  });
}

/** Reads the TLS certificate expiry of each host (at most 500, five at a time). Read-only: it connects, reads the certificate and hangs up; no request is sent. */
export function careCertsHandler(connect: CertConnect = realConnect): JobHandler {
  return {
    kind: "care.certs",
    async run({ job }) {
      const hosts = payloadOf(job).hosts;
      if (!Array.isArray(hosts)) throw new Error("the job has no hosts");
      const rows = hosts.slice(0, MAX_HOSTS).map((h) => {
        const o = (h && typeof h === "object" ? h : {}) as Record<string, unknown>;
        return { siteId: typeof o.siteId === "string" ? o.siteId : "", host: typeof o.host === "string" ? o.host.trim().toLowerCase() : "" };
      }).filter((r) => r.siteId);
      const certs: { siteId: string; validTo: string | null }[] = new Array(rows.length);
      let next = 0;
      const worker = async () => {
        for (let i = next++; i < rows.length; i = next++) certs[i] = { siteId: rows[i].siteId, validTo: await expiryOf(rows[i].host, connect) };
      };
      await Promise.all(Array.from({ length: Math.min(AT_A_TIME, rows.length) }, worker));
      return { certs };
    },
  };
}
