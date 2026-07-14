import React, { useMemo } from "react";
import { roughStrokes, roughOpts } from "./rough";
import { SketchStrokes } from "./SketchStrokes";
import { useDraw } from "./useDraw";
import { splitSketch, type CommonSketchProps } from "./common";
import { tokens } from "../theme/tokens";

/**
 * Hand-drawn arrow: a curved (or straight) shaft + two arrowhead barbs, all
 * roughened. The head is computed from the shaft's end tangent and drawn last
 * (so it appears as the tip arrives). Defaults to the coral accent.
 */
export const SketchArrow: React.FC<
  CommonSketchProps & {
    from: [number, number];
    to: [number, number];
    /** Perpendicular curve amount (fraction of length). 0 = straight. */
    curve?: number;
    headLength?: number;
    headSpread?: number;
  }
> = (props) => {
  const { from, to, curve = 0.3, headLength = 34, headSpread = 0.5 } = props;
  const { rough, progress, drawIn, opacity } = splitSketch(props);

  const strokes = useMemo(() => {
    const [x1, y1] = from;
    const [x2, y2] = to;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = -dy / dist;
    const ny = dx / dist;
    const cx = (x1 + x2) / 2 + nx * curve * dist;
    const cy = (y1 + y2) / 2 + ny * curve * dist;
    const shaftD = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
    const ang = Math.atan2(y2 - cy, x2 - cx); // tangent at the tip
    const h1x = x2 - Math.cos(ang - headSpread) * headLength;
    const h1y = y2 - Math.sin(ang - headSpread) * headLength;
    const h2x = x2 - Math.cos(ang + headSpread) * headLength;
    const h2y = y2 - Math.sin(ang + headSpread) * headLength;
    const opts = roughOpts({
      ...rough,
      stroke: rough.stroke ?? tokens.color.accent,
      strokeWidth: rough.strokeWidth ?? tokens.stroke.bold,
    });
    const shaft = roughStrokes((g) => g.path(shaftD, opts));
    const wing1 = roughStrokes((g) => g.line(x2, y2, h1x, h1y, opts));
    const wing2 = roughStrokes((g) => g.line(x2, y2, h2x, h2y, opts));
    return [...shaft, ...wing1, ...wing2];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(from), JSON.stringify(to), curve, headLength, headSpread, JSON.stringify(rough)]);

  const p = useDraw(progress, drawIn);
  return <SketchStrokes strokes={strokes} progress={p} opacity={opacity} />;
};
