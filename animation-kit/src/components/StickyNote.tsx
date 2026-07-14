import React from "react";
import { SketchRect, type DrawIn } from "../sketch";
import { tokens } from "../theme/tokens";
import { SEEDS } from "../theme/seeds";

/**
 * A sticky note: solid soft-yellow card with a hand-drawn border and
 * handwritten text. Provide line breaks in `text` (\n) for multi-line bodies.
 */
export const StickyNote: React.FC<{
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  title?: string;
  seed?: number;
  drawIn?: DrawIn;
  bg?: string;
  border?: string;
  color?: string;
}> = ({
  x,
  y,
  width = 380,
  height = 300,
  text = "",
  title,
  seed = SEEDS.sticky,
  drawIn,
  bg = tokens.color.stickyBg,
  border = tokens.color.stickyBorder,
  color = tokens.color.stickyText,
}) => {
  const lines = text.length ? text.split("\n") : [];
  const bodyTop = y + (title ? 96 : 52);
  return (
    <g>
      <SketchRect
        x={x}
        y={y}
        width={width}
        height={height}
        radius={8}
        seed={seed}
        fill={bg}
        fillStyle="solid"
        stroke={border}
        strokeWidth={tokens.stroke.thin}
        drawIn={drawIn}
      />
      {title ? (
        <text
          x={x + 28}
          y={y + 52}
          fill={color}
          fontFamily={tokens.font.hand}
          fontSize={36}
          fontWeight={tokens.weight.bold}
        >
          {title}
        </text>
      ) : null}
      {lines.length ? (
        <text x={x + 28} y={bodyTop} fill={color} fontFamily={tokens.font.hand} fontSize={30}>
          {lines.map((ln, i) => (
            <tspan key={i} x={x + 28} dy={i === 0 ? 0 : 42}>
              {ln}
            </tspan>
          ))}
        </text>
      ) : null}
    </g>
  );
};
