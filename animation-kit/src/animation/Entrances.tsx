import React from "react";
import { interpolate } from "remotion";
import { EASING } from "../theme/springs";
import { paceFrames } from "../theme/timing";
import { useProgress, useSpringPreset, type SpringPreset } from "./hooks";

type Base = { delay?: number; duration?: number; children: React.ReactNode; style?: React.CSSProperties };

/** Fade opacity 0→1. */
export const FadeIn: React.FC<Base> = ({ delay = 0, duration = paceFrames(18), children, style }) => {
  const opacity = useProgress(delay, duration);
  return <div style={{ opacity, ...style }}>{children}</div>;
};

/** Rise up + fade in. */
export const RiseIn: React.FC<Base & { distance?: number }> = ({
  delay = 0,
  duration = paceFrames(20),
  distance = 28,
  children,
  style,
}) => {
  const p = useProgress(delay, duration);
  return (
    <div style={{ opacity: p, translate: `0px ${(1 - p) * distance}px`, ...style }}>{children}</div>
  );
};

/** Alias — the default entrance (fade + rise). */
export const FadeRiseIn = RiseIn;

/** Scale up from `from`→1 with a spring + fade (a satisfying pop). */
export const PopIn: React.FC<Base & { from?: number; preset?: SpringPreset }> = ({
  delay = 0,
  from = 0.8,
  preset = "POP",
  children,
  style,
}) => {
  const s = useSpringPreset(preset, { delay });
  const scale = interpolate(s, [0, 1], [from, 1]);
  return <div style={{ scale, opacity: s, ...style }}>{children}</div>;
};
