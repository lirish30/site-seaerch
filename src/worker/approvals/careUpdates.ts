import { z } from "zod";
import { onRunDone } from "../care/batch";
import { tickApproved } from "../care/tasks";
import { queueRun } from "../care/updateKind";
import { availableFor, getBatch, insertRun, runsFor, setRunStatus, updatableSites } from "../db/careUpdates";
import type { Approval } from "../db/approvals";
import type { Env } from "../env";
import { InvalidHelperJobError } from "../helper/jobs";
import { registerHandler } from "./registry";

// The wave approval (Plan 12). The payload is what Logan read when he decided; at approval everything is read again, because days may have passed, and only what still applies is queued.

const Entry = z.object({
  id: z.string().min(1), type: z.enum(["core", "plugin", "theme"]), slug: z.string().min(1), name: z.string(), from: z.string(), to: z.string(),
  risk: z.enum(["security", "major", "mild", "minor"]), needsTick: z.boolean(),
});
const Payload = z.object({
  batchId: z.string().min(1),
  wave: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  sites: z.array(z.object({ siteId: z.string().min(1), domain: z.string(), updates: z.array(Entry).min(1) })).min(1),
});
export type CareApprovalPayload = z.infer<typeof Payload>;

export const SITE_GONE = "this site no longer takes updates (archived, its Care plan ended, on hold or its access changed)";
export const NOTHING_LEFT = "nothing left to update here: what was planned was applied by hand, held or replaced by a newer version since this was drafted";
export const UNSAFE = "its address or an update name did not pass the safety check";

registerHandler({
  kind: "care.updates",
  label: "Care updates",
  parse: (p) => Payload.parse(p),
  /**
   * For each site of the wave: re-read the site (the same rule as the weekly list; a rehearsal site only for a single run) and its updates, keep the ones still waiting, not held and at the
   * version Logan saw, and queue one run for them. A site with nothing left gets a `dropped` run that says why (the run summaries carry the drops, not the approval's error). Safe to run again after a
   * throw: a site that already has a run from this approval is skipped, and queueRun's own dedupe keeps a second job from being queued.
   */
  async execute(env: Env, p: CareApprovalPayload, a: Approval) {
    const db = env.DB;
    if (!(await getBatch(db, p.batchId))) throw new Error("This update batch was not found.");
    const sites = await updatableSites(db, { includeTest: p.wave === 0 });
    const done = new Set((await runsFor(db, p.batchId)).filter((r) => r.approvalId === a.id).map((r) => r.siteId));
    const drop = async (siteId: string, why: string) => {
      const run = await insertRun(db, { batchId: p.batchId, siteId, wave: p.wave, approvalId: a.id, now: new Date().toISOString() });
      await setRunStatus(db, run.id, ["queued"], "dropped", { summary: why }, new Date().toISOString());
    };
    for (const entry of p.sites) {
      if (done.has(entry.siteId)) continue;
      const site = sites.find((s) => s.id === entry.siteId);
      if (!site) { await drop(entry.siteId, SITE_GONE); continue; }
      const wanted = new Map(entry.updates.map((u) => [u.id, u.to]));
      const keep = (await availableFor(db, site.id)).filter((u) => wanted.get(u.id) === u.toVersion && !u.held);
      if (keep.length === 0) { await drop(site.id, NOTHING_LEFT); continue; }
      try {
        await queueRun(env, { batchId: p.batchId, site, wave: p.wave, approvalId: a.id, updates: keep });
      } catch (e) {
        if (!(e instanceof InvalidHelperJobError)) throw e;
        await drop(site.id, UNSAFE);
      }
    }
    await tickApproved(env, p.batchId, p.sites.map((s) => s.siteId)); // Logan approved these sites: 1.4 for each client
    await onRunDone(env, p.batchId); // every site may have been dropped, and no job will ever report
  },
});
