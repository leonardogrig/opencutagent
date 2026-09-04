/**
 * "Leo" pixel presenter — palette and grid contract.
 *
 * The character is a 56x64 sprite in ~20 colours, authored as a char grid
 * (one letter per pixel, see sprite.ts). This map is the ONLY place a colour
 * exists; every letter below is a paint the sprite builder can use. Values were
 * read off the reference photos and lifted slightly so a black tee and black
 * hair still separate from a #121212 canvas and from dark footage.
 */
export const PALETTE = {
  ".": null,                                   // transparent
  o: "#0F0C0B",                                // silhouette outline
  h: "#1B1411", H: "#31261F", x: "#120D0B",    // hair: base / lit curl edge / curl shadow
  b: "#221A15", B: "#3A2C22", u: "#8A6449",    // stubble: dense / lighter / over-skin tone
  s: "#D9A67F", S: "#F0C69E", d: "#B47F58",    // skin: base / key light / shade
  n: "#A9744F",                                // under-jaw shadow
  g: "#171311", G: "#6B6360",                  // glasses frame / glint
  w: "#F5F0E8", e: "#241812",                  // eye white / iris
  m: "#3A1B1C", t: "#F6F1E9", r: "#A9614F", T: "#B45A55", // mouth interior / teeth / lip / tongue
  k: "#2B2930", K: "#3A3740", j: "#201F25",    // tee: base / lit fold / shadow fold
  c: "#24242B", C: "#3A3A45", v: "#141419",    // cap: base / lit edge / brim underside
} as const;

export type Paint = keyof typeof PALETTE;
export type Grid = string[][];

export const SPRITE_W = 56;
export const SPRITE_H = 64;
