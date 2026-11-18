import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MAX_CALLOUT_CHARS, MAX_MARKUPS, type Markup, type Segment, type Shot } from "../../../worker/video/plan";
import { addMarkup, moveArrowEnd, moveMarkup, removeMarkup, replaceMarkup, resizeMarkup } from "../../videoView";
import Icon from "../Icon";

type Drag = { index: number; mode: "move" | "resize" | "from" | "to"; x: number; y: number; original: Markup };

const TYPES: { type: Markup["type"]; label: string }[] = [
  { type: "circle", label: "Circle" }, { type: "arrow", label: "Arrow" }, { type: "blur", label: "Blur" }, { type: "callout", label: "Callout" },
];

/**
 * The screenshot a line plays over, with its markups drawn on top as SVG. Every coordinate is a fraction of the shot, and a circle's radius is a fraction
 * of its width, so the drawing is the same at any size. Drag a markup to move it, a handle to resize it; Delete removes the selected one.
 * Changes go up through `onChange` while dragging and `onCommit` once when the pointer is released or a field loses focus (the page saves then).
 */
export default function ShotCanvas({ videoId, shot, segment, readOnly, onChange, onCommit }: {
  videoId: string; shot: Shot; segment: Segment; readOnly: boolean; onChange: (seg: Segment) => void; onCommit: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const { width: W, height: H } = shot;
  const px = Math.max(W, H) / 400; // one "pixel" of a 400-wide drawing, so lines and text scale with the shot
  const sel = selected !== null && selected < segment.markups.length ? selected : null;
  const chosen = sel === null ? null : segment.markups[sel];

  function begin(e: ReactPointerEvent, index: number, mode: Drag["mode"]) {
    if (readOnly) return;
    e.stopPropagation();
    svg.current?.setPointerCapture(e.pointerId);
    drag.current = { index, mode, x: e.clientX, y: e.clientY, original: segment.markups[index] };
    setSelected(index);
  }
  function move(e: ReactPointerEvent) {
    const d = drag.current, box = svg.current?.getBoundingClientRect();
    if (!d || !box || !box.width || !box.height) return;
    const dx = (e.clientX - d.x) / box.width, dy = (e.clientY - d.y) / box.height;
    const next = d.mode === "move" ? moveMarkup(d.original, dx, dy) : d.mode === "resize" ? resizeMarkup(d.original, dx, dy) : moveArrowEnd(d.original, d.mode, dx, dy);
    onChange(replaceMarkup(segment, d.index, next));
  }
  function end() {
    if (!drag.current) return;
    drag.current = null;
    onCommit();
  }
  function change(next: Segment, commit = false) { onChange(next); if (commit) onCommit(); }
  function remove() { if (sel === null) return; setSelected(null); change(removeMarkup(segment, sel), true); }

  const stroke = { stroke: "#ff5b23", strokeWidth: 3 * px, fill: "none" };
  const handle = (cx: number, cy: number, index: number, mode: Drag["mode"], label: string) => (
    <circle key={`${index}-${mode}`} cx={cx} cy={cy} r={6 * px} className="vd-handle" role="presentation" aria-label={label}
      onPointerDown={(e) => begin(e, index, mode)} />
  );

  return (
    <div className="vd-canvas-wrap">
      <div className="vd-canvas" style={{ aspectRatio: `${W} / ${H}`, width: `min(100%, ${(70 * W / H).toFixed(2)}vh)` }}>
        <img src={`/api/video-audits/${videoId}/shots/${shot.id}/preview`} alt={`${shot.viewport === "desktop" ? "Desktop" : "Phone"} screenshot of the site`} draggable={false} />
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="vd-overlay" onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerDown={() => setSelected(null)}
          tabIndex={readOnly ? undefined : 0} onKeyDown={(e) => { if ((e.key === "Delete" || e.key === "Backspace") && sel !== null && e.target === e.currentTarget) { e.preventDefault(); remove(); } }}
          aria-label="Markups over the screenshot">
          {segment.markups.map((m, i) => {
            const on = i === sel;
            const cls = `vd-mark${on ? " on" : ""}`;
            if (m.type === "circle") return (
              <g key={i} className={cls}>
                <circle cx={m.x * W} cy={m.y * H} r={m.r * W} {...stroke} fill="transparent" onPointerDown={(e) => begin(e, i, "move")} />
                {on && !readOnly && handle((m.x + m.r) * W, m.y * H, i, "resize", "Resize the circle")}
              </g>
            );
            if (m.type === "arrow") {
              const a = { x: m.from.x * W, y: m.from.y * H }, b = { x: m.to.x * W, y: m.to.y * H };
              const ang = Math.atan2(b.y - a.y, b.x - a.x), head = 14 * px;
              const h1 = { x: b.x - head * Math.cos(ang - 0.5), y: b.y - head * Math.sin(ang - 0.5) }, h2 = { x: b.x - head * Math.cos(ang + 0.5), y: b.y - head * Math.sin(ang + 0.5) };
              return (
                <g key={i} className={cls}>
                  <path d={`M${a.x} ${a.y}L${b.x} ${b.y}M${h1.x} ${h1.y}L${b.x} ${b.y}L${h2.x} ${h2.y}`} {...stroke} strokeLinecap="round" strokeLinejoin="round" />
                  <path d={`M${a.x} ${a.y}L${b.x} ${b.y}`} stroke="transparent" strokeWidth={14 * px} fill="none" onPointerDown={(e) => begin(e, i, "move")} />
                  {on && !readOnly && <>{handle(a.x, a.y, i, "from", "Move the arrow's tail")}{handle(b.x, b.y, i, "to", "Move the arrow's head")}</>}
                </g>
              );
            }
            if (m.type === "blur") return (
              <g key={i} className={cls}>
                <rect x={m.x * W} y={m.y * H} width={m.w * W} height={m.h * H} className="vd-blur" onPointerDown={(e) => begin(e, i, "move")} />
                <text x={(m.x + m.w / 2) * W} y={(m.y + m.h / 2) * H} className="vd-blur-label" fontSize={12 * px} textAnchor="middle" dominantBaseline="middle">Blur</text>
                {on && !readOnly && handle((m.x + m.w) * W, (m.y + m.h) * H, i, "resize", "Resize the blur box")}
              </g>
            );
            const size = 13 * px, text = m.text || "Type the words";
            const w = Math.max(text.length * size * 0.56, 60 * px) + 16 * px, h = size + 14 * px;
            return (
              <g key={i} className={cls} onPointerDown={(e) => begin(e, i, "move")}>
                <rect x={m.x * W - w / 2} y={m.y * H - h / 2} width={w} height={h} rx={6 * px} className="vd-callout" />
                <text x={m.x * W} y={m.y * H} fontSize={size} textAnchor="middle" dominantBaseline="central" className={m.text ? "vd-callout-text" : "vd-callout-text empty"}>{text}</text>
              </g>
            );
          })}
        </svg>
      </div>

      {!readOnly && (
        <div className="vd-tools" role="toolbar" aria-label="Markups">
          {TYPES.map((t) => (
            <button key={t.type} type="button" className="btn sm" disabled={segment.markups.length >= MAX_MARKUPS}
              onClick={() => { const next = addMarkup(segment, t.type); setSelected(next.markups.length - 1); change(next, true); }}>
              <Icon name="plus" size={13} />{t.label}
            </button>
          ))}
          <span className="vd-tools-note">{segment.markups.length} of {MAX_MARKUPS}</span>
        </div>
      )}

      {chosen && !readOnly && (
        <div className="vd-selected">
          {chosen.type === "callout" ? (
            <label className="vd-field">
              <span>Callout words</span>
              <input value={chosen.text} maxLength={MAX_CALLOUT_CHARS} autoComplete="off" placeholder="What the viewer should notice"
                onChange={(e) => change(replaceMarkup(segment, sel!, { ...chosen, text: e.target.value.replace(/[\r\n]+/g, " ") }))} onBlur={() => onCommit()} />
            </label>
          ) : <span className="vd-selected-label">{chosen.type === "blur" ? "Blur box: hides what is under it in the video. Drag the dot to resize." : chosen.type === "circle" ? "Circle: drag it, or the dot to resize." : "Arrow: drag it, or either end."}</span>}
          <button type="button" className="btn sm danger-ghost" onClick={remove}><Icon name="x" size={13} />Delete</button>
        </div>
      )}
    </div>
  );
}
