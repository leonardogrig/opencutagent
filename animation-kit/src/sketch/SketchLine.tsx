import React, { useMemo } from "react";
import { roughStrokes, roughOpts } from "./rough";
import { SketchStrokes } from "./SketchStrokes";
import { useDraw } from "./useDraw";
import { splitSketch, type CommonSketchProps } from "./common";

export const SketchLine: React.FC<
  CommonSketchProps & { x1: number; y1: number; x2: number; y2: number }
> = (props) => {
  const { x1, y1, x2, y2 } = props;
  const { rough, progress, drawIn, opacity } = splitSketch(props);
  const strokes = useMemo(
    () => roughStrokes((g) => g.line(x1, y1, x2, y2, roughOpts(rough))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [x1, y1, x2, y2, JSON.stringify(rough)],
  );
  const p = useDraw(progress, drawIn);
  return <SketchStrokes strokes={strokes} progress={p} opacity={opacity} />;
};
