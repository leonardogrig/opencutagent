import type { RoughInput } from "./rough";
import type { DrawIn } from "./useDraw";

/** Props shared by every sketch primitive. */
export type CommonSketchProps = RoughInput & {
  /** Explicit draw progress 0..1 (overrides drawIn). */
  progress?: number;
  /** Frame-based self-drawing timing. */
  drawIn?: DrawIn;
  /** Group opacity. */
  opacity?: number;
};

/** Split common props into { rough options, timing }. */
export const splitSketch = <T extends CommonSketchProps>(
  props: T,
): { rough: RoughInput; progress?: number; drawIn?: DrawIn; opacity?: number } => {
  const { progress, drawIn, opacity, seed, stroke, strokeWidth, fill, fillStyle, fillWeight, hachureGap, roughness, bowing } = props;
  return {
    rough: { seed, stroke, strokeWidth, fill, fillStyle, fillWeight, hachureGap, roughness, bowing },
    progress,
    drawIn,
    opacity,
  };
};
