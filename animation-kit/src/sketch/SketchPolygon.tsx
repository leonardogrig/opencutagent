import React, { useMemo } from "react";
import { roughStrokes, roughOpts } from "./rough";
import { SketchStrokes } from "./SketchStrokes";
import { useDraw } from "./useDraw";
import { splitSketch, type CommonSketchProps } from "./common";

export const SketchPolygon: React.FC<
  CommonSketchProps & { points: [number, number][] }
> = (props) => {
  const { points } = props;
  const { rough, progress, drawIn, opacity } = splitSketch(props);
  const strokes = useMemo(
    () => roughStrokes((g) => g.polygon(points, roughOpts(rough))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(points), JSON.stringify(rough)],
  );
  const p = useDraw(progress, drawIn);
  return <SketchStrokes strokes={strokes} progress={p} opacity={opacity} />;
};
