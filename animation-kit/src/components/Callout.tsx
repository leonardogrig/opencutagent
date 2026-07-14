import React from "react";
import { SketchArrow, SketchText, type DrawIn } from "../sketch";
import { tokens } from "../theme/tokens";
import { SEEDS } from "../theme/seeds";

/**
 * An annotation: handwritten text at `at` plus a hand-drawn arrow pointing to
 * `target`. Coral by default. Lives inside a <SketchLayer>.
 */
export const Callout: React.FC<{
  text: string;
  at: [number, number];
  target: [number, number];
  color?: string;
  size?: number;
  anchor?: "start" | "middle" | "end";
  curve?: number;
  seed?: number;
  drawIn?: DrawIn;
}> = ({
  text,
  at,
  target,
  color = tokens.color.accent,
  size = tokens.fontSize.label,
  anchor = "middle",
  curve = 0.3,
  seed = SEEDS.arrow,
  drawIn,
}) => {
  const arrowDelay = (drawIn?.delay ?? 0) + 8;
  return (
    <g>
      <SketchText x={at[0]} y={at[1]} color={color} size={size} anchor={anchor} delay={drawIn?.delay ?? 0}>
        {text}
      </SketchText>
      <SketchArrow
        from={at}
        to={target}
        curve={curve}
        seed={seed}
        stroke={color}
        drawIn={{ delay: arrowDelay, duration: drawIn?.duration ?? 26 }}
      />
    </g>
  );
};
