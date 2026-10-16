import type { Service, Suppression } from "./types";
import type { WorkSample } from "./emailView";
import { readSignature } from "./emailView";

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
/** "Two more samples with results would give full-time drafts more to choose from." */
export const samplesNudge = (needed: number) =>
  `${NUMBER_WORD[needed] ?? needed} more sample${needed === 1 ? "" : "s"} with ${needed === 1 ? "a result" : "results"} would give full-time drafts more to choose from.`;

type Doc = Record<string, string | number>;
const has = (d: Doc, k: string) => String(d[k] ?? "").trim() !== "";

export const profileMissing = (d: Doc) => [["your_name", "your name"], ["business_name", "your business name"], ["contact_email", "a contact email"]].filter(([k]) => !has(d, k)).map(([, w]) => w);
export const jobMissing = (d: Doc) => [["role_title", "your role"], ["bio", "a short bio"], ["goal_line", "what you're looking for"]].filter(([k]) => !has(d, k)).map(([, w]) => w);
export const hasBuiltSignature = (d: Doc) => { const s = readSignature(String(d.signature_json ?? "")); return !!(s.name.trim() || s.email.trim() || s.links.some((l) => l.url.trim())); };

export interface SetupItem { key: string; done: boolean; to: string; action: string; need: string }
export interface SetupInput { doc: Doc; samples: WorkSample[]; services: Service[] }

/** The seven things that make drafts better, in the order they are suggested. */
export function setupItems({ doc, samples, services }: SetupInput): SetupItem[] {
  return [
    { key: "profile", done: profileMissing(doc).length === 0, to: "/settings/profile", action: "Finish profile", need: "your name, business and contact email" },
    { key: "offer", done: has(doc, "services_blurb"), to: "/settings/profile", action: "Add what you offer", need: "a line about what you offer" },
    { key: "job", done: jobMissing(doc).length === 0, to: "/settings/job-search", action: "Finish job search", need: "your role, bio and what you're looking for" },
    { key: "resume", done: has(doc, "resume_url"), to: "/settings/job-search", action: "Add resume link", need: "a resume link" },
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
  return `Add ${list}. Full-time emails link only to your samples.`;
}

export const suppressionWord = (rows: Suppression[]) =>
  rows.every((r) => r.kind === "domain") ? `${rows.length} domain${rows.length === 1 ? "" : "s"}` : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`;
