import type { Service, Suppression } from "./types";
import type { WorkSample } from "./emailView";
import { readSignature } from "./emailView";
import { readConfig } from "./bookingView";
import { DEFAULT_DOCUMENTS_CONFIG, legalGate, type DocumentsConfig } from "../worker/documents/config";

/** The same rule the worker applies to links in emails: http(s) only, and a bare "example.com" gets https. */
export function safeLink(raw: string): string {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : /^[^/.]+\.[^/]+/.test(v) ? `https://${v}` : "";
  if (!withScheme || !URL.canParse(withScheme)) return "";
  const u = new URL(withScheme);
  return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
}
export const isHttps = (raw: string) => /^https:\/\/[^\s]+$/.test(raw.trim()) && URL.canParse(raw.trim());

/** "https://www.riversidedental.com/work/" -> "riversidedental.com/work" for showing a link compactly. */
export const prettyLink = (url: string) => url.trim().replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

export const TONES = [
  { value: "friendly_local", label: "Friendly local", hint: "Warm, plain and neighborly. Sounds like you." },
  { value: "consultative", label: "Consultative expert", hint: "Calm and specific. A bit more formal." },
  { value: "direct", label: "Direct & short", hint: "Gets to the point in a few sentences." },
  { value: "formal", label: "Formal", hint: "Polished, no slang, no contractions." },
] as const;
export const LENGTHS = [
  { value: "short", label: "Short", words: "≈120 words" }, { value: "medium", label: "Medium", words: "≈180 words" }, { value: "long", label: "Long", words: "≈250 words" },
] as const;
export const CTAS = [
  { value: "mini_audit", label: "Receive their free audit report" }, { value: "call", label: "Book a 10-minute call" },
  { value: "reply", label: "Reply yes or no" }, { value: "proposal", label: "Receive a proposal with prices" },
] as const;

/** "Friendly local · Short" for the overview card. */
export function voiceSummary(tone: string, length: string): string {
  const t = TONES.find((x) => x.value === tone)?.label ?? TONES[0].label;
  const l = LENGTHS.find((x) => x.value === length)?.label ?? LENGTHS[0].label;
  return `${t} · ${l}`;
}

/** The design asks for eight samples so a draft has a real choice of what fits each company. */
export const TARGET_SAMPLES = 8;
/** How many more samples would give drafts enough to choose from (0 when there are enough). */
export const samplesNeeded = (samples: WorkSample[]) => Math.max(0, TARGET_SAMPLES - samples.length);
const NUMBER_WORD = ["No", "One", "Two", "Three"];
/** "Two more samples with results would give drafts more to choose from." */
export const samplesNudge = (needed: number) =>
  `${NUMBER_WORD[needed] ?? needed} more sample${needed === 1 ? "" : "s"} with ${needed === 1 ? "a result" : "results"} would give drafts more to choose from.`;

type Doc = Record<string, string | number>;
const has = (d: Doc, k: string) => String(d[k] ?? "").trim() !== "";

export const profileMissing = (d: Doc) => [["your_name", "your name"], ["business_name", "your business name"], ["contact_email", "a contact email"]].filter(([k]) => !has(d, k)).map(([, w]) => w);
export const hasBuiltSignature = (d: Doc) => { const s = readSignature(String(d.signature_json ?? "")); return !!(s.name.trim() || s.email.trim() || s.links.some((l) => l.url.trim())); };

export interface SetupItem { key: string; done: boolean; to: string; action: string; need: string }
export interface SetupInput { doc: Doc; samples: WorkSample[]; services: Service[] }

/** The five things that make drafts better, in the order they are suggested. */
export function setupItems({ doc, samples, services }: SetupInput): SetupItem[] {
  return [
    { key: "profile", done: profileMissing(doc).length === 0, to: "/settings/profile", action: "Finish profile", need: "your name, business and contact email" },
    { key: "offer", done: has(doc, "services_blurb"), to: "/settings/profile", action: "Add what you offer", need: "a line about what you offer" },
    { key: "signature", done: hasBuiltSignature(doc), to: "/settings/signature", action: "Build signature", need: "an email signature" },
    { key: "samples", done: samplesNeeded(samples) === 0, to: "/settings/work-samples", action: "Add work samples", need: "" },
    { key: "services", done: services.some((s) => s.active), to: "/settings/services", action: "Choose services", need: "at least one active service" },
  ];
}

/** The banner sentence: what is still missing, in the setup order. */
export function setupSentence(items: SetupItem[], samples: WorkSample[]): string {
  const n = samplesNeeded(samples);
  const needs = items.filter((i) => !i.done).map((i) => (i.key === "samples" ? `${(NUMBER_WORD[n] ?? String(n)).toLowerCase()} more work sample${n === 1 ? "" : "s"}` : i.need));
  if (!needs.length) return "";
  const shown = needs.length > 3 ? [...needs.slice(0, 2), `${needs.length - 2} more things`] : needs;
  const list = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  return `Add ${list}.`;
}

export const suppressionWord = (rows: Suppression[]) =>
  rows.every((r) => r.kind === "domain") ? `${rows.length} domain${rows.length === 1 ? "" : "s"}` : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`;

/** The overview chip for the Booking page: no windows means nobody can book a call yet, and the booking page says so. */
export function bookingSummary(raw: string): { tone: "warning" | "positive"; text: string } {
  const n = readConfig(raw).windows.length;
  return n === 0 ? { tone: "warning", text: "No hours set" } : { tone: "positive", text: `${n} weekly ${n === 1 ? "window" : "windows"}` };
}

/** The documents settings as the page edits them: missing keys take their default, and a half-finished edit is kept as typed (the worker is what refuses it). */
export function readDocumentsDraft(raw: string): DocumentsConfig {
  try { const v = JSON.parse(raw || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? { ...DEFAULT_DOCUMENTS_CONFIG, ...v } : DEFAULT_DOCUMENTS_CONFIG; } catch { return DEFAULT_DOCUMENTS_CONFIG; }
}

/** What stops a save: a review recorded without a name, or a number out of range. Null when the page can save. */
export function documentsProblem(c: DocumentsConfig): string | null {
  if (c.legalReviewedAt !== null && !c.legalReviewer.trim()) return "Name who reviewed the clauses";
  if (!(c.lateFeePercentMonthly >= 0 && c.lateFeePercentMonthly <= 10)) return "The late fee must be between 0% and 10% a month";
  if (!Number.isInteger(c.expiryDays) || c.expiryDays < 7 || c.expiryDays > 90) return "A proposal must stay open between 7 and 90 days";
  return null;
}

/** The overview chip for the Documents page: until a lawyer's review is recorded, no proposal can be sent to a client. */
export function documentsSummary(raw: string): { tone: "warning" | "positive"; text: string } {
  const c = readDocumentsDraft(raw);
  return legalGate(c) ? { tone: "warning", text: "Not lawyer-reviewed" } : { tone: "positive", text: `Reviewed ${c.legalReviewedAt!.slice(0, 10)}` };
}
