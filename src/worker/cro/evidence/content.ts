import type { Business } from "../../types";
import type { CapturedPage, EvidenceDraft } from "../types";
import { base, isShell } from "./layout";

const GENERIC = ["welcome to our website", "quality service", "competitive prices", "customer satisfaction", "one-stop shop", "second to none",
  "state of the art", "best in class", "top notch", "your satisfaction is our", "look no further"];
const has = (text: string, phrase: string) => new RegExp(`\\b${phrase.replace(/[-\s]+/g, "[-\\s]+")}\\b`).test(text);
const WE = /\b(we|our|us)\b/g;
const US_ACTION = /\b(contact|about|call|email|join|visit|text)\s+us\b/g;

export function cityOf(address: string | null): string | null {
  const parts = (address ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 2] : null;
}

export function copyEvidence(p: CapturedPage, business: Business): EvidenceDraft[] {
  const s = p.desktop;
  if (!s || !["home", "services"].includes(p.kind)) return [];
  const out: EvidenceDraft[] = [];
  const add = (fact: string, data?: Record<string, unknown>) => out.push({ ...base(p), family: "copy", device: "desktop", fact, ...(data ? { data } : {}) });
  if (s.h1.length) add(`H1 headline: "${s.h1[0]}"`);
  else if (!isShell(s)) add("No H1 headline on this page");
  if (s.heroText) add(`Text visible before scrolling: "${s.heroText.slice(0, 300)}"`);
  const lower = s.text.toLowerCase();
  const generic = GENERIC.filter((g) => has(lower, g));
  if (generic.length) add(`Generic phrases used: ${generic.map((g) => `"${g}"`).join(", ")}`);
  const we = (lower.replace(US_ACTION, " ").match(WE) ?? []).length, you = (lower.match(/\b(you|your)\b/g) ?? []).length;
  if (we > Math.max(3, you * 1.5)) add(`Copy talks about the business more than the customer ("we/our" ${we}× vs "you/your" ${you}×)`, { we, you });
  const city = cityOf(business.address);
  if (p.index === 0 && city && !isShell(s) && !`${s.h1.join(" ")} ${s.title}`.toLowerCase().includes(city.toLowerCase()))
    add(`"${city}" is not in the headline or page title`);
  return out;
}
