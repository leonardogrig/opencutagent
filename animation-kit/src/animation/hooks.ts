import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { SPRINGS, EASING } from "../theme/springs";

export type SpringPreset = keyof typeof SPRINGS;

/** A spring driven by the named preset (0→1 by default). */
export const useSpringPreset = (
  preset: SpringPreset = "GENTLE",
  opts?: { delay?: number; durationInFrames?: number; from?: number; to?: number },
): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({
    frame,
    fps,
    config: SPRINGS[preset],
    delay: opts?.delay,
    durationInFrames: opts?.durationInFrames,
    from: opts?.from,
    to: opts?.to,
  });
};

/** A clamped 0→1 interpolation over [delay, delay+duration]. */
export const useProgress = (
  delay = 0,
  duration = 20,
  easing: (n: number) => number = EASING.entrance,
): number => {
  const frame = useCurrentFrame();
  return interpolate(frame, [delay, delay + duration], [0, 1], {
    easing,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
};
