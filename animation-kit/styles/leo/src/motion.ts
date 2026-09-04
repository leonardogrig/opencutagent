/**
 * Idle life: blinks, breathing, talking bob, the occasional glance. All of it is
 * a pure function of (time, seed), so a frame renders the same twice and a
 * re-render never changes the performance.
 */
import { SpeechPlan, isSpeaking, openness, sinceOnset, visemeAt } from "./lipsync";

/** Deterministic 0..1 from an integer + seed. */
export function hash01(n: number, seed = 1): number {
  let h = (n * 374761393 + seed * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

const BLINK_MIN = 2.4;
const BLINK_MAX = 5.2;
const BLINK_CLOSED_SEC = 0.1;

/**
 * The k-th blink time for a seed. Intervals are drawn per blink, so the
 * schedule is irregular but fixed.
 */
export function blinkTime(k: number, seed = 1): number {
  let t = 0.9 + hash01(0, seed) * 1.4;
  for (let i = 1; i <= k; i++) t += BLINK_MIN + hash01(i, seed) * (BLINK_MAX - BLINK_MIN);
  return t;
}

/** True while the eyes are shut for a blink at time t. */
export function isBlinking(t: number, seed = 1): boolean {
  if (t < 0) return false;
  // walk the schedule (cheap: ~one blink every 4s)
  let time = 0.9 + hash01(0, seed) * 1.4;
  for (let i = 1; i < 4000; i++) {
    if (t < time) return false;
    if (t < time + BLINK_CLOSED_SEC) return true;
    time += BLINK_MIN + hash01(i, seed) * (BLINK_MAX - BLINK_MIN);
  }
  return false;
}

/** Slow breathing, 0..1, ~3.6s period. */
export function breath(t: number): number {
  return 0.5 + 0.5 * Math.sin((t / 3.6) * Math.PI * 2 - Math.PI / 2);
}

/**
 * Whole-sprite vertical bob in sprite pixels while talking: a 1px dip on each
 * word onset that decays, plus the breath lifting the bust by a pixel at rest.
 */
export function talkBob(plan: SpeechPlan | null, t: number): number {
  let bob = 0;
  if (plan && plan.onsets.length) {
    const since = sinceOnset(plan, t);
    if (since < 0.09) bob += 1;
    else if (since < 0.16 && openness(visemeAt(plan, t)) >= 0.7) bob += 1;
  }
  return bob;
}

/**
 * Occasional sideways glance when NOT talking: head shear -1/0/1 held for
 * ~0.8s every 5-9s. Returns 0 while speaking so the face stays on the viewer.
 */
export function idleTurn(t: number, seed = 1, plan: SpeechPlan | null = null): number {
  if (t < 0 || (plan && isSpeaking(plan, t))) return 0;
  let time = 2.5 + hash01(100, seed) * 3;
  for (let i = 1; i < 2000; i++) {
    if (t < time) return 0;
    if (t < time + 0.8) return hash01(200 + i, seed) < 0.5 ? -1 : 1;
    time += 5 + hash01(300 + i, seed) * 4;
  }
  return 0;
}

/** Snap a continuous value to the sprite's pixel grid (retro motion never sub-pixels). */
export function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
}
