import React from "react";
import { tokens } from "../theme/tokens";

/** A small handwritten inline label (HTML layer). */
export const Label: React.FC<{
  children: React.ReactNode;
  size?: number;
  color?: string;
  weight?: number;
  font?: string;
  style?: React.CSSProperties;
}> = ({
  children,
  size = tokens.fontSize.label,
  color = tokens.color.ink,
  weight = tokens.weight.regular,
  font = tokens.font.hand,
  style,
}) => (
  <span style={{ fontFamily: font, fontSize: size, color, fontWeight: weight, ...style }}>{children}</span>
);
