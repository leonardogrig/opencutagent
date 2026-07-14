import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { useSpringPreset } from "./hooks";

/** Subtle camera push/pan on the whole scene. Keep amplitudes small. */
export const CameraMove: React.FC<{
  children: React.ReactNode;
  zoom?: number;
  panX?: number;
  panY?: number;
  originX?: string;
  originY?: string;
  delay?: number;
  durationInFrames?: number;
}> = ({
  children,
  zoom = 1.08,
  panX = 0,
  panY = 0,
  originX = "50%",
  originY = "50%",
  delay = 0,
  durationInFrames = 90,
}) => {
  const s = useSpringPreset("HEAVY", { delay, durationInFrames });
  const scale = interpolate(s, [0, 1], [1, zoom]);
  const x = interpolate(s, [0, 1], [0, panX]);
  const y = interpolate(s, [0, 1], [0, panY]);
  return (
    <AbsoluteFill style={{ scale, translate: `${x}px ${y}px`, transformOrigin: `${originX} ${originY}` }}>
      {children}
    </AbsoluteFill>
  );
};

/** Looping emphasis pulse (frame-pure sinusoid). Optional colored glow. */
export const Pulse: React.FC<{
  children: React.ReactNode;
  hz?: number;
  amount?: number;
  glow?: string;
  style?: React.CSSProperties;
}> = ({ children, hz = 0.8, amount = 0.06, glow, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const scale = 1 + amount * Math.sin(t * Math.PI * 2 * hz);
  const g = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * hz);
  return (
    <div style={{ scale, filter: glow ? `drop-shadow(0 0 ${8 + g * 12}px ${glow})` : undefined, ...style }}>
      {children}
    </div>
  );
};
