import type { ChangeOrderStatus } from "../worker/db/changeOrders";
import { dollars } from "./packagesView";
import type { Tone } from "./projectView";

/** Pure helpers for the change-order panel. No DOM, no fetch. */

const LABEL: Record<Exclude<ChangeOrderStatus, "signed">, string> = {
  draft: "Draft", sent: "Waiting for client", viewed: "Viewed", declined: "Declined", expired: "Expired", void: "Void",
};

/** What the chip says. A signed order is not finished until the money is in: its tasks stay locked until then. */
export function statusLabel(s: ChangeOrderStatus, paid: boolean): string {
  if (s === "signed") return paid ? "Signed and paid, work unlocked" : "Signed, waiting for payment";
  return LABEL[s];
}

export function statusTone(s: ChangeOrderStatus, paid: boolean): Tone {
  if (s === "signed") return paid ? "good" : "warn";
  return s === "draft" || s === "sent" || s === "viewed" ? "neutral" : "muted";
}

/** A draft, sent, viewed, declined or expired order can be voided; a signed one is a record and a void one is already void. */
export const voidable = (s: ChangeOrderStatus): boolean => s !== "signed" && s !== "void";

/** "1 hour", "0.25 hours", "2.5 hours". */
export const hoursText = (h: number): string => `${h} ${h === 1 ? "hour" : "hours"}`;

/** The price the order will carry, from the hours and the rate unless a price is given, and the sentence that shows the sum. A price equal to the sum is not a custom price. */
export function pricePreview(hours: number, rateCents: number, override: number | null): { priceCents: number; custom: boolean; line: string } {
  const computed = Math.round(hours * rateCents);
  const sum = `${hoursText(hours)} at ${dollars(rateCents)} an hour`;
  if (override === null || override === computed) return { priceCents: computed, custom: false, line: `${sum} is ${dollars(computed)}` };
  return { priceCents: override, custom: true, line: `${sum} would be ${dollars(computed)}; your price is ${dollars(override)} (custom)` };
}

/** What to remind the owner about the rate for a client on Care (`care.altPriceCents`, from the package catalog). Null when there is no Care rate or it is the same as the standard one. */
export function careRateHint(careAltCents: number | null, hourlyCents: number): string | null {
  if (careAltCents === null || careAltCents === hourlyCents) return null;
  return `Care clients pay ${dollars(careAltCents)} an hour (the standard rate is ${dollars(hourlyCents)}).`;
}

/** The signed record the owner reads: who signed, when, and the first characters of the hash that seals the text. Null for an order nobody has signed. */
export function signedRecord(co: { signerName: string | null; signedAt: string | null; contentSha256: string | null }): { name: string; signedAt: string; hashPrefix: string } | null {
  if (!co.signerName || !co.signedAt) return null;
  return { name: co.signerName, signedAt: co.signedAt, hashPrefix: (co.contentSha256 ?? "").slice(0, 12) };
}

/** Hours typed in a box, in steps of a quarter hour from 0.25 to 200; null for anything else. */
export function parseHoursInput(raw: string): number | null {
  const v = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const h = Number(v);
  return h >= 0.25 && h <= 200 && Number.isInteger(h * 4) ? h : null;
}

/** Days of schedule impact typed in a box: null when left blank (no impact stated), a whole number from 0 to 180, or undefined for anything else. */
export function parseDaysInput(raw: string): number | null | undefined {
  const v = raw.trim();
  if (v === "") return null;
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n <= 180 ? n : undefined;
}

/** A list typed one item per line: trimmed, blank lines dropped. */
export const linesOf = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
