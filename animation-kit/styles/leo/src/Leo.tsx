import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { tokens } from "../../../src/theme/tokens";
import { SPRITE_H, SPRITE_W } from "./palette";
import { BrowKind, EyeKind, HairKind, SpritePose, Viseme, buildSprite, gridRuns } from "./sprite";
import { Word, inQuestion, isSpeaking, planSpeech, visemeAt } from "./lipsync";
import { breath, idleTurn, isBlinking, snap, talkBob } from "./motion";

/** Style tokens the accompanying graphics use (the sprite has its own palette). */
export const LEO = {
  bg: tokens.color.bg,
  accent: "#EC6A41",
  panel: "#1C1A1D",
  panelEdge: "#3A3740",
  ink: tokens.color.ink,
  inkWhite: tokens.color.inkWhite,
  inkMuted: tokens.color.inkMuted,
  font: tokens.font.ui,
} as const;

export type Mood = "neutral" | "happy" | "think" | "surprised" | "laugh";

const MOODS: Record<Mood, { eyes: EyeKind; brow: BrowKind; mouth: Viseme; gazeX?: number; gazeY?: number }> = {
  neutral:   { eyes: "open",   brow: "rest",   mouth: "rest" },
  happy:     { eyes: "squint", brow: "rest",   mouth: "smile" },
  think:     { eyes: "open",   brow: "furrow", mouth: "mm", gazeX: -1, gazeY: -1 },
  surprised: { eyes: "wide",   brow: "raised", mouth: "oh" },
  laugh:     { eyes: "squint", brow: "raised", mouth: "laugh" },
};

export type LeoProps = {
  /** Word timings (seconds relative to the animation start). Drives the mouth. */
  words?: Word[];
  /** Subtract this many seconds from the scene clock (Leo inside a <Sequence from>). */
  timeOffset?: number;
  /** Rendered height in px; snapped to a whole multiple of the 64px sprite so pixels stay square. */
  height?: number;
  hair?: HairKind;
  /** Resting face while not talking (eyes/brows stay through speech). */
  mood?: Mood;
  /** Where the eyes point: -1 left .. 1 right, and up/down. */
  look?: { x?: number; y?: number };
  /** Manual overrides, win over everything (for a deliberate held expression). */
  pose?: Partial<SpritePose>;
  /** Blinks, breathing, glances. Default on. */
  idle?: boolean;
  /** Mirror horizontally so he faces the other way. */
  flip?: boolean;
  seed?: number;
  style?: React.CSSProperties;
};

/** Integer pixel scale for a wanted height. */
export function pixelScale(height: number): number {
  return Math.max(1, Math.round(height / SPRITE_H));
}

/**
 * The character. Everything on his face is a function of the current frame:
 * the mouth follows `words`, blinks/breath/glances come from a seeded schedule,
 * `mood` sets the resting face, `look` the gaze.
 */
export const Leo: React.FC<LeoProps> = ({
  words, timeOffset = 0, height = 384, hair = "curls", mood = "neutral", look, pose, idle = true, flip = false, seed = 7, style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps - timeOffset;
  const plan = useMemo(() => (words && words.length ? planSpeech(words) : null), [words]);

  const m = MOODS[mood] ?? MOODS.neutral;
  const talking = plan ? isSpeaking(plan, t) : false;
  const mouth: Viseme = pose?.mouth ?? (plan && talking ? visemeAt(plan, t) : m.mouth);
  const blinking = idle && isBlinking(t, seed);
  const eyes: EyeKind = pose?.eyes ?? (blinking ? "closed" : m.eyes);
  const brow: BrowKind = pose?.brow ?? (plan && inQuestion(plan, t) ? "raised" : m.brow);
  const gazeX = pose?.gazeX ?? look?.x ?? m.gazeX ?? 0;
  const gazeY = pose?.gazeY ?? look?.y ?? m.gazeY ?? 0;
  const headDx = pose?.headDx ?? (idle ? idleTurn(t, seed, plan) : 0);

  const grid = buildSprite({ hair, eyes, brow, mouth, gazeX, gazeY, headDx });
  const runs = useMemo(() => gridRuns(grid), [grid]);

  const scale = pixelScale(height);
  const w = SPRITE_W * scale, h = SPRITE_H * scale;
  const bob = (idle ? talkBob(plan, t) : 0) - (idle && !talking && breath(t) > 0.5 ? 1 : 0);

  return (
    <div style={{ width: w, height: h, position: "relative", ...style }}>
      <svg
        viewBox={`0 0 ${SPRITE_W} ${SPRITE_H}`}
        width={w}
        height={h}
        shapeRendering="crispEdges"
        style={{ display: "block", transform: `translateY(${bob * scale}px)${flip ? " scaleX(-1)" : ""}` }}
      >
        {runs.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
        ))}
      </svg>
    </div>
  );
};

export type Corner = "bottom-left" | "bottom-right";

export type LeoCornerProps = LeoProps & {
  corner?: Corner;
  /** Height as a fraction of the canvas height (default 0.3). */
  size?: number;
  /** Frame he starts sliding in (default 0) and the frame he is fully gone (default: the end). */
  enterAt?: number;
  exitAt?: number;
  /** Slide duration in frames. */
  slideFrames?: number;
};

/**
 * Stream-cam placement: Leo sits flush with the bottom edge in a corner, slides
 * up into frame at `enterAt` and drops out again before `exitAt`. Movement is
 * snapped to the sprite's pixel grid so the slide reads as pixel motion.
 */
export const LeoCorner: React.FC<LeoCornerProps> = ({
  corner = "bottom-left", size = 0.3, enterAt = 0, exitAt, slideFrames = 12, style, ...leo
}) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const scale = pixelScale(height * size);
  const h = SPRITE_H * scale;
  const out = exitAt ?? durationInFrames + slideFrames; // default: never leaves
  const margin = Math.round((width * 0.02) / scale) * scale;

  const enter = interpolate(frame, [enterAt, enterAt + slideFrames], [h, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const leave = interpolate(frame, [out - slideFrames, out], [0, h], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const dy = snap(Math.max(enter, leave), scale);
  if (dy >= h) return null;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          bottom: -dy,
          ...(corner === "bottom-left" ? { left: margin } : { right: margin }),
          ...style,
        }}
      >
        <Leo {...leo} height={h} flip={leo.flip ?? corner === "bottom-right"} />
      </div>
    </AbsoluteFill>
  );
};

/**
 * A chunky pixel-styled panel for the few words that accompany Leo: dark plate,
 * light edge, an Ember bar. Pops in stepped (2 frames per step) like a
 * dialogue box. Children are plain React (Inter), so keep the text short.
 */
export const PixelPanel: React.FC<{
  x: number;
  y: number;
  width?: number;
  scale?: number;
  showAt?: number;
  hideAt?: number;
  accent?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ x, y, width, scale = 6, showAt = 0, hideAt, children, accent = true, style }) => {
  const frame = useCurrentFrame();
  if (frame < showAt || (hideAt != null && frame >= hideAt)) return null;
  const step = Math.min(3, Math.floor((frame - showAt) / 2)); // 0..3 over 6 frames
  const grow = [0.4, 0.7, 0.9, 1][step];
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        transform: `scale(${grow})`,
        transformOrigin: "left center",
        background: LEO.panel,
        border: `${scale}px solid ${LEO.panelEdge}`,
        boxShadow: `${scale}px ${scale}px 0 ${LEO.bg}`,
        padding: `${scale * 2}px ${scale * 3}px`,
        color: LEO.inkWhite,
        fontFamily: LEO.font,
        fontWeight: 600,
        fontSize: scale * 6,
        lineHeight: 1.25,
        ...style,
      }}
    >
      {accent ? <div style={{ position: "absolute", left: -scale, top: -scale, bottom: -scale, width: scale * 2, background: LEO.accent }} /> : null}
      {children}
    </div>
  );
};
