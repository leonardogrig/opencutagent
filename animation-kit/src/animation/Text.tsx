import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { EASING } from "../theme/springs";
import { tokens } from "../theme/tokens";
import { paceFrames } from "../theme/timing";
import { useSpringPreset } from "./hooks";

/** Typewriter reveal via string slicing (never per-char opacity). */
export const Typewriter: React.FC<{
  text: string;
  delay?: number;
  cps?: number; // characters per second
  cursor?: boolean;
  style?: React.CSSProperties;
}> = ({ text, delay = 0, cps = 20, cursor = true, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsed = Math.max(0, frame - delay);
  const chars = Math.floor((elapsed / fps) * cps);
  const shown = text.slice(0, chars);
  const period = Math.max(1, Math.round(fps * 0.5));
  const blink = interpolate(frame % period, [0, period / 2, period], [1, 0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <span style={style}>
      {shown}
      {cursor ? <span style={{ opacity: blink }}>▌</span> : null}
    </span>
  );
};

/** Per-word fade + rise stagger. */
export const WordReveal: React.FC<{
  text: string;
  delay?: number;
  each?: number;
  per?: number;
  rise?: number;
  style?: React.CSSProperties;
}> = ({ text, delay = 0, each = paceFrames(4), per = paceFrames(14), rise = 14, style }) => {
  const frame = useCurrentFrame();
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "0.25em", ...style }}>
      {text.split(" ").map((w, i) => {
        const start = delay + i * each;
        const p = interpolate(frame, [start, start + per], [0, 1], {
          easing: EASING.outCubic,
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        return (
          <span key={i} style={{ display: "inline-block", opacity: p, translate: `0px ${(1 - p) * rise}px` }}>
            {w}
          </span>
        );
      })}
    </span>
  );
};

/** Marker-swipe highlight behind inline text (scaleX spring from the left). */
export const Highlighter: React.FC<{
  delay?: number;
  color?: string;
  opacity?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ delay = 0, color = tokens.color.accent, opacity = 0.35, children, style }) => {
  const s = useSpringPreset("GENTLE", { delay });
  return (
    <span style={{ position: "relative", display: "inline-block", ...style }}>
      <span
        style={{
          position: "absolute",
          left: -8,
          right: -8,
          top: "16%",
          bottom: "6%",
          background: color,
          opacity,
          transformOrigin: "left center",
          scale: `${s} 1`,
          borderRadius: 6,
          zIndex: 0,
        }}
      />
      <span style={{ position: "relative", zIndex: 1 }}>{children}</span>
    </span>
  );
};
