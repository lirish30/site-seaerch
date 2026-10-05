import type { Service } from "./types";

/** Categories in catalog order, each with its services (already sorted by the API). */
export function groupByCategory(services: Service[]): { category: string; services: Service[] }[] {
  const groups = new Map<string, Service[]>();
  for (const s of services) groups.set(s.category, [...(groups.get(s.category) ?? []), s]);
  return [...groups].map(([category, services]) => ({ category, services }));
}

export const toLines = (items: string[]) => items.join("\n");
export const fromLines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
