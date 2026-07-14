import React from "react";
import { useVideoConfig } from "remotion";

/**
 * A full-frame SVG whose viewBox matches the composition, so sketch primitives
 * can be placed in pixel coordinates (0,0 = top-left … width,height). Overflow
 * is visible so hand-drawn strokes near the edges aren't clipped.
 */
export const SketchLayer: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({
  children,
  style,
}) => {
  const { width, height } = useVideoConfig();
  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: "absolute", inset: 0, overflow: "visible", ...style }}
    >
      {children}
    </svg>
  );
};
