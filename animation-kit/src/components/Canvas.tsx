import React from "react";
import { AbsoluteFill } from "remotion";
import { tokens } from "../theme/tokens";
import { DotGrid } from "./DotGrid";

/**
 * The root of every scene: a full-frame dark canvas with the dot-grid on by
 * default. Children render on top. `transparent` disables both the background
 * and the grid so the animation can overlay footage (alpha render).
 */
export const Canvas: React.FC<{
  children?: React.ReactNode;
  bg?: string;
  dotGrid?: boolean;
  transparent?: boolean;
  dotColor?: string;
  dotGap?: number;
  dotOpacity?: number;
  style?: React.CSSProperties;
}> = ({
  children,
  transparent = false,
  bg = tokens.color.bg,
  dotGrid = true,
  dotColor = tokens.color.dotGrid,
  dotGap = 30,
  dotOpacity = 1,
  style,
}) => (
  <AbsoluteFill style={{ backgroundColor: transparent ? "transparent" : bg, ...style }}>
    {dotGrid && !transparent ? (
      <DotGrid color={dotColor} gap={dotGap} opacity={dotOpacity} />
    ) : null}
    {children}
  </AbsoluteFill>
);
