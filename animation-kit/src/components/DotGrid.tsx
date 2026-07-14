import React from "react";
import { AbsoluteFill } from "remotion";
import { tokens } from "../theme/tokens";

/** Whiteboard dot-grid (CSS radial-gradient, cheap & frame-pure). */
export const DotGrid: React.FC<{
  color?: string;
  gap?: number;
  radius?: number;
  opacity?: number;
}> = ({ color = tokens.color.dotGrid, gap = 30, radius = 1.1, opacity = 1 }) => (
  <AbsoluteFill
    style={{
      opacity,
      backgroundImage: `radial-gradient(circle at center, ${color} ${radius}px, transparent ${radius}px)`,
      backgroundSize: `${gap}px ${gap}px`,
      backgroundPosition: `${gap / 2}px ${gap / 2}px`,
    }}
  />
);
