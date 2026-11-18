import { Hono } from "hono";
import { z } from "zod";
import { deviceOf, requireHelper, type HelperEnv } from "../helper/auth";
import {
  ALREADY_DONE, NOT_FOUND, NOT_YOURS, claimHelperJob, completeHelperJob, failHelperJob, getHelperJob, type HelperJob,
} from "../helper/jobs";
import { getHelperKind, registeredHelperKinds } from "../helper/kinds";

/** What the Mac helper talks to. Outside /api/*, so the login cookie is never looked at: every route needs a device token. */
export const helperRoutes = new Hono<HelperEnv>();
helperRoutes.use("*", requireHelper);

/** The oldest helper version the server still works with. Raise it when the job format changes in a way an old helper would get wrong. */
export const MIN_HELPER_VERSION = "0.1.0";
/** The most one output upload may be. */
export const MAX_OUTPUT_BYTES = 80 * 1024 * 1024;

helperRoutes.post("/hello", (c) => c.json({ serverTime: new Date().toISOString(), minHelperVersion: MIN_HELPER_VERSION }));

const ClaimBody = z.object({ kinds: z.array(z.string().min(1).max(60)).max(20).optional() });

/** The job as the helper sees it: what to do, what it may read and what it may write. The worker computes the two key lists, never the helper. */
function forHelper(job: HelperJob) {
  const def = getHelperKind(job.kind)!;
  const p = def.payload.parse(job.payload);
  return { id: job.id, kind: job.kind, attempts: job.attempts, payload: p, inputs: def.inputs(p), outputs: def.outputs(p) };
}

helperRoutes.post("/jobs/claim", async (c) => {
  const body = ClaimBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "kinds must be a list of job kinds" }, 400);
  // Only what the server knows how to read, apply and expire is handed out.
  const known = registeredHelperKinds();
  const kinds = body.data.kinds ? body.data.kinds.filter((k) => known.includes(k)) : known;
  const job = await claimHelperJob(c.env, deviceOf(c).id, new Date(), kinds);
  if (!job) return c.json({});
  try {
    return c.json({ job: forHelper(job) });
  } catch {
    await failHelperJob(c.env, job.id, deviceOf(c).id, `the job payload is not a ${job.kind} job`);
    return c.json({});
  }
});

/** The job a device holds and the key lists its kind allows, or the response that says why not. */
async function held(c: { env: HelperEnv["Bindings"]; req: { param(n: string): string } }, deviceId: string):
  Promise<{ job: HelperJob; inputs: string[]; outputs: string[] } | { status: 403 | 404; error: string }> {
  const job = await getHelperJob(c.env.DB, c.req.param("id"));
  if (!job) return { status: 404, error: NOT_FOUND };
  if (job.status !== "claimed" || job.claimed_by !== deviceId) return { status: 403, error: NOT_YOURS };
  const def = getHelperKind(job.kind);
  const p = def?.payload.safeParse(job.payload);
  if (!def || !p?.success) return { status: 403, error: "this job cannot be worked on" };
  return { job, inputs: def.inputs(p.data), outputs: def.outputs(p.data) };
}

helperRoutes.get("/jobs/:id/input", async (c) => {
  const h = await held(c, deviceOf(c).id);
  if ("error" in h) return c.json({ error: h.error }, h.status);
  const key = c.req.query("key");
  if (!key) return c.json({ error: "key is required" }, 400);
  if (!h.inputs.includes(key)) return c.json({ error: "that file is not an input of this job" }, 403);
  const obj = await c.env.RAW.get(key);
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "content-length": String(obj.size), "cache-control": "private, no-store" } });
});

/** Reads a body that has no declared length, giving up as soon as it is over `max`. */
async function readUpTo(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const ch of chunks) { out.set(ch, at); at += ch.byteLength; }
  return out;
}

helperRoutes.put("/jobs/:id/output", async (c) => {
  const h = await held(c, deviceOf(c).id);
  if ("error" in h) return c.json({ error: h.error }, h.status);
  const key = c.req.query("key");
  if (!key) return c.json({ error: "key is required" }, 400);
  if (!h.outputs.includes(key)) return c.json({ error: "that file is not an output of this job" }, 403);
  const tooBig = { error: `An upload may be at most ${MAX_OUTPUT_BYTES / 1024 / 1024} MB` };
  const declared = c.req.header("content-length");
  const length = declared === undefined ? null : Number(declared);
  if (length !== null && (!Number.isFinite(length) || length < 0)) return c.json({ error: "bad content-length" }, 400);
  if (length !== null && length > MAX_OUTPUT_BYTES) return c.json(tooBig, 413);
  const httpMetadata = { contentType: c.req.header("content-type") ?? "application/octet-stream" };
  // A declared length streams straight into storage (a rendered video is too big to hold); an undeclared one is counted as it arrives.
  if (length !== null) {
    await c.env.RAW.put(key, c.req.raw.body, { httpMetadata });
    return c.json({ ok: true, bytes: length });
  }
  const data = await readUpTo(c.req.raw.body, MAX_OUTPUT_BYTES);
  if (!data) return c.json(tooBig, 413);
  await c.env.RAW.put(key, data, { httpMetadata });
  return c.json({ ok: true, bytes: data.byteLength });
});

const statusOf = (error: string): 404 | 403 | 409 | 422 =>
  error === NOT_FOUND ? 404 : error === NOT_YOURS ? 403 : error === ALREADY_DONE || error.startsWith("job is ") || error.startsWith("already being") ? 409 : 422;

helperRoutes.post("/jobs/:id/complete", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { result?: unknown } | null;
  const r = await completeHelperJob(c.env, c.req.param("id"), deviceOf(c).id, body?.result);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, statusOf(r.error));
});

const FailBody = z.object({ error: z.string().trim().min(1).max(2000) });

helperRoutes.post("/jobs/:id/fail", async (c) => {
  const body = FailBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "error is required" }, 400);
  const id = c.req.param("id");
  const job = await getHelperJob(c.env.DB, id);
  if (!job) return c.json({ error: NOT_FOUND }, 404);
  if (job.status === "claimed" && job.claimed_by !== deviceOf(c).id) return c.json({ error: NOT_YOURS }, 403);
  if (!(await failHelperJob(c.env, id, deviceOf(c).id, body.data.error))) return c.json({ error: job.status === "done" ? ALREADY_DONE : `job is ${job.status}, not claimed` }, 409);
  return c.json({ ok: true });
});
