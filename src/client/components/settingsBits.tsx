import type { ReactNode } from "react";

/** A bare on/off switch (the label is the caller's). `label` is the accessible name when no visible text sits beside it. */
export function Toggle({ checked, onChange, label, disabled, children }: {
  checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; children?: ReactNode;
}) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden="true" />
      {children}
    </label>
  );
}

/** The status chip used in page headers and table cells: a dot, then the words. */
export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "positive" | "info" | "warning" | "critical"; children: ReactNode }) {
  return <span className={`badge2 ${tone}`}><i className="dot" />{children}</span>;
}

/** Error text for a failed request, with the page's own prefix. */
export const InlineMsg = ({ children }: { children: ReactNode }) => <p className="bx-err" role="alert">{children}</p>;
