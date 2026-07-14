import React, { useMemo } from "react";
import { getLength, getPointAtLength } from "@remotion/paths";
import { roughStrokes, roughOpts, type Stroke } from "./rough";
import { SketchStrokes } from "./SketchStrokes";
import { roundedRectPath } from "./SketchRect";
import { useDraw } from "./useDraw";
import type { DrawIn } from "./useDraw";
import { tokens } from "../theme/tokens";

/**
 * Hand-drawn DASHED rounded rectangle: short seeded rough strokes sampled along
 * the rect path (the stroke pipeline has no native dash support), concatenated
 * into one stroke list so it self-draws dash-by-dash like everything else.
 */
export const SketchDashedRect: React.FC<{
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  seed: number;
  stroke: string;
  strokeWidth?: number;
  dash?: number;
  gap?: number;
  drawIn?: DrawIn;
  opacity?: number;
}> = ({ x, y, width, height, radius, seed, stroke, strokeWidth = tokens.stroke.thin, dash = 34, gap = 26, drawIn, opacity }) => {
  const strokes = useMemo(() => {
    const d = roundedRectPath(x, y, width, height, radius);
    const total = getLength(d);
    const n = Math.floor(total / (dash + gap));
    const out: Stroke[] = [];
    for (let i = 0; i < n; i++) {
      const s0 = i * (dash + gap);
      const p1 = getPointAtLength(d, s0);
      const p2 = getPointAtLength(d, Math.min(total, s0 + dash));
      out.push(
        ...roughStrokes((g) =>
          g.line(p1.x, p1.y, p2.x, p2.y, roughOpts({ seed: seed + i, stroke, strokeWidth, roughness: 0.9 })),
        ),
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, width, height, radius, seed, stroke, strokeWidth, dash, gap]);
  const p = useDraw(undefined, drawIn);
  return <SketchStrokes strokes={strokes} progress={p} opacity={opacity} />;
};
