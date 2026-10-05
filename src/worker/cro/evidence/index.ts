import type { Business } from "../../types";
import type { CapturedPage, Evidence, EvidenceDraft } from "../types";
import { contactEvidence, ctaEvidence, navEvidence } from "./layout";
import { flowEvidence, formEvidence, trustEvidence } from "./conversion";
import { copyEvidence } from "./content";
import { healthEvidence, listingEvidence, martechEvidence } from "./site";

export { cityOf } from "./content";

/** The evidence ledger: every fact the AI may cite, with stable ids. Failed pages contribute nothing. */
export function buildEvidence(pages: CapturedPage[], business: Business): Evidence[] {
  const ok = pages.filter((p) => p.ok && (p.desktop || p.mobile));
  const drafts: EvidenceDraft[] = [];
  for (const p of ok) drafts.push(...navEvidence(p), ...ctaEvidence(p), ...contactEvidence(p), ...formEvidence(p), ...flowEvidence(p),
    ...trustEvidence(p), ...copyEvidence(p, business), ...healthEvidence(p));
  drafts.push(...martechEvidence(ok), ...listingEvidence(ok, business));
  return drafts.map((d, i) => ({ id: `E${i + 1}`, ...d }));
}
