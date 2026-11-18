/**
 * Queues the cold-email draft for a lead once its audit is final (a later task of the queue migration makes this create the real draft task).
 * `created: false` means nothing new was queued: a draft is already queued for this audit, or, for now, that nothing is queued at all.
 */
export async function enqueueDraftFor(
  _db: D1Database, _p: { businessId: string; auditId: string; forceDraft?: boolean; steeringNote?: string | null },
): Promise<{ created: boolean }> {
  return { created: false };
}
