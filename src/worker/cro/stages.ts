import type { Business } from "../types";
import type { QueuePart } from "../queue/registry";
import { SYSTEM_MODEL, SYSTEM_PAGE, SYSTEM_SYNTH, modelContent, pageContent, synthContent, type ShotKeys } from "./prompts";
import type { BusinessModel, CroPageRef, Evidence, PageReview } from "./types";

/** What one Claude stage is given: the stage's fixed prompt, and everything copied from the site (the ledger, the business, the screenshots) as untrusted parts. */
export interface StageRequest { instructions: string; untrusted: QueuePart[] }

export interface ModelStageInput { business: Business; evidence: Evidence[]; shots: ShotKeys }
export interface PageStageInput { business: Business; model: BusinessModel; page: CroPageRef; evidence: Evidence[]; shots: ShotKeys }
export interface SynthInput { business: Business; model: BusinessModel; reviews: PageReview[]; evidence: Evidence[] }

export const buildModelRequest = (i: ModelStageInput): StageRequest => ({ instructions: SYSTEM_MODEL, untrusted: modelContent(i) });

/** `rejected` lists what an earlier answer for this page had thrown away, so the second try can avoid it. */
export const buildPageRequest = (i: PageStageInput, rejected: string[] = []): StageRequest => ({ instructions: SYSTEM_PAGE, untrusted: pageContent(i, rejected) });

export const buildSynthRequest = (i: SynthInput, rejected: string[] = []): StageRequest => ({ instructions: SYSTEM_SYNTH, untrusted: synthContent(i, rejected) });
