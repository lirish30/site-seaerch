import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { CRO_MODELS, MODEL_PRICES, type CroModelId } from "./config";
import type { CroStage } from "./types";

export interface StageRequest { stage: CroStage; system: string; content: Anthropic.ContentBlockParam[]; tool: Anthropic.Tool }
export interface StageResponse { input: unknown; costUsd: number; model: string }
export type CroCaller = (r: StageRequest) => Promise<StageResponse | null>;
export interface StageResult<T> { value: T | null; costUsd: number; model: string | null }

interface Usage { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }
export function costOf(model: CroModelId, u: Usage): number {
  const p = MODEL_PRICES[model];
  return (u.input_tokens * p.in + (u.cache_creation_input_tokens ?? 0) * p.in * 1.25 + (u.cache_read_input_tokens ?? 0) * p.in * 0.1
    + u.output_tokens * p.out) / 1e6;
}

/** A call that will fail the same way again (a refusal, a 4xx), so Workflows should not retry and re-bill it. Kept free of
 *  Workers imports because the eval script runs in Node; workflows.ts turns it into a NonRetryableError. */
export class CroFatalError extends Error {}
const retryable = (status: unknown) => typeof status !== "number" || status >= 500 || status === 408 || status === 409 || status === 429;

type MessagesClient = { messages: { create: (p: any) => Promise<any> } };

export function anthropicCroCaller(apiKey: string, models: Record<CroStage, CroModelId> = CRO_MODELS, client: MessagesClient = new Anthropic({ apiKey })): CroCaller {
  return async ({ stage, system, content, tool }) => {
    const model = models[stage];
    const haiku = model.startsWith("claude-haiku");
    const msg = await client.messages.create({
      model, max_tokens: stage === "synthesize" ? 16000 : 8000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [tool],
      // Haiku 4.5 rejects effort but allows forced tool use; Sonnet 5.5 is the reverse.
      tool_choice: haiku ? { type: "tool", name: tool.name } : { type: "auto" },
      ...(haiku ? {} : { output_config: { effort: "medium" } }),
      messages: [{ role: "user", content }],
    }).catch((e) => { throw retryable((e as { status?: unknown })?.status) ? e : new CroFatalError(String((e as Error)?.message ?? e)); });
    if (msg.stop_reason === "refusal") throw new CroFatalError("Claude declined to review this site");
    const block = msg.content.find((b: { type: string }) => b.type === "tool_use");
    return { input: block?.input ?? null, costUsd: costOf(model, msg.usage), model };
  };
}

/** One stage call validated against its schema, retried once; cost is summed across attempts. */
export async function callStage<T>(call: CroCaller, req: StageRequest, schema: z.ZodType<T>): Promise<StageResult<T>> {
  let costUsd = 0, model: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await call(req);
    if (!r) continue;
    costUsd += r.costUsd; model = r.model;
    const p = schema.safeParse(r.input);
    if (p.success) return { value: p.data, costUsd, model };
  }
  return { value: null, costUsd, model };
}
