import { useRef } from "react";

/** Pointer capture keeps resizing reliable even when the pointer crosses Monaco. */
export function ResizeHandle({ label, value, min, max, onChange, axis = "x", reverse = false, onReset }: {
  label: string; value: number; min: number; max: number; onChange: (value: number) => void;
  axis?: "x" | "y"; reverse?: boolean; onReset?: () => void;
}) {
  const drag = useRef<{ start: number; value: number } | null>(null);
  const clamp = (next: number) => onChange(Math.round(Math.min(max, Math.max(min, next))));
  return <div className={`resize-handle resize-${axis}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation={axis === "x" ? "vertical" : "horizontal"}
    aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max}
    title={`${label} · drag or use arrow keys · double-click to reset`}
    onDoubleClick={onReset}
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { start: axis === "x" ? e.clientX : e.clientY, value };
      e.currentTarget.dataset.dragging = "true";
    }}
    onPointerMove={(e) => {
      if (!drag.current) return;
      clamp(drag.current.value + ((axis === "x" ? e.clientX : e.clientY) - drag.current.start) * (reverse ? -1 : 1));
    }}
    onLostPointerCapture={(e) => { drag.current = null; delete e.currentTarget.dataset.dragging; }}
    onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
    onKeyDown={(e) => {
      const negative = axis === "x" ? "ArrowLeft" : "ArrowUp";
      const positive = axis === "x" ? "ArrowRight" : "ArrowDown";
      if (e.key === "Home") { e.preventDefault(); clamp(min); }
      else if (e.key === "End") { e.preventDefault(); clamp(max); }
      else if (e.key === negative || e.key === positive) {
        e.preventDefault(); clamp(value + (e.key === negative ? -1 : 1) * (reverse ? -1 : 1) * (e.shiftKey ? 40 : 10));
      }
    }} />;
}
