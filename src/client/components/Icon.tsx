import { ICON_MARKUP, type IconName } from "./iconMarkup";

export type { IconName };

/**
 * Line icons exported from the Figma icon set: a 16px grid with a 1.75px stroke that stays 1.75px at every size
 * (`vector-effect: non-scaling-stroke` in styles.css), as in the design. The markup is a fixed, trusted constant.
 */
export default function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      dangerouslySetInnerHTML={{ __html: ICON_MARKUP[name] }} />
  );
}

/** The brand mark: an ink tile with a white bar and one Signal dot (Figma "Logo", 30x30). */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 30 30" role="img" aria-label="Site Search">
      <rect width="30" height="30" rx="8.4" fill="#17171a" />
      <rect x="5.3" y="13.8" width="10.8" height="2.4" rx="1" fill="#fff" />
      <circle cx="21.4" cy="15" r="3.3" fill="#ff5b23" />
    </svg>
  );
}
