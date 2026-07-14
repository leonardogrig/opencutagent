import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { tokens } from "../theme/tokens";
import { EASING } from "../theme/springs";
import { paceFrames } from "../theme/timing";

/**
 * Handwritten SVG text label, in the same coordinate space as the sketch shapes
 * (so it anchors to geometry). Optional fade + rise when `delay` is given.
 */
export const SketchText: React.FC<{
  x: number;
  y: number;
  children: string;
  size?: number;
  color?: string;
  anchor?: "start" | "middle" | "end";
  weight?: number;
  font?: string;
  delay?: number;
  duration?: number;
  rise?: number;
  opacity?: number;
}> = ({
  x,
  y,
  children,
  size = tokens.fontSize.label,
  color = tokens.color.ink,
  anchor = "middle",
  weight = tokens.weight.regular,
  font = tokens.font.hand,
  delay,
  duration = paceFrames(14),
  rise = 16,
  opacity,
}) => {
  const frame = useCurrentFrame();
  let o = opacity ?? 1;
  let dy = 0;
  if (delay !== undefined) {
    const pr = interpolate(frame, [delay, delay + duration], [0, 1], {
      easing: EASING.entrance,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    o = (opacity ?? 1) * pr;
    dy = (1 - pr) * rise;
  }
  return (
    <text
      x={x}
      y={y + dy}
      fill={color}
      fontFamily={font}
      fontSize={size}
      fontWeight={weight}
      textAnchor={anchor}
      dominantBaseline="middle"
      opacity={o}
      style={{ whiteSpace: "pre" }}
    >
      {children}
    </text>
  );
};
