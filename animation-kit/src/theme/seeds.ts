/**
 * rough.js seed registry.
 *
 * A fixed seed is part of a shape's identity: with seed 0 (the default) rough.js
 * re-randomizes every call, so in Remotion — where every frame re-renders — the
 * sketch would "boil". NEVER generate a seed at render time; use one of these or
 * `seedFor(stableKey)`.
 */
export const SEEDS = {
  circleA: 11,
  circleB: 23,
  circleC: 42,
  circleD: 58,
  lens: 7,
  arrow: 5,
  nodeCard: 31,
  sticky: 17,
  underline: 3,
  box: 9,
  connection: 27,
  bullet: 13,
} as const;

/**
 * Deterministic seed from a stable string key (+ optional index), for
 * data-driven shapes (e.g. one circle per label). FNV-1a hash → always the same
 * seed for the same input, so nothing boils.
 */
export const seedFor = (key: string, index = 0): number => {
  let h = 2166136261 ^ index;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483647 || 1;
};
