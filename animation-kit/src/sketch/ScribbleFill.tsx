import React, { useMemo } from "react";
import { roughStrokes, roughOpts } from "./rough";
import { SketchStrokes } from "./SketchStrokes";
import { useDraw } from "./useDraw";
import { splitSketch, type CommonSketchProps } from "./common";
import { tokens } from "../theme/tokens";

/**
 * Fills a region path with a hand-drawn scribble (zigzag / hachure / cross-hatch).
 * The fill lines are strokes, so they "scribble in" via the same draw-on engine.
 * This is the coral highlight in the Venn scene.
 */
export const ScribbleFill: React.FC<CommonSketchProps & { d: string }> = (props) => {
  const { d } = props;
  const { rough, progress, drawIn, opacity } = splitSketch(props);
  const strokes = useMemo(
    () =>
      roughStrokes((g) =>
        g.path(
          d,
          roughOpts({
            ...rough,
            stroke: "none",
            fill: rough.fill ?? tokens.color.accent,
            fillStyle: rough.fillStyle ?? "zigzag",
            fillWeight: rough.fillWeight ?? tokens.stroke.base,
            hachureGap: rough.hachureGap ?? 12,
            roughness: rough.roughness ?? 2.2,
          }),
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d, JSON.stringify(rough)],
  );
  const p = useDraw(progress, drawIn);
  return <SketchStrokes strokes={strokes} progress={p} opacity={opacity} />;
};
