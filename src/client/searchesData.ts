import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { LEADS_CHANGED } from "./components/Shell";
import type { Radar, Search } from "./types";

/** "Plumber · Boise": the short name a search or radar goes by in the sidebars. */
export const shortName = (s: { business_type: string; location: string }) => `${s.business_type[0]?.toUpperCase() ?? ""}${s.business_type.slice(1)} · ${s.location.split(",")[0].trim()}`;

/**
 * The searches and radars the Home and Find sidebars list. Refetches when a lead changes, and every 5 seconds while a search is running
 * so its progress moves on its own.
 */
export function useSearches() {
  const [searches, setSearches] = useState<Search[] | null>(null);
  const [radars, setRadars] = useState<Radar[] | null>(null);
  const load = useCallback(() => {
    api.get<Search[]>("/searches").then(setSearches).catch(() => setSearches((s) => s));
    api.get<Radar[]>("/radar").then(setRadars).catch(() => setRadars((r) => r));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(LEADS_CHANGED, load);
    return () => window.removeEventListener(LEADS_CHANGED, load);
  }, [load]);
  const running = searches?.some((s) => s.status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [running, load]);
  return { searches, radars, reload: load };
}
