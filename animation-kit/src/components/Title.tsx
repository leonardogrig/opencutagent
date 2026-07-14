import React from "react";
import { tokens } from "../theme/tokens";

/** A handwritten headline block (HTML layer). Pair with WordReveal for motion. */
export const Title: React.FC<{
  children: React.ReactNode;
  size?: number;
  color?: string;
  align?: "left" | "center" | "right";
  weight?: number;
  font?: string;
  style?: React.CSSProperties;
}> = ({
  children,
  size = tokens.fontSize.h1,
  color = tokens.color.inkWhite,
  align = "left",
  weight = tokens.weight.regular,
  font = tokens.font.hand,
  style,
}) => (
  <div
    style={{ fontFamily: font, fontSize: size, color, fontWeight: weight, textAlign: align, lineHeight: 1.1, ...style }}
  >
    {children}
  </div>
);
