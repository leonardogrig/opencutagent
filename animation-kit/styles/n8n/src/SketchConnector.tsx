import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { getLength, getPointAtLength } from "@remotion/paths";
import { SketchPath, SketchText } from "../../../src/sketch";
import { seedFor } from "../../../src/theme/seeds";
import { SCENE } from "../../../src/theme/timing";
import { n8n } from "./theme";
import { ACTIVE_GREEN } from "./SketchNode";

/**
 * A hand-drawn connector between two node handles: draws on neutral, a pink
 * data-pulse travels along it, then it turns green (executed) with an optional
 * "N items" label. Same seed for both strokes so the green traces the neutral.
 * Note: the label clips behind the next node when nodes are close — omit it in
 * tight mini-workflows.
 */
export const SketchConnector: React.FC<{
  id: string;
  from: [number, number];
  to: [number, number];
  delay: number;
  duration?: number;
  activeDelay?: number;
  pulse?: boolean;
  label?: string;
}> = ({ id, from, to, delay, duration = SCENE(0.5), activeDelay, pulse = true, label }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seed = seedFor(id);

  const d = useMemo(() => {
    const [x1, y1] = from;
    const [x2, y2] = to;
    const dx = Math.max(70, Math.abs(x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }, [from, to]);
  const len = useMemo(() => getLength(d), [d]);

  const drawnAt = delay + duration;
  const active = activeDelay !== undefined && frame >= activeDelay;
  // continuous looping data-pulse once the connector is drawn (keeps the hold alive)
  const period = fps * 1.4;
  const loop = (frame - drawnAt) / period;
  const t = loop - Math.floor(loop);
  const showPulse = pulse && frame > drawnAt;
  const pt = showPulse ? getPointAtLength(d, t * len) : null;
  const pulseOpacity = interpolate(t, [0, 0.08, 0.9, 1], [0, 1, 1, 0]);

  return (
    <g>
      <SketchPath d={d} seed={seed} stroke={n8n.color.inkMuted} strokeWidth={n8n.stroke.thin} roughness={0.8} drawIn={{ delay, duration }} />
      {active ? (
        <SketchPath d={d} seed={seed} stroke={ACTIVE_GREEN} strokeWidth={n8n.stroke.thin} roughness={0.8} drawIn={{ delay: activeDelay, duration: 10 }} />
      ) : null}
      {pt ? <circle cx={pt.x} cy={pt.y} r={7} fill={n8n.color.accent} opacity={pulseOpacity} /> : null}
      {label && active ? (
        <SketchText x={(from[0] + to[0]) / 2} y={Math.min(from[1], to[1]) - 22} size={22} color={n8n.color.inkMuted} anchor="middle" delay={activeDelay}>
          {label}
        </SketchText>
      ) : null}
    </g>
  );
};
