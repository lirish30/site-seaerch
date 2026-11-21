import { z } from "zod";
import type { Env } from "../env";
import { saveInventory, updatableSites, upsertSeen, type SeenUpdate, type UpdateType } from "../db/careUpdates";
import { HelperRefused, registerHelperKind, type HelperKindDef } from "../helper/registry";
import { WP_ARG, SshTarget } from "./args";
import { onInventoryDone } from "./batch";
import { groupOf, riskOf } from "./versions";

/** The helper reads one site's WordPress over SSH (read-only: five wp-cli commands) and reports its versions and the updates waiting. */
export const CARE_INVENTORY_KIND = "care.inventory";

export const MAX_PLUGINS = 300;
export const MAX_THEMES = 50;

/** Everything a client site returns is untrusted text: kept as given, trimmed, and at most 200 characters. */
const text = z.string().transform((s) => s.trim().slice(0, 200));

export const CareInventoryPayload = SshTarget.extend({ siteId: z.string().min(1), batchId: z.string().min(1) });
export type CareInventoryPayload = z.infer<typeof CareInventoryPayload>;

/** A slug and an update version are later put in a remote shell command, so they must fit the fixed patterns; a current version is only shown, but must fit them too before it is used to roll back. */
const Item = z.object({
  slug: z.string().regex(WP_ARG.slug),
  name: text,
  status: text,
  version: text,
  updateVersion: z.string().regex(WP_ARG.version).nullable(),
  fromWporg: z.boolean(),
});

export const CareInventoryResult = z.object({
  wpVersion: text.nullable(),
  phpVersion: text.nullable(),
  core: z.object({ to: z.string().regex(WP_ARG.version) }).nullable(),
  plugins: z.array(Item).max(MAX_PLUGINS),
  themes: z.array(Item).max(MAX_THEMES),
  activeTheme: text.nullable(),
  /** Rows the helper left out: refused by its checks, or past the 300 and 50 caps. */
  dropped: z.number().int().min(0).default(0),
});
export type CareInventoryResult = z.infer<typeof CareInventoryResult>;
type Item = z.infer<typeof Item>;

const isActive = (status: string) => status === "active" || status === "active-network";

/** What the read means for the update list. An update whose current version could not be told safely is left out: it could not be rolled back to. */
function seenFrom(r: CareInventoryResult): SeenUpdate[] {
  const out: SeenUpdate[] = [];
  const add = (type: UpdateType, slug: string, name: string, from: string, to: string, rollbackable: boolean) => {
    if (!WP_ARG.version.test(from) || !WP_ARG.version.test(to)) return;
    out.push({ type, slug, name: name || slug, fromVersion: from, toVersion: to, risk: riskOf(type, from, to), rollbackable });
  };
  if (r.core && r.wpVersion) add("core", "wordpress", "WordPress", r.wpVersion, r.core.to, true);
  for (const [type, list] of [["plugin", r.plugins], ["theme", r.themes]] as const) {
    for (const i of list as Item[]) if (i.updateVersion) add(type, i.slug, i.name, i.version, i.updateVersion, i.fromWporg);
  }
  return out;
}

const careInventory: HelperKindDef<CareInventoryPayload, CareInventoryResult> = {
  kind: CARE_INVENTORY_KIND,
  payload: CareInventoryPayload,
  result: CareInventoryResult,
  inputs: () => [],
  outputs: () => [],

  /**
   * Records what the helper read: the site's versions, its group and every update waiting. A result for a site that is no longer updatable (archived, Care ended, a hold, access changed) is refused.
   * Test sites are allowed, because a single-site rehearsal may target one. Safe to run again: the read replaces the last one and an update missing from it becomes `gone`.
   */
  async apply(env: Env, p, r) {
    const site = (await updatableSites(env.DB, { includeTest: true })).find((s) => s.id === p.siteId);
    if (!site) throw new HelperRefused("that site is gone or no longer takes updates");
    if (r.dropped > 0) console.warn(`care inventory: site ${site.id} left out ${r.dropped} plugin or theme rows (unsafe values or past the caps)`);
    const now = new Date().toISOString();
    await saveInventory(env.DB, {
      siteId: site.id, wpVersion: r.wpVersion, phpVersion: r.phpVersion, readAt: now,
      groupKey: groupOf(r.plugins.filter((i) => isActive(i.status)).map((i) => i.slug), r.activeTheme),
      plugins: r.plugins.filter((i) => isActive(i.status)).map((i) => i.slug),
    });
    await upsertSeen(env.DB, site.id, seenFrom(r), now);
    await onInventoryDone(env, p.batchId, p.siteId); // this job is still claimed until apply returns
  },
  async onFail(env, p) { await onInventoryDone(env, p.batchId); },
  async onExpire(env, p) { await onInventoryDone(env, p.batchId); },
};
registerHelperKind(careInventory);
