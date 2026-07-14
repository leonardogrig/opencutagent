/** Global timing conventions. Think in frames; derive from FPS. */
export const FPS = 30;

/**
 * Global animation pace multiplier. >1 = slower. Everything that flows through
 * SCENE()/paceFrames() slows together, so this one number tunes the whole feel.
 */
export const PACE = 1.5;

/** Seconds → whole frames (true real-time seconds — used for narration/media sync). */
export const SEC = (s: number): number => Math.round(s * FPS);

/**
 * Paced choreography: seconds → frames, stretched by PACE. Use this for
 * animation delays/durations inside scenes so the whole system slows together.
 */
export const SCENE = (s: number): number => Math.round(s * FPS * PACE);

/** Scale a raw frame count by PACE (for primitive default durations). */
export const paceFrames = (frames: number): number => Math.round(frames * PACE);

/** Common beat lengths (frames), paced. */
export const BEAT = {
  quick: SCENE(0.4),
  entrance: SCENE(0.6),
  draw: SCENE(1), // a stroke drawing on
  hold: SCENE(1.5), // minimum readable hold
  scene: SCENE(4),
  transition: SCENE(0.7),
} as const;
