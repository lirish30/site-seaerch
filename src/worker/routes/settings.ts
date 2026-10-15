import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getSettings, saveSettings } from "../db/settings";
import { monthUsage } from "../db/usage";
import { ROLE_KINDS } from "../types";
import { parseKindOrder } from "../jobs/select";
import { parseSignature, renderSignatureHtml, renderSignatureText, safeImageUrl, safeUrl } from "../email/signature";

// The logo is embedded in a public page, so only a plain https URL (or none) is accepted.
const logoUrl = z.string().trim().max(500).refine((v) => v === "" || (/^https:\/\/[^\s]+$/.test(v) && URL.canParse(v)));

const optionalUrl = z.string().trim().max(500).refine((v) => v === "" || safeUrl(v) !== "");

// The signature is stored in its cleaned form (links normalised, bad entries dropped), but a URL the sender typed that
// we would drop is an error, so a mistyped link never disappears silently.
const signatureJson = z.string().max(6000).transform((v, ctx) => {
  if (!v.trim()) return "";
  let raw: any;
  try { raw = JSON.parse(v); } catch { ctx.addIssue({ code: "custom", message: "invalid" }); return z.NEVER; }
  const bad = (u: unknown, img = false) => typeof u === "string" && u.trim() !== "" && (img ? !safeImageUrl(u) : !safeUrl(u));
  if (bad(raw?.image_url, true) || bad(raw?.image_link) || bad(raw?.website) || (Array.isArray(raw?.links) && raw.links.some((l: any) => bad(l?.url)))) {
    ctx.addIssue({ code: "custom", message: "invalid" }); return z.NEVER;
  }
  const sig = parseSignature(v);
  return sig ? JSON.stringify(sig) : "";
});

const S = z.object({
  your_name: z.string().max(200), business_name: z.string().max(200), contact_email: z.string().max(200),
  services_blurb: z.string().max(2000), signature: z.string().max(1000), physical_address: z.string().max(500),
  opt_out_line: z.string().max(500), tone_notes: z.string().max(5000), monthly_spend_limit_usd: z.number().min(0).max(10000),
  tone_preset: z.enum(["friendly_local", "consultative", "direct", "formal"]),
  email_length: z.enum(["short", "medium", "long"]), cta_style: z.enum(["mini_audit", "call", "reply", "proposal"]),
  logo_url: logoUrl,
  role_title: z.string().max(200), bio: z.string().max(2000), availability: z.string().max(300),
  resume_url: optionalUrl, goal_line: z.string().max(500), signature_json: signatureJson,
  default_purpose: z.enum(["full_time", "freelance"]),
  // Stored whole (every kind, best first) so what the owner sees is what ranks.
  role_kind_order: z.string().max(100).refine((v) => v.split(",").every((k) => (ROLE_KINDS as readonly string[]).includes(k.trim()))).transform((v) => parseKindOrder(v).join(",")),
}).partial();

export const settingsRoutes = new Hono<{ Bindings: Env }>();

settingsRoutes.get("/", async (c) => c.json({
  settings: await getSettings(c.env.DB), usage: await monthUsage(c.env.DB, new Date().toISOString().slice(0, 7)),
}));

settingsRoutes.put("/", async (c) => {
  const p = S.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid", fields: [...new Set(p.error.issues.filter((i) => i.path.length).map((i) => String(i.path[0])))] }, 400);
  return c.json(await saveSettings(c.env.DB, p.data));
});

// Renders a signature exactly as it will appear in an email, without saving it. Unsafe links and images are simply left out.
settingsRoutes.post("/signature-preview", async (c) => {
  const { signature_json } = await c.req.json<{ signature_json?: unknown }>().catch(() => ({ signature_json: undefined }));
  const sig = typeof signature_json === "string" ? parseSignature(signature_json) : null;
  return c.json(sig ? { html: renderSignatureHtml(sig), text: renderSignatureText(sig) } : { html: "", text: "" });
});
