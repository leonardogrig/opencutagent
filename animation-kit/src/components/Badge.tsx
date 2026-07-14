import React from "react";
import { tokens } from "../theme/tokens";

/** A small pill tag (uses the clean UI font). */
export const Badge: React.FC<{
  children: React.ReactNode;
  color?: string;
  bg?: string;
  style?: React.CSSProperties;
}> = ({ children, color = tokens.color.bg, bg = tokens.color.accent, style }) => (
  <span
    style={{
      display: "inline-block",
      fontFamily: tokens.font.ui,
      fontSize: tokens.fontSize.caption,
      fontWeight: tokens.weight.bold,
      color,
      background: bg,
      borderRadius: tokens.radius.pill,
      padding: "8px 22px",
      ...style,
    }}
  >
    {children}
  </span>
);
