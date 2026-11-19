import type { ItemStatus } from "../worker/db/onboardings";
import { SILENCE_DAYS, type Stage } from "../worker/onboarding/schedule";
import { checkVideoUrl } from "../worker/onboarding/ownerChecks";

/** Pure helpers for the owner's Onboarding panel on the Deal page. No DOM, no fetch, no clock of its own. */

/** Said in the panel as it is, so every timeline the owner promises carries a margin for the client's own delays. */
export const PLAN_FOR_DELAYS = "Plan for client delays of 15–25% in every timeline (spec §9.5)";

const STAGE_LABEL: Record<Stage, string> = {
  welcome: "Welcome not sent",
  questionnaire: "Questionnaire",
  collecting: "Collecting",
  waiting_on_client: "Waiting on the client",
  complete: "Complete",
};
export const stageLabel = (s: Stage): string => STAGE_LABEL[s];

/** `good` is done, `warn` is a client who has gone quiet long enough for the contract's clause; the rest is ordinary work in progress. */
export const stageTone = (s: Stage): "neutral" | "good" | "warn" => (s === "complete" ? "good" : s === "waiting_on_client" ? "warn" : "neutral");

const STATUS_LABEL: Record<ItemStatus, string> = { waiting: "Waiting", received: "Received", accepted: "Accepted", not_applicable: "Not needed" };
export const statusLabel = (s: ItemStatus): string => STATUS_LABEL[s];

const GROUP: Record<ItemStatus, number> = { waiting: 0, received: 1, accepted: 2, not_applicable: 2 };

/** The checklist in the order the owner works it: what is waiting on the client, then what has come in and needs a look, then what is done. Each group keeps the checklist's own order. */
export function itemRows<T extends { status: ItemStatus; position: number }>(items: T[]): T[] {
  return items.map((item, i) => ({ item, i })).sort((a, b) => GROUP[a.item.status] - GROUP[b.item.status] || a.item.position - b.item.position || a.i - b.i).map((x) => x.item);
}

export interface ItemAction { status: "accepted" | "not_applicable" | "waiting"; label: string }

/** The buttons for an item. Accept is for something that has come in; Ask again reopens an item (the client cannot add to one that was accepted until it is reopened). */
export function itemActions(status: ItemStatus): ItemAction[] {
  const out: ItemAction[] = [];
  if (status === "received") out.push({ status: "accepted", label: "Accept" });
  if (status !== "not_applicable") out.push({ status: "not_applicable", label: "Not needed" });
  if (status !== "waiting") out.push({ status: "waiting", label: "Ask again" });
  return out;
}

/** "No reply for 9 days. The back-of-queue clause applies at 14." and, from the 14th day, "... applies now." */
export function silenceNote(days: number): string {
  if (days <= 0) return "The client was in touch today.";
  const reply = `No reply for ${days} ${days === 1 ? "day" : "days"}.`;
  return days >= SILENCE_DAYS ? `${reply} The back-of-queue clause applies now.` : `${reply} The back-of-queue clause applies at ${SILENCE_DAYS}.`;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export interface WelcomeLine { kind: "sent" | "pending" | "none"; text: string; canRequest: boolean }

/** Where the welcome mail stands: sent, waiting for the owner's approval (on Home), or not asked for (or turned down), which can be asked for again until the onboarding is closed. */
export function welcomeLine(o: { welcomeSentAt: string | null; closedAt: string | null }, approval: { id: string; status: string } | null): WelcomeLine {
  if (o.welcomeSentAt) return { kind: "sent", text: `Welcome sent ${when(o.welcomeSentAt)}.`, canRequest: false };
  if (approval?.status === "pending") return { kind: "pending", text: "The welcome is waiting for your approval. Add the video link below first if you want one in it.", canRequest: false };
  if (approval?.status === "approved") return { kind: "pending", text: "The welcome is approved and on its way.", canRequest: false };
  return { kind: "none", text: approval ? "The welcome was turned down and nothing has gone out." : "No welcome is waiting.", canRequest: !o.closedAt };
}

/** Why a typed video link would be refused (the same check the server makes), or null when it is fine or blank. */
export function videoProblem(raw: string): string | null {
  const r = checkVideoUrl(raw);
  return r.ok ? null : r.error;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant as the value of a `datetime-local` field, in the browser's own zone; "" for none. */
export function kickoffToInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The instant a `datetime-local` value means (null for blank, "invalid" for anything that is not a time). */
export function kickoffFromInput(value: string): string | null | "invalid" {
  if (!value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "invalid" : d.toISOString();
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
