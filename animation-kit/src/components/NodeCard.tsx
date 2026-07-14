import React from "react";
import { SketchRect, SketchCircle, SketchText, type DrawIn } from "../sketch";
import { tokens } from "../theme/tokens";
import { SEEDS } from "../theme/seeds";

/**
 * A workflow-style node card rendered in the sketch style: a solid dark rounded card
 * with a hand-drawn border, an integration-color accent dot, a title, and
 * input/output connection handles. Lives inside a <SketchLayer>.
 */
export const NodeCard: React.FC<{
  x: number;
  y: number;
  width?: number;
  height?: number;
  title: string;
  subtitle?: string;
  accent?: string;
  seed?: number;
  drawIn?: DrawIn;
  inputHandle?: boolean;
  outputHandle?: boolean;
}> = ({
  x,
  y,
  width = 400,
  height = 130,
  title,
  subtitle,
  accent = tokens.color.orange,
  seed = SEEDS.nodeCard,
  drawIn,
  inputHandle = true,
  outputHandle = true,
}) => {
  const cy = y + height / 2;
  return (
    <g>
      <SketchRect
        x={x}
        y={y}
        width={width}
        height={height}
        radius={16}
        seed={seed}
        fill={tokens.color.surface}
        fillStyle="solid"
        stroke={tokens.color.ink}
        strokeWidth={tokens.stroke.thin}
        drawIn={drawIn}
      />
      <SketchCircle
        cx={x + 46}
        cy={cy}
        r={20}
        seed={seed + 1}
        stroke={accent}
        fill={accent}
        fillStyle="solid"
        drawIn={drawIn}
      />
      <SketchText
        x={x + 88}
        y={subtitle ? cy - 16 : cy}
        anchor="start"
        size={42}
        color={tokens.color.inkWhite}
      >
        {title}
      </SketchText>
      {subtitle ? (
        <SketchText x={x + 88} y={cy + 24} anchor="start" size={26} color={tokens.color.inkMuted}>
          {subtitle}
        </SketchText>
      ) : null}
      {inputHandle ? (
        <SketchCircle cx={x} cy={cy} r={10} seed={seed + 2} stroke={tokens.color.inkMuted} drawIn={drawIn} />
      ) : null}
      {outputHandle ? (
        <SketchCircle
          cx={x + width}
          cy={cy}
          r={10}
          seed={seed + 3}
          stroke={tokens.color.inkMuted}
          drawIn={drawIn}
        />
      ) : null}
    </g>
  );
};
