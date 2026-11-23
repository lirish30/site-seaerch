import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../../api";
import Icon, { type IconName } from "../../Icon";

/** A server's plain sentence when it sent one, else `fallback`. A status line or a bare "invalid body" is never shown to the owner. */
export const sentence = (e: unknown, fallback: string): string => {
  if (!(e instanceof ApiError)) return fallback;
  const m = e.message.trim();
  return !m || m === "invalid body" || /^HTTP \d{3}$/.test(m) ? fallback : m;
};

/**
 * Puts text on the clipboard. The clipboard API where the page may use it, else the old copy command from a hidden box; false when neither worked (the caller then says to copy by hand).
 * Nothing is sent anywhere: this only fills the owner's own clipboard.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the old way */ }
  try {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand("copy");
    box.remove();
    return ok;
  } catch { return false; }
}

/** A button that copies `text` and says so in words next to it. The label is honest about what it does: it copies, it posts nothing. */
export function CopyButton({ text, label, disabled }: { text: string; label: string; disabled?: boolean }) {
  const [note, setNote] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    setNote((await copyText(text)) ? "Copied." : "Could not copy: select the text and copy it by hand.");
    timer.current = setTimeout(() => setNote(""), 6000);
  }
  return (
    <>
      <button type="button" className="btn" aria-disabled={disabled || !text.trim()} onClick={() => { if (!disabled && text.trim()) void copy(); }}><Icon name="copy" size={16} />{label}</button>
      {note && <span className="small muted" role="status">{note}</span>}
    </>
  );
}

const PART_ICON: Record<string, IconName> = {
  "Google listing and search area": "pin", "Search terms": "search", "Where the business shows": "grid", "Google profile": "star", "Name, address and phone": "phone",
  Directories: "list", "Monthly report": "file-text", Reviews: "star", Content: "pen",
};

/** A section of the Local SEO tab as a card: an icon and title, its buttons on the right, an optional line of help and the content. */
export function Part({ title, help, children, actions, id, note }: { title: string; help?: string; children: React.ReactNode; actions?: React.ReactNode; id?: string; note?: React.ReactNode }) {
  return (
    <section className="ds-card sx-part" aria-label={title} id={id}>
      <header className="ds-card-head">
        <Icon name={PART_ICON[title] ?? "target"} size={16} />
        <h2>{title}</h2>
        {note !== undefined && <span className="ds-card-note">{note}</span>}
        {actions}
      </header>
      <div className="ds-card-body">
        {help && <p className="sx-help">{help}</p>}
        {children}
      </div>
    </section>
  );
}

/** A line under a button that says what happened or what went wrong, as text. */
export function Say({ ok, error }: { ok?: string; error?: string }) {
  return (
    <>
      {ok && <p className="small sx-say" role="status">{ok}</p>}
      {error && <p className="error small sx-say" role="alert">{error}</p>}
    </>
  );
}
