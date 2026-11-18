/** The names the CRO task kinds and their target share. A leaf module, so the queue code and the roadmap hand-over can both use them without importing each other. */
export const CRO_MODEL_KIND = "cro.model";
export const CRO_PAGE_KIND = "cro.page";
export const CRO_SYNTH_KIND = "cro.synthesize";
/** What the CRO tasks are about, so `cancelTasksFor(db, CRO_TARGET, auditId)` closes the open ones of one audit. */
export const CRO_TARGET = "cro_audit";
