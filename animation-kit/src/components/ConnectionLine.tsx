import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { getLength, getPointAtLength } from "@remotion/paths";
import { SketchPath, type DrawIn } from "../sketch";
import { tokens } from "../theme/tokens";
import { SEEDS } from "../theme/seeds";

/** A dot that travels along the connector to imply data flowing (looping). */
const PulseDot: React.FC<{ d: string; color: string; period?: number }> = ({
  d,
  color,
  period = 1.6,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const len = useMemo(() => getLength(d), [d]);
  const t = ((frame / fps) / period) % 1;
  const pt = getPointAtLength(d, t * len);
  return <circle cx={pt.x} cy={pt.y} r={7} fill={color} />;
};

/**
 * A curved bezier connector between two points (exits right, enters
 * left), drawn in the sketch style. Optional traveling "data pulse" dot.
 */
export const ConnectionLine: React.FC<{
  from: [number, number];
  to: [number, number];
  seed?: number;
  color?: string;
  drawIn?: DrawIn;
  pulse?: boolean;
  pulseColor?: string;
}> = ({
  from,
  to,
  seed = SEEDS.connection,
  color = tokens.color.inkMuted,
  drawIn,
  pulse = false,
  pulseColor = tokens.color.accent,
}) => {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const dx = Math.max(70, Math.abs(x2 - x1) * 0.5);
  const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  return (
    <g>
      <SketchPath d={d} seed={seed} stroke={color} strokeWidth={tokens.stroke.thin} roughness={0.9} drawIn={drawIn} />
      {pulse ? <PulseDot d={d} color={pulseColor} /> : null}
    </g>
  );
};
