import React, { useMemo } from "react";
import { roughStrokes, roughOpts } from "./rough";
import { SketchStrokes } from "./SketchStrokes";
import { useDraw } from "./useDraw";
import { splitSketch, type CommonSketchProps } from "./common";

/** Rounded-rectangle path (rough.js has no native corner radius). */
export const roundedRectPath = (
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): string => {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M ${x + rr} ${y} L ${x + w - rr} ${y} Q ${x + w} ${y} ${x + w} ${y + rr} L ${x + w} ${
    y + h - rr
  } Q ${x + w} ${y + h} ${x + w - rr} ${y + h} L ${x + rr} ${y + h} Q ${x} ${y + h} ${x} ${
    y + h - rr
  } L ${x} ${y + rr} Q ${x} ${y} ${x + rr} ${y} Z`;
};

export const SketchRect: React.FC<
  CommonSketchProps & { x: number; y: number; width: number; height: number; radius?: number }
> = (props) => {
  const { x, y, width, height, radius = 12 } = props;
  const { rough, progress, drawIn, opacity } = splitSketch(props);
  const strokes = useMemo(
    () =>
      roughStrokes((g) =>
        radius > 0
          ? g.path(roundedRectPath(x, y, width, height, radius), roughOpts(rough))
          : g.rectangle(x, y, width, height, roughOpts(rough)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [x, y, width, height, radius, JSON.stringify(rough)],
  );
  const p = useDraw(progress, drawIn);
  return <SketchStrokes strokes={strokes} progress={p} opacity={opacity} />;
};
