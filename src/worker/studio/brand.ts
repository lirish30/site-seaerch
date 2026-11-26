// The look of the Studio's images (Plan 15): the Siteline tokens (Figma "Siteline · Homepage / 1440 · v6", system frame 67:1958), taken from the shared module so the Studio, the decks and the audit reports cannot drift apart.
// Fonts are Geist and Geist Mono, embedded as base64 by `SITELINE_FONT_FACE_CSS`: a slide is rendered with no web font request, so the HTML makes no request of its own.
import { SITELINE } from "../brand/siteline";

export const STUDIO_BRAND = {
  /** The paper the light slides sit on. */
  background: SITELINE.paper,
  /** The night the dark slides (the closing one) sit on. */
  night: SITELINE.night,
  ink: SITELINE.ink,
  /** The one highlighted word on paper (dark green) and on night (mint). */
  accent: SITELINE.green,
  accentOnNight: SITELINE.mint,
  muted: SITELINE.muted,
  /** Hairlines and the empty picture frame. */
  line: SITELINE.line,
  mist: SITELINE.mist,
  headingFont: SITELINE.sans,
  bodyFont: SITELINE.sans,
  monoFont: SITELINE.mono,
} as const;
