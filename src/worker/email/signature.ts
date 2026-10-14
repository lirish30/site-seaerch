import type { Signature } from "../types";

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A link target safe to put in an email: http(s) only. A bare "example.com" gets https. Anything else is dropped. */
export function safeUrl(raw: string | undefined | null): string {
  const v = (raw ?? "").trim();
  if (!v || /\s/.test(v)) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : /^[^/.]+\.[^/]+/.test(v) ? `https://${v}` : "";
  if (!withScheme || !URL.canParse(withScheme)) return "";
  const u = new URL(withScheme);
  return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
}

/** Images must be https: mail clients block or warn on anything else. */
export const safeImageUrl = (raw: string | undefined | null) => {
  const u = safeUrl(raw);
  return u.startsWith("https://") ? u : "";
};

export const EMPTY_SIGNATURE: Signature = { name: "", title: "", email: "", phone: "", website: "", links: [], image_url: "", image_link: "", image_width: 96 };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Reads the stored JSON back into a clean Signature; null when nothing is set. Never throws on bad data. */
export function parseSignature(json: string | null | undefined): Signature | null {
  if (!json?.trim()) return null;
  let raw: any;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const links = (Array.isArray(raw.links) ? raw.links : []).slice(0, 8)
    .map((l: any) => ({ label: str(l?.label, 60), url: safeUrl(str(l?.url, 500)) }))
    .filter((l: { label: string; url: string }) => l.url);
  const width = Number(raw.image_width);
  const sig: Signature = {
    name: str(raw.name, 120), title: str(raw.title, 160), email: str(raw.email, 200), phone: str(raw.phone, 60),
    website: safeUrl(str(raw.website, 500)), links,
    image_url: safeImageUrl(str(raw.image_url, 500)), image_link: safeUrl(str(raw.image_link, 500)),
    image_width: Number.isFinite(width) ? Math.min(300, Math.max(40, Math.round(width))) : 96,
  };
  const empty = !sig.name && !sig.title && !sig.email && !sig.phone && !sig.website && !sig.links.length && !sig.image_url;
  return empty ? null : sig;
}

const prettyUrl = (u: string) => u.replace(/^https?:\/\//i, "").replace(/\/$/, "");
const a = (href: string, text: string) => `<a href="${escapeHtml(href)}" style="color:#1a56db;text-decoration:none">${escapeHtml(text)}</a>`;

/** Table layout with inline styles: the only thing every mail client renders the same way. */
export function renderSignatureHtml(sig: Signature): string {
  const image = sig.image_url
    ? `<td style="vertical-align:top;padding-right:14px">${sig.image_link ? `<a href="${escapeHtml(sig.image_link)}">` : ""}<img src="${escapeHtml(sig.image_url)}" width="${sig.image_width}" alt="${escapeHtml(sig.name || "Logo")}" style="display:block;border:0;width:${sig.image_width}px;max-width:${sig.image_width}px;height:auto">${sig.image_link ? "</a>" : ""}</td>`
    : "";
  const contact = [
    sig.email && a(`mailto:${sig.email}`, sig.email),
    sig.phone && escapeHtml(sig.phone),
    sig.website && a(sig.website, prettyUrl(sig.website)),
  ].filter(Boolean).join(` <span style="color:#999">&middot;</span> `);
  const links = sig.links.map((l) => a(l.url, l.label || prettyUrl(l.url))).join(` <span style="color:#999">|</span> `);
  const lines = [
    sig.name && `<div style="font-weight:bold;font-size:15px;color:#111">${escapeHtml(sig.name)}</div>`,
    sig.title && `<div style="color:#555">${escapeHtml(sig.title)}</div>`,
    contact && `<div style="margin-top:6px">${contact}</div>`,
    links && `<div style="margin-top:2px">${links}</div>`,
  ].filter(Boolean).join("");
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#222;margin-top:18px"><tr>${image}<td style="vertical-align:top">${lines}</td></tr></table>`;
}

export function renderSignatureText(sig: Signature): string {
  return [
    sig.name, sig.title,
    [sig.email, sig.phone, sig.website && prettyUrl(sig.website)].filter(Boolean).join(" · "),
    ...sig.links.map((l) => (l.label ? `${l.label}: ${l.url}` : l.url)),
  ].filter(Boolean).join("\n");
}
