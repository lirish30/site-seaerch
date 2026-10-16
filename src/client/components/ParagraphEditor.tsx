import { useLayoutEffect, useRef } from "react";

/**
 * The email body as separate paragraphs (blank-line separated, as stored). Enter starts a new paragraph, Shift+Enter a line break,
 * Backspace at the start of a paragraph joins it to the one above. Pasting several paragraphs splits them.
 */
export default function ParagraphEditor({ value, onChange, onBlur, ariaLabel = "Message" }: { value: string; onChange: (v: string) => void; onBlur?: () => void; ariaLabel?: string }) {
  const paras = value.length ? value.split(/\n{2,}/) : [""];
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const focusAt = useRef<{ i: number; pos: number } | null>(null);

  const set = (next: string[]) => onChange(next.join("\n\n"));
  const fit = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } };

  useLayoutEffect(() => {
    refs.current.forEach(fit);
    const f = focusAt.current;
    if (f) { const el = refs.current[f.i]; if (el) { el.focus(); el.setSelectionRange(f.pos, f.pos); } focusAt.current = null; }
  });

  return (
    <div className="c-body" role="group" aria-label={ariaLabel}>
      {paras.map((text, i) => (
        <textarea key={i} ref={(el) => { refs.current[i] = el; }} rows={1} value={text} aria-label={`${ariaLabel}, paragraph ${i + 1}`}
          onChange={(e) => {
            const parts = e.target.value.split(/\n{2,}/);
            const next = [...paras]; next.splice(i, 1, ...parts); set(next);
            if (parts.length > 1) focusAt.current = { i: i + parts.length - 1, pos: parts[parts.length - 1].length };
          }}
          onBlur={onBlur}
          onKeyDown={(e) => {
            const el = e.currentTarget;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const at = el.selectionStart ?? text.length;
              const next = [...paras]; next.splice(i, 1, text.slice(0, at).replace(/\s+$/, ""), text.slice(el.selectionEnd ?? at).replace(/^\s+/, ""));
              set(next); focusAt.current = { i: i + 1, pos: 0 };
            } else if (e.key === "Backspace" && i > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
              e.preventDefault();
              const prev = paras[i - 1];
              const next = [...paras]; next.splice(i - 1, 2, prev + text);
              set(next); focusAt.current = { i: i - 1, pos: prev.length };
            }
          }} />
      ))}
    </div>
  );
}
