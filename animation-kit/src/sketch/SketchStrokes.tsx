import React, { useMemo } from "react";
import { getLength, evolvePath } from "@remotion/paths";
import type { Stroke } from "./rough";

/** Fraction of the entrance spent drawing the outline "skeleton" before the
 *  body fills in. Shapes with no fill use the whole window for the outline. */
const OUTLINE_FRAC = 0.72;

/**
 * The draw-on engine. "Skeleton → body": the OUTLINE strokes self-draw first
 * (stroke-dashoffset) over the first ~72% of progress, then solid FILLS reveal
 * over the last ~28% — so a node sketches its wireframe, then fills its body.
 * This is size-independent (a wide card and a small dot both skeleton the same
 * way), and fills paint BEHIND outlines so a body never covers its own border.
 */
export const SketchStrokes: React.FC<{
  strokes: Stroke[];
  progress: number;
  opacity?: number;
}> = ({ strokes, progress, opacity = 1 }) => {
  const measured = useMemo(() => {
    const measure = (list: Stroke[]) => {
      let cum = 0;
      const items = list.map((s) => {
        const len = Math.max(1, getLength(s.d));
        const start = cum;
        cum += len;
        return { s, len, start };
      });
      return { items, total: Math.max(1, cum) };
    };
    const outlines = measure(strokes.filter((s) => s.kind === "outline"));
    const fills = measure(strokes.filter((s) => s.kind === "fill"));
    return { outlines, fills, hasFill: fills.items.length > 0 };
  }, [strokes]);

  const outlineFrac = measured.hasFill ? OUTLINE_FRAC : 1;
  const outlineP = Math.min(1, progress / outlineFrac);
  const fillP = outlineFrac >= 1 ? 0 : Math.max(0, (progress - outlineFrac) / (1 - outlineFrac));

  const outlineDrawn = outlineP * measured.outlines.total;
  const fillDrawn = fillP * measured.fills.total;

  return (
    <g opacity={opacity}>
      {/* body fills — behind, revealed after the skeleton */}
      <g>
        {measured.fills.items.map(({ s, len, start }, i) => {
          const local = Math.max(0, Math.min(1, (fillDrawn - start) / len));
          if (local <= 0) return null;
          return <path key={i} d={s.d} fill={s.color} stroke="none" opacity={local} />;
        })}
      </g>
      {/* outline skeleton — on top, self-drawing */}
      <g>
        {measured.outlines.items.map(({ s, len, start }, i) => {
          const local = Math.max(0, Math.min(1, (outlineDrawn - start) / len));
          if (local <= 0) return null;
          const { strokeDasharray, strokeDashoffset } = evolvePath(local, s.d);
          return (
            <path
              key={i}
              d={s.d}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={strokeDasharray}
              strokeDashoffset={strokeDashoffset}
            />
          );
        })}
      </g>
    </g>
  );
};
