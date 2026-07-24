import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { SketchRect, SketchCircle, SketchText, SketchPath } from "../../../src/sketch";
import type { DrawIn } from "../../../src/sketch";
import { seedFor } from "../../../src/theme/seeds";
import { n8n } from "./theme";

/** n8n "executed" green. */
export const ACTIVE_GREEN = n8n.color.activeGreen;

export type SketchNodeData = {
  id: string;
  x: number;
  y: number;
  title: string;
  subtitle?: string;
  accent?: string;
  /** hollow accent ring (like the AI-agent node) instead of a filled dot. */
  hollow?: boolean;
  trigger?: boolean;
};

/**
 * A workflow node in the n8n brand's HAND-DRAWN style: a sketchy tile with a
 * centered brand-colored dot and the name BELOW it (n8n's real layout). Square
 * by default; pass a wider `w` for the AI-agent (the only rectangular node).
 * "Executed" = green sketch border (no checkmark). NOT a clone of the real UI.
 */
export const SketchNode: React.FC<
  SketchNodeData & { w?: number; h?: number; drawIn?: DrawIn; activeDelay?: number }
> = ({
  x,
  y,
  title,
  subtitle,
  accent = n8n.color.accent,
  hollow = false,
  trigger = false,
  id,
  w = 140,
  h = 140,
  drawIn = { delay: 0, duration: 30 },
  activeDelay,
}) => {
  const frame = useCurrentFrame();
  const seed = seedFor(id);
  const left = x - w / 2;
  const top = y - h / 2;
  const labelDelay = (drawIn.delay ?? 0) + 6;
  const active = activeDelay !== undefined && frame >= activeDelay;

  // node draw progress → handles appear with the body (after the skeleton), not before it
  const p = interpolate(frame, [drawIn.delay ?? 0, (drawIn.delay ?? 0) + (drawIn.duration ?? 30)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const handleOpacity = interpolate(p, [0.55, 0.85], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <g>
      {/* tile */}
      <SketchRect
        x={left}
        y={top}
        width={w}
        height={h}
        radius={18}
        seed={seed}
        fill={n8n.color.surface}
        fillStyle="solid"
        stroke={n8n.color.ink}
        strokeWidth={n8n.stroke.thin}
        drawIn={drawIn}
      />

      {/* centered accent dot / ring (brand mark, not a real logo) */}
      <SketchCircle
        cx={x}
        cy={y}
        r={hollow ? 24 : 28}
        seed={seed + 1}
        stroke={accent}
        fill={hollow ? undefined : accent}
        fillStyle={hollow ? undefined : "solid"}
        strokeWidth={hollow ? 5 : n8n.stroke.thin}
        drawIn={drawIn}
      />

      {/* name + sublabel BELOW the tile */}
      <SketchText x={x} y={top + h + 40} anchor="middle" size={31} color={n8n.color.inkWhite} delay={labelDelay}>
        {title}
      </SketchText>
      {subtitle ? (
        <SketchText x={x} y={top + h + 72} anchor="middle" size={22} color={n8n.color.inkMuted} delay={labelDelay + 3}>
          {subtitle}
        </SketchText>
      ) : null}

      {/* connection handles */}
      {!trigger ? <circle cx={left} cy={y} r={9} fill={n8n.color.surfaceAlt} stroke={n8n.color.portStroke} strokeWidth={2} opacity={handleOpacity} /> : null}
      <circle cx={left + w} cy={y} r={9} fill={n8n.color.surfaceAlt} stroke={n8n.color.portStroke} strokeWidth={2} opacity={handleOpacity} />

      {/* trigger bolt */}
      {trigger ? (
        <SketchPath
          d={`M ${left - 32} ${y - 15} L ${left - 46} ${y + 3} L ${left - 37} ${y + 3} L ${left - 42} ${y + 18} L ${left - 26} ${y - 5} L ${left - 35} ${y - 5} Z`}
          seed={seed + 5}
          stroke={n8n.color.orange}
          fill={n8n.color.orange}
          fillStyle="solid"
          strokeWidth={2}
          drawIn={drawIn}
        />
      ) : null}

      {/* executed: green sketch border only (no checkmark) */}
      {active ? (
        <SketchRect
          x={left - 7}
          y={top - 7}
          width={w + 14}
          height={h + 14}
          radius={22}
          seed={seed + 9}
          stroke={ACTIVE_GREEN}
          strokeWidth={n8n.stroke.base}
          drawIn={{ delay: activeDelay, duration: 12 }}
        />
      ) : null}
    </g>
  );
};
