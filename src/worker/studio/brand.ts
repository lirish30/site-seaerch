// The look of the Studio's images (Plan 15).
// PLACEHOLDER values: Logan will supply the Siteline tokens (Figma design system 67:1958) and replace them here, and nothing else needs to change.
// Fonts are system stacks on purpose: a slide is rendered with no web font request, so the HTML makes no request of its own.
export const STUDIO_BRAND = {
  background: "#f7f4ee",
  ink: "#15202b",
  accent: "#1f5fbf",
  muted: "#5b6b79",
  headingFont: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
  bodyFont: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
} as const;
