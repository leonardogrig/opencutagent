import React, { useMemo } from "react";
import { roughStrokes, roughOpts } from "./rough";
import { SketchStrokes } from "./SketchStrokes";
import { useDraw } from "./useDraw";
import { splitSketch, type CommonSketchProps } from "./common";

export const SketchEllipse: React.FC<
  CommonSketchProps & { cx: number; cy: number; rx: number; ry: number }
> = (props) => {
  const { cx, cy, rx, ry } = props;
  const { rough, progress, drawIn, opacity } = splitSketch(props);
  const strokes = useMemo(
    () => roughStrokes((g) => g.ellipse(cx, cy, rx * 2, ry * 2, roughOpts(rough))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cx, cy, rx, ry, JSON.stringify(rough)],
  );
  const p = useDraw(progress, drawIn);
  return <SketchStrokes strokes={strokes} progress={p} opacity={opacity} />;
};
