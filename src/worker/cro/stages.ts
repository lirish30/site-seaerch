import type { Business } from "../types";
import { callStage, type CroCaller, type StageResult } from "./ai";
import { BusinessModelSchema, MODEL_TOOL, PAGE_TOOL, PageReviewSchema, SYNTH_TOOL, SynthesisSchema, SYSTEM_MODEL, SYSTEM_PAGE, SYSTEM_SYNTH,
  modelContent, pageContent, synthContent } from "./prompts";
import type { BusinessModel, CroPageRef, Evidence, PageReview, Synthesis } from "./types";

type Shots = { desktop: string | null; mobile: string | null };
export interface ModelStageInput { business: Business; evidence: Evidence[]; shots: Shots }
export interface PageStageInput { business: Business; model: BusinessModel; page: CroPageRef; evidence: Evidence[]; shots: Shots }
export interface SynthInput { business: Business; model: BusinessModel; reviews: PageReview[]; evidence: Evidence[] }

export function inferBusinessModel(i: ModelStageInput, call: CroCaller): Promise<StageResult<BusinessModel>> {
  return callStage(call, { stage: "model", system: SYSTEM_MODEL, content: modelContent(i), tool: MODEL_TOOL }, BusinessModelSchema);
}

export async function reviewPage(i: PageStageInput, call: CroCaller, rejected: string[] = []): Promise<StageResult<PageReview>> {
  const r = await callStage(call, { stage: "pages", system: SYSTEM_PAGE, content: pageContent(i, rejected), tool: PAGE_TOOL }, PageReviewSchema);
  return r.value ? { ...r, value: { ...r.value, page: i.page.url } } : r;
}

export function synthesizeRoadmap(i: SynthInput, call: CroCaller, rejected: string[] = []): Promise<StageResult<Synthesis>> {
  return callStage(call, { stage: "synthesize", system: SYSTEM_SYNTH, content: synthContent(i, rejected), tool: SYNTH_TOOL }, SynthesisSchema);
}
