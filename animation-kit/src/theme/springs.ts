import { Easing } from "remotion";

/**
 * Named spring presets (feed to spring({ config })).
 * GENTLE = arrives & stops · SNAPPY = click · POP = tiny overshoot ·
 * BOUNCY = boing (sparingly) · HEAVY = weighty settle.
 */
export const SPRINGS = {
  GENTLE: { damping: 200 },
  SNAPPY: { damping: 20, stiffness: 200 },
  POP: { damping: 12, stiffness: 300, mass: 0.8 },
  BOUNCY: { damping: 8 },
  HEAVY: { damping: 15, stiffness: 60, mass: 2 },
} as const;

/** Named bezier easing curves (steal-from-design). Pass through `bezier()`. */
export const EASE = {
  entrance: [0.16, 1, 0.3, 1], // crisp ease-out, no overshoot
  editorial: [0.45, 0, 0.55, 1], // balanced in-out for slow fades
  overshoot: [0.34, 1.56, 0.64, 1], // playful past-then-settle
} as const;

type Curve = readonly [number, number, number, number];

/** Turn an EASE tuple into a Remotion easing fn. */
export const bezier = (c: Curve) => Easing.bezier(c[0], c[1], c[2], c[3]);

/** Convenience easing shorthands. */
export const EASING = {
  entrance: bezier(EASE.entrance),
  editorial: bezier(EASE.editorial),
  overshoot: bezier(EASE.overshoot),
  outCubic: Easing.out(Easing.cubic),
  inCubic: Easing.in(Easing.cubic),
  inOutCubic: Easing.inOut(Easing.cubic),
};
