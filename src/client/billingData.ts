import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { StatusTone } from "./billingView";
import type { ProjectRow } from "./workData";
import { calendarDateIn } from "../worker/billing/dates";
import { FALLBACK_ZONE, zoneOf } from "../worker/sop/cadence";
import type { Hold } from "../worker/db/holds";
import type { InvoiceRow } from "../worker/db/invoices";
import type { Subscription } from "../worker/db/subscriptions";

/** GET /api/billing/summary. */
export interface BillingSummary { mrrCents: number; openCents: number; overdueCents: number; heldClients: number }
/** A subscription as the owner's list gets it (the client's link token is never sent). `linkLost`: its link mail never reached the client, so it may be put up again. */
export type SubscriptionRow = Omit<Subscription, "token"> & { linkLost: boolean };
export type HoldRow = Hold & { businessName: string };
/** The approval a Propose, Start billing or Invoice puts up. Nothing is sent to the client until it is approved. */
export interface WaitingApproval { id: string; kind: string; title: string; status: string }

export const NOTHING_SENT = "Waiting for your approval. Nothing is sent to the client until you approve it.";

/** The tone of a status chip as a badge class. */
export const TONE_CLASS: Record<StatusTone, string> = { ok: "positive", wait: "outline", late: "warning", bad: "critical" };

/** Today's date, and the zone it is counted in, from the booking time zone (the worker counts days the same way). */
export function useOwnerClock(): { today: string; tz: string } {
  const [tz, setTz] = useState(FALLBACK_ZONE);
  useEffect(() => {
    let live = true;
    api.get<{ settings: Record<string, string | number> }>("/settings").then((r) => { if (live) setTz(zoneOf({ booking_config: String(r.settings.booking_config ?? "") })); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return { tz, today: calendarDateIn(new Date(), tz) };
}

/**
 * Names for the clients and projects an invoice or subscription points at. Projects come from the project list (which carries each client's name); a client with no project is looked up one by
 * one. A name that cannot be found reads "Client" rather than leaving a blank link.
 */
export function useNames(businessIds: string[]) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [extra, setExtra] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    api.get<{ projects: ProjectRow[] }>("/projects").then((r) => { if (live) setProjects(r.projects); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const known = useMemo(() => new Map(projects.map((p) => [p.businessId, p.businessName])), [projects]);
  const missing = [...new Set(businessIds)].filter((id) => !known.has(id) && !(id in extra)).sort().join(",");
  useEffect(() => {
    if (!missing) return;
    let live = true;
    for (const id of missing.split(",")) {
      api.get<{ business: { name: string } }>(`/leads/${id}`).then((x) => { if (live) setExtra((e) => ({ ...e, [id]: x.business.name })); }).catch(() => { if (live) setExtra((e) => ({ ...e, [id]: "" })); });
    }
    return () => { live = false; };
  }, [missing]);
  const byProject = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  return {
    client: (id: string): string => known.get(id) ?? (extra[id] || "Client"),
    project: (id: string | null): { id: string; name: string } | null => (id && byProject.has(id) ? { id, name: byProject.get(id)! } : null),
  };
}

export type { InvoiceRow };
