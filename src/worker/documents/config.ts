import { z } from "zod";

/** Proposal and SOW settings, stored as JSON in settings.documents_config. */
export interface DocumentsConfig {
  /** ISO time the clause library was reviewed by an Oregon lawyer, or null when it has not been. */
  legalReviewedAt: string | null;
  /** Who reviewed it. Required once a review date is set. */
  legalReviewer: string;
  /** Late fee on an overdue balance, percent per month. */
  lateFeePercentMonthly: number;
  /** Days a sent proposal stays open before it expires. */
  expiryDays: number;
}

export const DEFAULT_DOCUMENTS_CONFIG: DocumentsConfig = { legalReviewedAt: null, legalReviewer: "", lateFeePercentMonthly: 1.5, expiryDays: 30 };

export const DocumentsConfigSchema = z.object({
  legalReviewedAt: z.string().datetime().nullable(),
  legalReviewer: z.string().max(120),
  lateFeePercentMonthly: z.number().min(0).max(10),
  expiryDays: z.number().int().min(7).max(90),
}).superRefine((c, ctx) => {
  if (c.legalReviewedAt !== null && !c.legalReviewer.trim()) ctx.addIssue({ code: "custom", path: ["legalReviewer"], message: "Name who reviewed the clauses" });
}) satisfies z.ZodType<DocumentsConfig>;

/** Reads settings.documents_config. "" and "{}" give the defaults, missing keys take their default, and a document that no longer validates gives the defaults (no review recorded, so nothing real is sent). */
export function parseDocumentsConfig(raw: string): DocumentsConfig {
  if (!raw.trim()) return DEFAULT_DOCUMENTS_CONFIG;
  try {
    const r = DocumentsConfigSchema.safeParse({ ...DEFAULT_DOCUMENTS_CONFIG, ...JSON.parse(raw) });
    return r.success ? r.data : DEFAULT_DOCUMENTS_CONFIG;
  } catch { return DEFAULT_DOCUMENTS_CONFIG; }
}

/**
 * Whether a rendering of this document carries the "draft, not reviewed" banner: always on a test copy, and on any document that is not yet signed while the
 * lawyer's review is not recorded (`gate` is `legalGate`'s answer). A signed real document never has it: it is the record, whatever the settings say now.
 */
export const showDraftBanner = (doc: { test: boolean; status: string }, gate: string | null): boolean => doc.test || (doc.status !== "signed" && gate !== null);

/** Why a real send (to a client, not a test) is refused, or null when it may go. The clauses need an Oregon lawyer's review first (spec §11). */
export function legalGate(c: DocumentsConfig): string | null {
  return c.legalReviewedAt && c.legalReviewer.trim() ? null : "Have an Oregon lawyer review the clauses, then record it in Settings > Documents before sending a proposal to a client.";
}
