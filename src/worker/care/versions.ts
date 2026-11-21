import type { CareUpdate, GroupKey, Risk, UpdateType } from "../db/careUpdates";

// Pure rules for the weekly Care update batch (Plan 12): how risky an update is, who needs Logan's tick, which sites are in which group and which go first.

export const MAJOR_WAIT_DAYS = 7;
/** A page whose before/after similarity falls under this counts as changed. */
export const SSIM_CHANGED = 0.95;
/** Pages checked per site, at most. */
export const MAX_PATHS = 5;

/** Slugs that need Logan's tick even after the canary passed. One constant, so the list is easy to extend. */
export const RISKY_SLUGS: readonly (string | RegExp)[] = [
  /woocommerce|^woo-/, // WooCommerce and its extensions, wherever the word sits in the slug
  /elementor/, // Elementor and its add-ons
  /^(beaver-builder|bb-plugin|bb-theme-builder)/,
  /^divi/,
  /^(wpbakery|js_composer)/,
  /^gravity-?forms/,
  /^wpforms/,
  /^contact-form-7/,
  /^ninja-forms/,
  /^formidable/,
  /^amelia/,
  /^bookly/,
  /booking/,
];

/** The leading digits of each dot-separated part; null when the first part has none (the version can't be read). */
function parts(v: string): number[] | null {
  const out = v.trim().split(".").map((p) => /^\d+/.exec(p)?.[0]);
  if (out[0] === undefined) return null;
  return out.map((d) => (d === undefined ? 0 : Number(d)));
}

/** Risk from version numbers alone. A version that can't be read is major. Security is a tick set by hand, never derived here. */
export function riskOf(type: UpdateType, from: string, to: string): Exclude<Risk, "security"> {
  const a = parts(from), b = parts(to);
  if (!a || !b) return "major";
  const first = a[0] !== b[0], second = (a[1] ?? 0) !== (b[1] ?? 0);
  if (type === "core") return first || second ? "major" : "minor";
  if (first) return "major";
  return second ? "mild" : "minor";
}

const isRisky = (slug: string): boolean => {
  const s = slug.toLowerCase();
  return RISKY_SLUGS.some((r) => (typeof r === "string" ? s === r : r.test(s)));
};

/** Needs Logan's tick even after the canary passed: every major, core, anything that can't be rolled back, every risky slug and anything that failed or was rolled back before. */
export function needsTick(u: Pick<CareUpdate, "type" | "slug" | "risk" | "rollbackable"> & { lastFailedAt?: string | null }): boolean {
  return u.type === "core" || u.risk === "major" || !u.rollbackable || isRisky(u.slug) || !!u.lastFailedAt;
}

/** Ready to go in a batch: not held; security at once; a major once it has been seen for the wait; anything else at once. */
export function isDue(u: CareUpdate, now: Date): boolean {
  if (u.held) return false;
  if (u.security || u.risk === "security") return true;
  if (u.risk !== "major") return true;
  return now.getTime() - Date.parse(u.firstSeenAt) >= MAJOR_WAIT_DAYS * 86_400_000;
}

const BUILDERS = /^(elementor|beaver-builder|bb-plugin|bb-theme-builder|js_composer|wpbakery|divi)/;
const BOOKING = /^(amelia|bookly)|booking/;

/** The group a site belongs to, from its active plugin slugs (a `slug/file.php` path is fine) and active theme. */
export function groupOf(activePlugins: string[], theme: string | null): GroupKey {
  const slugs = activePlugins.map((p) => p.split("/")[0].trim().toLowerCase());
  if (slugs.includes("woocommerce")) return "woocommerce";
  if (slugs.some((s) => BOOKING.test(s))) return "booking";
  if (slugs.some((s) => BUILDERS.test(s)) || (theme !== null && /^divi/i.test(theme.trim()))) return "builder";
  return "brochure";
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One canary per group, two when the group has six or more sites; the lowest Care price first, then domain. */
export function pickCanaries(sites: { siteId: string; group: GroupKey; careCents: number; domain: string }[]): Set<string> {
  const byGroup = new Map<GroupKey, typeof sites>();
  for (const s of sites) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
  const picked = new Set<string>();
  for (const list of byGroup.values()) {
    const sorted = [...list].sort((x, y) => x.careCents - y.careCents || cmp(x.domain.toLowerCase(), y.domain.toLowerCase()) || cmp(x.siteId, y.siteId));
    for (const s of sorted.slice(0, list.length >= 6 ? 2 : 1)) picked.add(s.siteId);
  }
  return picked;
}
