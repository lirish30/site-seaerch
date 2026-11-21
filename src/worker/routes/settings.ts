import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getSettings, saveSettings } from "../db/settings";
import { monthlySpend, monthUsage } from "../db/usage";
import { BookingConfigSchema, DEFAULT_CONFIG } from "../booking/config";
import { BillingConfigSchema, DEFAULT_BILLING_CONFIG } from "../billing/config";
import { DEFAULT_DOCUMENTS_CONFIG, DocumentsConfigSchema } from "../documents/config";
import { DEFAULT_WORK_CONFIG, WorkConfigSchema } from "../time/config";
import { DEFAULT_MONEY_CONFIG, MoneyConfigSchema } from "../money/config";
import { parseSignature, renderSignatureHtml, renderSignatureText, safeImageUrl, safeUrl } from "../email/signature";

// The logo is embedded in a public page, so only a plain https URL (or none) is accepted.
const logoUrl = z.string().trim().max(500).refine((v) => v === "" || (/^https:\/\/[^\s]+$/.test(v) && URL.canParse(v)));

// The booking link a video sends people to: https only, like the logo.
const bookingUrl = logoUrl;

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

// The availability document is stored as JSON text but checked as a BookingConfig, so a bad window or budget option never reaches the booking page.
const bookingConfig = z.string().max(8000).transform((v, ctx) => {
  if (!v.trim()) return "{}";
  let raw: unknown;
  try { raw = JSON.parse(v); } catch { ctx.addIssue({ code: "custom", message: "The availability settings are not valid JSON" }); return z.NEVER; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { ctx.addIssue({ code: "custom", message: "The availability settings are not valid" }); return z.NEVER; }
  const r = BookingConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...raw });
  if (!r.success) { ctx.addIssue({ code: "custom", message: r.error.issues[0].message }); return z.NEVER; }
  return JSON.stringify(r.data);
});

// Same for the proposal settings: checked as a DocumentsConfig, so a review date without a reviewer or an out-of-range expiry never gets stored.
const documentsConfig = z.string().max(2000).transform((v, ctx) => {
  if (!v.trim()) return "{}";
  let raw: unknown;
  try { raw = JSON.parse(v); } catch { ctx.addIssue({ code: "custom", message: "The document settings are not valid JSON" }); return z.NEVER; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { ctx.addIssue({ code: "custom", message: "The document settings are not valid" }); return z.NEVER; }
  const r = DocumentsConfigSchema.safeParse({ ...DEFAULT_DOCUMENTS_CONFIG, ...raw });
  if (!r.success) { ctx.addIssue({ code: "custom", message: r.error.issues[0].message }); return z.NEVER; }
  return JSON.stringify(r.data);
});

// And the work settings (cost rate, week start, timer cap): checked as a WorkConfig, so an out-of-range cap or rate never gets stored.
const workConfig = z.string().max(1000).transform((v, ctx) => {
  if (!v.trim()) return "{}";
  let raw: unknown;
  try { raw = JSON.parse(v); } catch { ctx.addIssue({ code: "custom", message: "The work settings are not valid JSON" }); return z.NEVER; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { ctx.addIssue({ code: "custom", message: "The work settings are not valid" }); return z.NEVER; }
  const r = WorkConfigSchema.safeParse({ ...DEFAULT_WORK_CONFIG, ...raw });
  if (!r.success) { ctx.addIssue({ code: "custom", message: r.error.issues[0].message }); return z.NEVER; }
  return JSON.stringify(r.data);
});

// The money settings (the freedom-number target): checked as a MoneyConfig, so a negative or fractional target never gets stored.
const moneyConfig = z.string().max(1000).transform((v, ctx) => {
  if (!v.trim()) return "{}";
  let raw: unknown;
  try { raw = JSON.parse(v); } catch { ctx.addIssue({ code: "custom", message: "The money settings are not valid JSON" }); return z.NEVER; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { ctx.addIssue({ code: "custom", message: "The money settings are not valid" }); return z.NEVER; }
  const r = MoneyConfigSchema.safeParse({ ...DEFAULT_MONEY_CONFIG, ...raw });
  if (!r.success) { ctx.addIssue({ code: "custom", message: r.error.issues[0].message }); return z.NEVER; }
  return JSON.stringify(r.data);
});

// The invoice terms and reminder ladder: checked as a BillingConfig, so a net term, reminder or pause that is out of range or out of order never gets stored. The message names the field.
const billingConfig = z.string().max(2000).transform((v, ctx) => {
  if (!v.trim()) return "{}";
  let raw: unknown;
  try { raw = JSON.parse(v); } catch { ctx.addIssue({ code: "custom", message: "The billing settings are not valid JSON" }); return z.NEVER; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { ctx.addIssue({ code: "custom", message: "The billing settings are not valid" }); return z.NEVER; }
  const r = BillingConfigSchema.safeParse({ ...DEFAULT_BILLING_CONFIG, ...raw });
  if (!r.success) {
    const i = r.error.issues[0];
    ctx.addIssue({ code: "custom", message: i.code === "custom" || i.path.length === 0 ? i.message : `${i.path.join(".")}: ${i.message}` });
    return z.NEVER;
  }
  return JSON.stringify(r.data);
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
  footer_freelance: z.number().int().min(0).max(1), attach_audit_pdf: z.number().int().min(0).max(1),
  booking_url: bookingUrl, ai_voice_note: z.number().int().min(0).max(1), booking_config: bookingConfig, documents_config: documentsConfig, work_config: workConfig, billing_config: billingConfig, money_config: moneyConfig,
}).partial();

export const settingsRoutes = new Hono<{ Bindings: Env }>();

settingsRoutes.get("/", async (c) => c.json({
  settings: await getSettings(c.env.DB), usage: await monthUsage(c.env.DB, new Date().toISOString().slice(0, 7)),
}));

// Estimated spend for each of the last six months, for the Usage chart.
settingsRoutes.get("/usage-history", async (c) => c.json({ months: await monthlySpend(c.env.DB, new Date().toISOString().slice(0, 7)) }));

settingsRoutes.put("/", async (c) => {
  const p = S.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) {
    // A booking_config, documents_config, work_config, billing_config or money_config problem says what is wrong ("A window must end after it starts"); every other field keeps the plain "invalid".
    const detail = p.error.issues.find((i) => i.path[0] === "booking_config" || i.path[0] === "documents_config" || i.path[0] === "work_config" || i.path[0] === "billing_config" || i.path[0] === "money_config")?.message;
    return c.json({ error: detail ?? "invalid", fields: [...new Set(p.error.issues.filter((i) => i.path.length).map((i) => String(i.path[0])))] }, 400);
  }
  return c.json(await saveSettings(c.env.DB, p.data));
});

// Renders a signature exactly as it will appear in an email, without saving it. Unsafe links and images are simply left out.
settingsRoutes.post("/signature-preview", async (c) => {
  const { signature_json } = await c.req.json<{ signature_json?: unknown }>().catch(() => ({ signature_json: undefined }));
  const sig = typeof signature_json === "string" ? parseSignature(signature_json) : null;
  return c.json(sig ? { html: renderSignatureHtml(sig), text: renderSignatureText(sig) } : { html: "", text: "" });
});
