import React, { useMemo } from "react";
import { roughStrokes, roughOpts, type Stroke } from "./rough";
import { SketchStrokes } from "./SketchStrokes";
import { useDraw } from "./useDraw";
import type { DrawIn } from "./useDraw";
import { tokens } from "../theme/tokens";

/** Arc path (SVG A command). Angles in degrees, 0 = east, increasing = clockwise (y-down). */
export const arcPath = (cx: number, cy: number, r: number, a0: number, a1: number): string => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const p0 = { x: cx + r * Math.cos(rad(a0)), y: cy + r * Math.sin(rad(a0)) };
  const p1 = { x: cx + r * Math.cos(rad(a1)), y: cy + r * Math.sin(rad(a1)) };
  const sweep = a1 > a0 ? 1 : 0;
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} ${sweep} ${p1.x} ${p1.y}`;
};

/**
 * A hand-drawn LOOPING arrow: a long curling arc + arrowhead computed from the
 * end tangent. Use for anything that must visibly loop/hook (≥120° sweep) —
 * a single-quadratic SketchArrow reads as a shallow bow (see skill L17).
 */
export const SketchLoopArrow: React.FC<{
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
  stroke: string;
  strokeWidth?: number;
  seed: number;
  headLength?: number;
  drawIn?: DrawIn;
  opacity?: number;
}> = ({ cx, cy, r, a0, a1, stroke, strokeWidth = tokens.stroke.bold, seed, headLength = 46, drawIn, opacity }) => {
  const strokes = useMemo(() => {
    const rad = (d: number) => (d * Math.PI) / 180;
    const d = arcPath(cx, cy, r, a0, a1);
    const ex = cx + r * Math.cos(rad(a1));
    const ey = cy + r * Math.sin(rad(a1));
    const dir = a1 > a0 ? 1 : -1;
    const ang = Math.atan2(dir * Math.cos(rad(a1)), dir * -Math.sin(rad(a1)));
    const spread = 0.5;
    const opts = roughOpts({ seed, stroke, strokeWidth });
    const out: Stroke[] = [...roughStrokes((g) => g.path(d, opts))];
    for (const sp of [-spread, spread]) {
      const hx = ex - Math.cos(ang + sp) * headLength;
      const hy = ey - Math.sin(ang + sp) * headLength;
      out.push(...roughStrokes((g) => g.line(ex, ey, hx, hy, opts)));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cx, cy, r, a0, a1, stroke, strokeWidth, seed, headLength]);
  const p = useDraw(undefined, drawIn);
  return <SketchStrokes strokes={strokes} progress={p} opacity={opacity} />;
};
