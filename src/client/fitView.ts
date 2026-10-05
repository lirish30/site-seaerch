import type { FitProfile, FitResult, Platform } from "./types";

export const NO_FIT = "—";
export const NULL_FIT: FitResult = { fit: null, profile: null, matched: [], missing: [] };
export const PLATFORMS: Platform[] = ["wix", "squarespace", "godaddy", "wordpress", "weebly", "shopify", "webflow", "other"];

const CRITERION_LABEL: Record<string, string> = { industry: "Industry", geo: "Location", platform: "Platform", reviews: "Review count", rating: "Rating" };
export const criterionLabel = (k: string) => CRITERION_LABEL[k] ?? k;

/** Never `0` for a missing fit: no active profile defines a criterion, which is different from a poor match. */
export const fitLabel = (f: FitResult) => (f.fit === null ? NO_FIT : String(f.fit));
export const criteriaList = (keys: string[]) => (keys.length ? keys.map(criterionLabel).join(", ") : "none");

/** Plain-text explanation, used for the table tooltip and the chip's accessible name. */
export function fitSummary(f: FitResult): string {
  if (f.fit === null || !f.profile) return "No fit score: no active fit profile with criteria is set up.";
  return `Fit ${f.fit} against "${f.profile.name}"\nMatched: ${criteriaList(f.matched)}\nMissing: ${criteriaList(f.missing)}`;
}

/** Sort comparator for the Fit column: a null fit sorts last whichever way the column is sorted. */
export function compareFit(a: FitResult, b: FitResult, dir: 1 | -1): number {
  if (a.fit === null || b.fit === null) return a.fit === b.fit ? 0 : a.fit === null ? 1 : -1;
  return (a.fit - b.fit) * dir;
}

/** What the profile form edits. Lists are comma separated text; numbers stay text until validated. */
export interface ProfileDraft {
  name: string; service_key: string; industries: string; geos: string; platforms: Platform[]; min_reviews: string; min_rating: string;
}
export const emptyDraft = (service_key = ""): ProfileDraft => ({ name: "", service_key, industries: "", geos: "", platforms: [], min_reviews: "", min_rating: "" });
export const draftFromProfile = (p: FitProfile): ProfileDraft => ({
  name: p.name, service_key: p.service_key, industries: p.industries.join(", "), geos: p.geos.join(", "), platforms: p.platforms,
  min_reviews: p.min_reviews === null ? "" : String(p.min_reviews), min_rating: p.min_rating === null ? "" : String(p.min_rating),
});

export const splitList = (text: string) => [...new Set(text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];

export type DraftResult = { ok: true; body: Omit<FitProfile, "id" | "active"> } | { ok: false; error: string };
/** Friendly validation (and the request body) so a blank name never reaches the server as raw schema text. */
export function draftToBody(d: ProfileDraft): DraftResult {
  const name = d.name.trim();
  if (!name) return { ok: false, error: "Give the profile a name." };
  if (!d.service_key) return { ok: false, error: "Pick the service this profile is for." };
  const reviews = d.min_reviews.trim(), rating = d.min_rating.trim();
  const min_reviews = reviews === "" ? null : Number(reviews);
  if (min_reviews !== null && (!Number.isInteger(min_reviews) || min_reviews < 0)) return { ok: false, error: "Minimum reviews must be a whole number, 0 or more." };
  const min_rating = rating === "" ? null : Number(rating);
  if (min_rating !== null && (!Number.isFinite(min_rating) || min_rating < 0 || min_rating > 5)) return { ok: false, error: "Minimum rating must be a number from 0 to 5." };
  return { ok: true, body: { name, service_key: d.service_key, industries: splitList(d.industries), geos: splitList(d.geos), platforms: d.platforms, min_reviews, min_rating } };
}

/** A profile with no criteria is ignored by scoring; the editor says so rather than letting it look broken. */
export const hasCriteria = (b: Omit<FitProfile, "id" | "active">) =>
  b.industries.length > 0 || b.geos.length > 0 || b.platforms.length > 0 || b.min_reviews !== null || b.min_rating !== null;

/** Raw schema text from the server ("name: String must…") becomes a generic line; readable messages pass through. */
export const friendlyMessage = (message: string) => (/^[a-z_.]+: /.test(message) ? "the server rejected those values" : message);
