/**
 * Placeholder for the conflict gate (Task 5 replaces this file with the real check, keeping this exact signature).
 * Until then nothing is ever blocked.
 */
export type ConflictResult = { blocked: false } | { blocked: true; reason: string; source: string };

export async function checkConflict(_db: D1Database, _c: { email: string; businessId?: string }): Promise<ConflictResult> {
  return { blocked: false };
}
