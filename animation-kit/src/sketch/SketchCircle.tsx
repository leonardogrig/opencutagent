import React, { useMemo } from "react";
import { roughStrokes, roughOpts } from "./rough";
import { SketchStrokes } from "./SketchStrokes";
import { useDraw } from "./useDraw";
import { splitSketch, type CommonSketchProps } from "./common";

export const SketchCircle: React.FC<
  CommonSketchProps & { cx: number; cy: number; r: number }
> = (props) => {
  const { cx, cy, r } = props;
  const { rough, progress, drawIn, opacity } = splitSketch(props);
  const strokes = useMemo(
    () => roughStrokes((g) => g.circle(cx, cy, r * 2, roughOpts(rough))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cx, cy, r, JSON.stringify(rough)],
  );
  const p = useDraw(progress, drawIn);
  return <SketchStrokes strokes={strokes} progress={p} opacity={opacity} />;
};
