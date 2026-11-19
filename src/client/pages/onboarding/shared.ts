import { ApiError } from "../../api";

/** What the panel's parts share: how they run a call, and how an error reads. */
export type Act = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

export const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The server's own sentence for a refused field (`{ fields: { welcomeVideoUrl: ["..."] } }`), else the error's message. */
export function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const fields = (e.body as { fields?: Record<string, unknown> } | undefined)?.fields;
    const first = fields && typeof fields === "object" ? Object.values(fields).flat().find((m): m is string => typeof m === "string") : undefined;
    if (first) return first;
  }
  return e instanceof Error ? e.message : fallback;
}
