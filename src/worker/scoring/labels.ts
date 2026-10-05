// Lighthouse audit id -> label that reads after a colon in outreach. The scorer owns all prospect-facing copy.
// Ids not listed here are ignored on purpose: we never surface a raw id or Lighthouse's own jargon-heavy title.
// robots-txt and http-status-code are deliberately absent (transient fetch errors / effectively unreachable).
export const AUDIT_LABELS: Record<string, string> = {
  "meta-description": "no search-results summary",
  "document-title": "no page title",
  "is-crawlable": "blocked from Google",
  // Only fails when a canonical is set but wrong (it is "not applicable" when none exists).
  canonical: "a page-address setting that points to the wrong place",
  "link-text": "links that just say things like 'click here'",
  "crawlable-anchors": "links Google can't follow",
  "image-alt": "images without text descriptions",
  hreflang: "broken language settings",
  "color-contrast": "text that's hard to read against its background",
  label: "form fields without labels",
  "link-name": "links screen readers can't announce",
  "button-name": "buttons screen readers can't announce",
  "html-has-lang": "no language set for screen readers",
};

/** Labels for the ids we can describe honestly, in order, at most `max`. */
export const labelsFor = (ids: string[], max: number): string[] =>
  ids.filter((id) => Object.hasOwn(AUDIT_LABELS, id)).slice(0, max).map((id) => AUDIT_LABELS[id]);
