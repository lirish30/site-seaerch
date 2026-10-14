import type { Settings } from "../types";
import { escapeHtml, parseSignature, renderSignatureHtml, renderSignatureText } from "./signature";

export interface Composable { subject: string; body: string; include_footer: boolean }
export interface ComposedEmail { subject: string; text: string; html: string }

/** Turns plain paragraphs into HTML. Bare URLs become links; everything else is escaped. */
export function bodyToHtml(body: string): string {
  const paragraphs = body.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  const linkify = (escaped: string) =>
    escaped.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" style="color:#1a56db">${u}</a>`);
  return paragraphs.map((p) => `<p style="margin:0 0 14px">${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`).join("");
}

/** The mailing footer lines to add: nothing when the draft opts out, and never a line the body already has. */
export function footerLines(s: Settings, body: string, include: boolean): string[] {
  if (!include) return [];
  return [s.physical_address, s.opt_out_line].map((l) => l?.trim()).filter((l): l is string => !!l && !body.includes(l));
}

/** The email as it will be sent or saved as a Gmail draft: body, then signature, then the optional footer. */
export function composeEmail(s: Settings, d: Composable): ComposedEmail {
  const body = d.body.trimEnd();
  const sig = parseSignature(s.signature_json);
  const sigText = sig ? renderSignatureText(sig) : s.signature.trim();
  const footer = footerLines(s, body, d.include_footer);
  const text = [body, sigText, footer.join("\n")].filter(Boolean).join("\n\n");

  const sigHtml = sig ? renderSignatureHtml(sig)
    : s.signature.trim() ? `<div style="margin-top:18px">${escapeHtml(s.signature.trim()).replace(/\n/g, "<br>")}</div>` : "";
  const footerHtml = footer.length
    ? `<div style="margin-top:22px;font-size:12px;line-height:1.5;color:#777">${footer.map(escapeHtml).join("<br>")}</div>` : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">${bodyToHtml(body)}${sigHtml}${footerHtml}</div>`;
  return { subject: d.subject, text, html };
}
