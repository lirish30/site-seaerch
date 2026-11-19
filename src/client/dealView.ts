import { STAGE_ORDER, type Deal } from "../worker/db/deals";
import type { Package } from "../worker/db/packages";
import { hasNotes, type DiscoveryNotes } from "../worker/sales/notes";
import { optionTotals, type Option } from "../worker/sales/options";
import { dollars, formatPrice, parseDollars } from "./packagesView";

const at = (s: Deal["stage"]) => STAGE_ORDER.indexOf(s);

/**
 * What is left to do on a deal, in order, each with whether it is done. Before the call there is only the call. After it: write the notes, then draft the
 * recap (once the notes exist), then offer two times (once there is a recap), then present the recommendation (once the meeting is booked). A closed deal has none.
 */
export function nextActions(d: Pick<Deal, "stage" | "skipCall" | "notes" | "recap">): { label: string; done: boolean }[] {
  if (d.stage === "won" || d.stage === "lost") return [];
  if (d.stage === "booked") return [{ label: "Hold the discovery call", done: false }];
  const out: { label: string; done: boolean }[] = [];
  const written = hasNotes(d.notes);
  out.push({ label: "Write notes", done: written });
  if (written) out.push({ label: "Draft recap", done: d.recap !== null });
  if (d.recap !== null) out.push({ label: "Offer two times", done: at(d.stage) >= at("recommendation_booked") });
  if (at(d.stage) >= at("recommendation_booked")) out.push({ label: "Present the recommendation", done: at(d.stage) >= at("recommended") });
  return out;
}

/** One option for the screen: each package with its catalog price, and the up-front and monthly totals (null when there is none). */
export function optionSummary(option: Option, catalog: Package[]): { items: string[]; upfront: string | null; monthly: string | null } {
  const t = optionTotals(option, catalog);
  return {
    items: option.items.map((i) => {
      const p = catalog.find((c) => c.key === i.key);
      if (!p) return `${i.key}: not in the catalog`;
      return `${p.name}: ${formatPrice(p)}${i.setupDiscountCents ? ` (less ${dollars(i.setupDiscountCents)} off setup)` : ""}`;
    }),
    upfront: t.upfrontCents > 0 ? dollars(t.upfrontCents) : null,
    monthly: t.monthlyCents > 0 ? `${dollars(t.monthlyCents)}/mo` : null,
  };
}

/** The Notes tab's boxes, all text, as typed. */
export interface NotesForm {
  /** Ten answers, index 0 to 9 for questions 1 to 10. */
  answers: string[]; goals: string[]; currentState: string[]; avgJob: string; missed: string; platform: DiscoveryNotes["platform"]; decisionMakers: string;
}

export function formOf(n: DiscoveryNotes | null): NotesForm {
  const pad = (a: string[]) => [...a, "", "", ""].slice(0, 3);
  return {
    answers: Array.from({ length: 10 }, (_, i) => n?.answers.find((a) => a.n === i + 1)?.text ?? ""),
    goals: pad(n?.goals ?? []), currentState: pad(n?.currentState ?? []),
    avgJob: n?.avgJobValueCents == null ? "" : String(n.avgJobValueCents / 100), missed: n?.missedJobsPerMonth == null ? "" : String(n.missedJobsPerMonth),
    platform: n?.platform ?? "other", decisionMakers: n?.decisionMakers ?? "",
  };
}

/** The boxes as notes to save: blank ones are left out, a blank owner number is `null` (never a guess). `callHeldAt` is the server's, so it is passed through. */
export function notesOf(f: NotesForm, callHeldAt: string | null): { ok: true; notes: DiscoveryNotes } | { ok: false; error: string } {
  const avg = f.avgJob.trim() === "" ? null : parseDollars(f.avgJob);
  if (avg === null && f.avgJob.trim() !== "") return { ok: false, error: "Average job: type a dollar amount, like 400." };
  const missed = f.missed.trim() === "" ? null : /^\d+$/.test(f.missed.trim()) ? Number(f.missed.trim()) : NaN;
  if (Number.isNaN(missed)) return { ok: false, error: "Missed jobs a month: type a whole number." };
  const list = (a: string[]) => a.map((x) => x.trim()).filter(Boolean);
  return { ok: true, notes: {
    answers: f.answers.map((text, i) => ({ n: i + 1, text: text.trim() })).filter((a) => a.text),
    goals: list(f.goals), currentState: list(f.currentState), avgJobValueCents: avg, missedJobsPerMonth: missed,
    platform: f.platform, decisionMakers: f.decisionMakers.trim(), callHeldAt,
  } };
}
