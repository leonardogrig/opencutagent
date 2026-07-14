import React, { useMemo } from "react";
import { roughStrokes, roughOpts } from "./rough";
import { SketchStrokes } from "./SketchStrokes";
import { useDraw } from "./useDraw";
import { splitSketch, type CommonSketchProps } from "./common";

/** Any SVG path `d`, roughened. */
export const SketchPath: React.FC<CommonSketchProps & { d: string }> = (props) => {
  const { d } = props;
  const { rough, progress, drawIn, opacity } = splitSketch(props);
  const strokes = useMemo(
    () => roughStrokes((g) => g.path(d, roughOpts(rough))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d, JSON.stringify(rough)],
  );
  const p = useDraw(progress, drawIn);
  return <SketchStrokes strokes={strokes} progress={p} opacity={opacity} />;
};
