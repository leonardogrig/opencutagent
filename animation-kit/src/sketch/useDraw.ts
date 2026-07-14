import { useCurrentFrame, interpolate, Easing } from "remotion";
import { paceFrames } from "../theme/timing";

export type DrawIn = {
  delay?: number;
  duration?: number;
  easing?: (n: number) => number;
};

/**
 * Resolve draw progress (0..1) from either an explicit `progress` value or a
 * frame-based `drawIn` timing. If neither is given, the shape is fully drawn.
 * Always calls useCurrentFrame() (hook-safe), then branches.
 */
export const useDraw = (progress?: number, drawIn?: DrawIn): number => {
  const frame = useCurrentFrame();
  if (typeof progress === "number") return Math.max(0, Math.min(1, progress));
  if (drawIn) {
    const { delay = 0, duration = paceFrames(30), easing = Easing.out(Easing.cubic) } = drawIn;
    return interpolate(frame, [delay, delay + duration], [0, 1], {
      easing,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }
  return 1;
};
