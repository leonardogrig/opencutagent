/**
 * The sprite builder: pose in, 56x64 char grid out. Pure and deterministic, so
 * the React layer can cache grids by pose key and a frame never "boils".
 *
 * Authoring model: rows of [x0, x1] spans per paint, in the same order a pixel
 * artist would lay them down (tee, neck, head, stubble, nose, brows, hair,
 * glasses, eyes, mouth). Later paints win. Everything is hand-tuned to the two
 * reference photos; the numbers ARE the art, so change them with a render open.
 */
import { Grid, PALETTE, SPRITE_H, SPRITE_W } from "./palette";

export type Viseme = "rest" | "mm" | "ah" | "ee" | "oh" | "oo" | "fv" | "smile" | "grin" | "laugh";
export type EyeKind = "open" | "closed" | "squint" | "wide";
export type BrowKind = "rest" | "raised" | "furrow";
export type HairKind = "curls" | "cap";

export type SpritePose = {
  hair: HairKind;
  eyes: EyeKind;
  brow: BrowKind;
  mouth: Viseme;
  /** Iris offset in pixels, -1..1 each. */
  gazeX: number;
  gazeY: number;
  /** Head shear in pixels (-1..1): the head rows slide over the neck, a cheap "turn". */
  headDx: number;
};

export const POSE_REST: SpritePose = {
  hair: "curls", eyes: "open", brow: "rest", mouth: "rest", gazeX: 0, gazeY: 0, headDx: 0,
};

export const VISEMES: Viseme[] = ["rest", "mm", "ah", "ee", "oh", "oo", "fv", "smile", "grin", "laugh"];

type Spans = Record<number, Array<[number, number]>>;

const grid = (): Grid => Array.from({ length: SPRITE_H }, () => Array<string>(SPRITE_W).fill("."));
const inb = (x: number, y: number) => x >= 0 && x < SPRITE_W && y >= 0 && y < SPRITE_H;
const px = (g: Grid, x: number, y: number, c: string) => { if (inb(x, y)) g[y][x] = c; };
const rect = (g: Grid, x0: number, y0: number, x1: number, y1: number, c: string) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(g, x, y, c);
};
const spans = (g: Grid, rows: Spans, c: string) => {
  for (const [y, list] of Object.entries(rows)) for (const [x0, x1] of list) rect(g, x0, +y, x1, +y, c);
};
const onSkin = (g: Grid, rows: Spans, c: string) => {
  for (const [y, list] of Object.entries(rows)) for (const [x0, x1] of list)
    for (let x = x0; x <= x1; x++) if (g[+y][x] === "s") g[+y][x] = c;
};
const dither = (g: Grid, rows: Spans, c: string, phase = 0, over = "s") => {
  for (const [y, list] of Object.entries(rows)) for (const [x0, x1] of list)
    for (let x = x0; x <= x1; x++) if (g[+y][x] === over && (x + +y) % 2 === phase) g[+y][x] = c;
};

/* Layout (rows): hair/cap 0..15 | forehead 16..19 | brows 20..21 | glasses 23..30
   eyes 25..29 | nose 31..35 | stubble from 33 | moustache 36..37 | mouth 38..41
   chin 42..46 | neck 46..51 | tee 52..63. Centre column is 28. */

/** Square head with a broad, flat jaw. */
const FACE: Spans = {
  14: [[19, 37]], 15: [[18, 38]], 16: [[17, 39]], 17: [[16, 40]], 18: [[16, 40]], 19: [[15, 41]],
  20: [[15, 41]], 21: [[15, 41]], 22: [[15, 41]], 23: [[15, 41]], 24: [[15, 41]],
  25: [[15, 41]], 26: [[15, 41]], 27: [[15, 41]], 28: [[15, 41]], 29: [[15, 41]],
  30: [[15, 41]], 31: [[15, 41]], 32: [[15, 41]], 33: [[15, 41]], 34: [[15, 41]],
  35: [[15, 41]], 36: [[15, 41]], 37: [[15, 41]], 38: [[15, 41]], 39: [[16, 40]],
  40: [[16, 40]], 41: [[16, 40]], 42: [[17, 39]], 43: [[18, 38]], 44: [[20, 36]],
  45: [[23, 33]], 46: [[26, 30]],
};
const inFace = (x: number, y: number) => { const r = FACE[y]; return !!r && r.some(([a, b]) => x >= a && x <= b); };

/** Big black curls: tall on the viewer's left, a lobe falling onto the right forehead, short sides. */
const CURLS: Spans = {
  0:  [[19, 23], [25, 29]],
  1:  [[17, 32]],
  2:  [[15, 35]],
  3:  [[13, 37]],
  4:  [[12, 39]],
  5:  [[11, 40]],
  6:  [[11, 41]],
  7:  [[10, 42]],
  8:  [[10, 43]],
  9:  [[10, 43]],
  10: [[10, 43]],
  11: [[11, 43]],
  12: [[11, 43]],
  13: [[12, 43]],
  14: [[12, 43]],
  15: [[12, 17], [32, 43]],
  16: [[12, 16], [33, 38], [40, 43]],
  17: [[13, 15], [34, 37], [41, 43]],
  18: [[13, 15], [41, 43]],
  19: [[13, 14], [42, 43]],
  20: [[13, 14], [42, 43]],
  21: [[13, 14], [42, 43]],
  22: [[14, 14], [42, 42]],
  23: [[14, 14], [42, 42]],
};
/** Top-left corners of small "c" hooks drawn in the curl shadow tone. */
const CURL_ARCS: Array<[number, number]> = [[15, 4], [21, 2], [30, 3], [37, 6], [12, 9], [18, 8], [25, 7], [33, 9], [40, 10], [15, 13], [22, 12], [29, 12], [36, 14]];
const CURL_LIGHT: Array<[number, number]> = [[22, 0], [26, 0], [18, 1], [16, 2], [13, 4], [11, 6], [29, 1], [33, 2], [38, 4], [12, 10], [20, 4], [27, 4], [24, 9], [31, 9], [17, 13], [36, 15]];

/** Black cap: dome crown + flat front brim, curls escaping at the temples. */
const CAP_CROWN: Spans = {
  1: [[23, 33]], 2: [[20, 36]], 3: [[18, 38]], 4: [[17, 39]], 5: [[16, 40]], 6: [[15, 41]],
  7: [[15, 41]], 8: [[14, 42]], 9: [[14, 42]], 10: [[14, 42]], 11: [[14, 42]], 12: [[14, 42]],
};
const CAP_BRIM: Spans = { 13: [[11, 45]], 14: [[11, 45]] };
const CAP_HAIR: Spans = {
  15: [[13, 15], [41, 43]], 16: [[13, 15], [41, 43]], 17: [[13, 15], [41, 43]], 18: [[13, 15], [41, 43]],
  19: [[14, 15], [41, 42]], 20: [[14, 14], [42, 42]], 21: [[14, 14], [42, 42]], 22: [[14, 14], [42, 42]], 23: [[14, 14], [42, 42]],
};

/** First stubble row per column: low on the cheeks, following the jaw. */
const BEARD_TOP: Record<number, number> = {
  15: 33, 16: 33, 17: 33, 18: 34, 19: 34, 20: 35, 21: 35, 22: 36, 23: 36, 24: 37,
  25: 37, 26: 37, 27: 37, 28: 37, 29: 37, 30: 37, 31: 37, 32: 37, 33: 36, 34: 36,
  35: 35, 36: 35, 37: 34, 38: 34, 39: 33, 40: 33, 41: 33,
};

const SHIRT: Spans = {
  52: [[21, 35]], 53: [[18, 38]], 54: [[15, 41]], 55: [[12, 44]], 56: [[10, 46]],
  57: [[8, 48]], 58: [[7, 49]], 59: [[6, 50]], 60: [[5, 51]], 61: [[4, 52]],
  62: [[4, 52]], 63: [[3, 53]],
};

/* Mouth field is 9 px wide (x 24..32), top row y=38. Rounded, lip-outlined shapes. */
const MOUTHS: Record<Viseme, string[]> = {
  rest:  [".r.....r.", "..rrrrr.."],
  mm:    ["..rrrrr.."],
  ah:    ["..rrrrr..", ".rmmmmmr.", ".rmmmmmr.", "..rrrrr.."],
  ee:    [".rrrrrrr.", ".rtttttr.", ".rrrrrrr."],
  oh:    ["...rrr...", "..rmmmr..", "..rmmmr..", "...rrr..."],
  oo:    ["...rrr...", "..rmmmr..", "...rrr..."],
  smile: ["r.......r", ".rrrrrrr.", "..rtttr..", "...rrr..."],
  grin:  [".rrrrrrr.", "rtttttttr", ".rmmmmmr.", "..rrrrr.."],
  fv:    ["..ttttt..", "..rrrrr.."],
  laugh: ["..rrrrr..", ".rtttttr.", "rmmmmmmmr", ".rmTTTmr.", "..rrrrr.."],
};

const EYE_MASK = [[0, 1, 1, 1, 0], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [0, 1, 1, 1, 0]];
const EYE_CX = [21, 35];

function paintBrows(g: Grid, kind: BrowKind) {
  const dy = kind === "raised" ? -2 : kind === "furrow" ? 1 : 0;
  const inner = kind === "furrow" ? 1 : 0; // a furrow drops the inner ends
  spans(g, { [20 + dy]: [[18, 26]], [21 + dy]: [[17, 25]] }, "h");
  spans(g, { [21 + dy + inner]: [[25, 26]] }, "h");
  spans(g, { [20 + dy]: [[30, 38]], [21 + dy]: [[31, 39]] }, "h");
  spans(g, { [21 + dy + inner]: [[30, 31]] }, "h");
}

function paintEyes(g: Grid, kind: EyeKind, gazeX: number, gazeY: number) {
  const gx = Math.max(-1, Math.min(1, Math.round(gazeX)));
  const gy = Math.max(-1, Math.min(1, Math.round(gazeY)));
  for (const cx of EYE_CX) {
    rect(g, cx - 2, 25, cx + 2, 29, "s");
    if (kind === "closed") { rect(g, cx - 2, 27, cx + 2, 27, "e"); px(g, cx - 2, 26, "e"); px(g, cx + 2, 26, "e"); continue; }
    if (kind === "squint") { // happy crescent: lower lid pushed up under a lash arch
      rect(g, cx - 1, 26, cx + 1, 26, "e"); px(g, cx - 2, 27, "e"); px(g, cx + 2, 27, "e");
      rect(g, cx - 1, 27, cx + 1, 27, "w"); rect(g, cx - 1, 28, cx + 1, 28, "e"); continue;
    }
    EYE_MASK.forEach((row, ry) => row.forEach((on, rx) => { if (on) px(g, cx - 2 + rx, 25 + ry, "w"); }));
    const x0 = cx - 1 + gx, y0 = 26 + gy;
    rect(g, x0, y0, x0 + 2, y0 + 1, "e");
    if (kind === "wide") { px(g, cx - 2, 25, "w"); px(g, cx + 2, 25, "w"); px(g, cx - 2, 29, "w"); px(g, cx + 2, 29, "w"); }
    px(g, x0, y0, "w"); // catchlight
  }
}

function paintStubble(g: Grid, x0: number, x1: number, yMax: number) {
  for (let x = x0; x <= x1; x++) for (let y = BEARD_TOP[x]; y <= yMax; y++) if (inFace(x, y)) {
    px(g, x, y, "u");
    if (y > BEARD_TOP[x] && (x * 3 + y * 5) % 7 === 0) px(g, x, y, "b"); // sparse grain
  }
}

function paintMouth(g: Grid, kind: Viseme) {
  // repaint the mouth field so a previous viseme never shows through
  paintStubble(g, 20, 36, 41);
  for (let x = 20; x <= 36; x++) if (inFace(x, 41) && (x + 41) % 2 === 0) px(g, x, 41, "b");
  rect(g, 23, 36, 33, 37, "b"); // moustache
  for (const x of [24, 26, 28, 30, 32]) px(g, x, 36, "u");
  (MOUTHS[kind] ?? MOUTHS.rest).forEach((row, i) => row.split("").forEach((c, j) => { if (c !== ".") px(g, 24 + j, 38 + i, c); }));
}

/** 1px silhouette outline so the sprite reads over ANY footage. */
function outline(g: Grid): Grid {
  const out = g.map((r) => r.slice());
  for (let y = 0; y < SPRITE_H; y++) for (let x = 0; x < SPRITE_W; x++) {
    if (g[y][x] !== ".") continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (inb(x + dx, y + dy) && g[y + dy][x + dx] !== ".") { out[y][x] = "o"; break; }
    }
  }
  return out;
}

/** Slide the head rows (everything above the neck join) sideways by dx pixels. */
function shearHead(g: Grid, dx: number): Grid {
  const d = Math.max(-1, Math.min(1, Math.round(dx)));
  if (!d) return g;
  const out = g.map((r) => r.slice());
  for (let y = 0; y <= 45; y++) {
    const row = Array<string>(SPRITE_W).fill(".");
    for (let x = 0; x < SPRITE_W; x++) if (inb(x + d, y)) row[x + d] = g[y][x];
    out[y] = row;
  }
  return out;
}

const cache = new Map<string, Grid>();

/** Build (or fetch) the outlined grid for a pose. */
export function buildSprite(p: Partial<SpritePose> = {}): Grid {
  const pose: SpritePose = { ...POSE_REST, ...p };
  const key = `${pose.hair}|${pose.eyes}|${pose.brow}|${pose.mouth}|${Math.round(pose.gazeX)}|${Math.round(pose.gazeY)}|${Math.round(pose.headDx)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const g = grid();

  /* tee */
  spans(g, SHIRT, "k");
  spans(g, { 56: [[10, 13]], 57: [[8, 12]], 58: [[7, 11]], 59: [[6, 10]], 60: [[5, 10]], 61: [[4, 9]], 62: [[4, 9]], 63: [[3, 8]] }, "K");
  spans(g, { 57: [[45, 48]], 58: [[46, 49]], 59: [[47, 50]], 60: [[47, 51]], 61: [[48, 52]], 62: [[48, 52]], 63: [[49, 53]] }, "j");
  spans(g, { 52: [[24, 32]], 53: [[25, 31]], 54: [[27, 29]] }, "K"); // crew neckline

  /* neck */
  spans(g, { 46: [[24, 32]], 47: [[23, 33]], 48: [[23, 33]], 49: [[23, 33]], 50: [[22, 34]], 51: [[22, 34]] }, "s");
  spans(g, { 46: [[24, 32]], 47: [[23, 33]] }, "n");

  /* head: key light from the left, shade down the right cheek */
  spans(g, FACE, "s");
  onSkin(g, { 17: [[19, 30]], 18: [[18, 30]], 19: [[18, 28]] }, "S");
  dither(g, { 19: [[29, 31]], 20: [[18, 28]] }, "S");
  onSkin(g, { 22: [[40, 41]], 23: [[40, 41]], 24: [[40, 41]], 25: [[40, 41]], 26: [[40, 41]], 27: [[40, 41]],
              28: [[40, 41]], 29: [[40, 41]], 30: [[40, 41]], 31: [[40, 41]], 32: [[40, 41]] }, "d");
  dither(g, { 20: [[39, 41]], 21: [[39, 41]], 22: [[39, 39]], 23: [[39, 39]], 24: [[39, 39]], 25: [[39, 39]],
              26: [[39, 39]], 27: [[39, 39]], 28: [[39, 39]], 29: [[39, 39]], 30: [[39, 39]], 31: [[39, 39]],
              32: [[39, 39]] }, "d");
  spans(g, { 25: [[13, 14], [42, 43]], 26: [[13, 14], [42, 43]], 27: [[13, 14], [42, 43]], 28: [[13, 14], [42, 43]], 29: [[14, 14], [42, 42]] }, "s"); // ears
  spans(g, { 26: [[13, 13], [43, 43]], 27: [[13, 13], [43, 43]] }, "d");

  /* stubble: darker skin tone, solid only on the chin line */
  paintStubble(g, 15, 41, 47);
  for (let x = 15; x <= 41; x++) if ((x * 7) % 3 === 0) px(g, x, BEARD_TOP[x], "s"); // ragged top edge
  dither(g, { 41: [[16, 40]] }, "b", 0, "u");
  for (let y = 42; y <= 46; y++) for (const [a, b] of FACE[y]) rect(g, a, y, b, y, "b");
  spans(g, { 42: [[17, 17], [39, 39]] }, "u");

  /* nose */
  onSkin(g, { 32: [[30, 30]], 33: [[30, 30]], 34: [[29, 30]] }, "d");
  onSkin(g, { 35: [[27, 27], [30, 30]] }, "n");
  onSkin(g, { 34: [[27, 28]] }, "S");

  paintBrows(g, pose.brow);

  /* hair */
  if (pose.hair === "cap") {
    spans(g, CAP_HAIR, "h");
    for (const [x, y] of [[13, 16], [14, 19], [43, 17], [42, 21]] as Array<[number, number]>) px(g, x, y, "H");
    spans(g, CAP_CROWN, "c");
    spans(g, CAP_BRIM, "c");
    spans(g, { 14: [[12, 44]] }, "v");
    spans(g, { 13: [[11, 44]] }, "C");
    spans(g, { 2: [[22, 28]], 3: [[19, 24]], 4: [[18, 21]], 5: [[17, 19]], 6: [[16, 18]], 7: [[16, 17]], 8: [[15, 16]], 9: [[15, 15]] }, "C");
    spans(g, { 5: [[38, 40]], 6: [[39, 41]], 7: [[40, 41]], 8: [[41, 42]], 9: [[41, 42]], 10: [[41, 42]], 11: [[41, 42]], 12: [[41, 42]] }, "v");
    spans(g, { 12: [[14, 42]] }, "v");
    px(g, 28, 0, "c"); px(g, 28, 1, "C");
    for (let y = 3; y <= 11; y++) px(g, 28, y, "v");
  } else {
    spans(g, CURLS, "h");
    for (const [x, y] of CURL_ARCS) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [0, 2], [1, 2]]) if (g[y + dy]?.[x + dx] === "h") px(g, x + dx, y + dy, "x");
    for (const [x, y] of CURL_LIGHT) if (g[y][x] === "h") px(g, x, y, "H");
  }

  /* glasses: thin, wide, nearly to the face edge */
  const lens = (x0: number, w: number) => {
    rect(g, x0, 23, x0 + w - 1, 23, "g"); rect(g, x0, 30, x0 + w - 1, 30, "g");
    rect(g, x0, 24, x0, 29, "g"); rect(g, x0 + w - 1, 24, x0 + w - 1, 29, "g");
    px(g, x0 + 1, 24, "G"); px(g, x0 + 2, 24, "G");
  };
  lens(16, 11); lens(30, 11);
  rect(g, 27, 25, 29, 25, "g");
  rect(g, 14, 24, 15, 24, "g"); rect(g, 41, 24, 42, 24, "g");

  paintEyes(g, pose.eyes, pose.gazeX, pose.gazeY);
  paintMouth(g, pose.mouth);

  const done = outline(shearHead(g, pose.headDx));
  cache.set(key, done);
  return done;
}

export type Run = { x: number; y: number; w: number; fill: string };

/** Merge horizontal runs of one paint into rects: ~10x fewer SVG nodes than one per pixel. */
export function gridRuns(g: Grid): Run[] {
  const runs: Run[] = [];
  for (let y = 0; y < g.length; y++) {
    const row = g[y];
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      const fill = (PALETTE as Record<string, string | null>)[c] ?? null;
      if (!fill) { x++; continue; }
      let w = 1;
      while (x + w < row.length && row[x + w] === c) w++;
      runs.push({ x, y, w, fill });
      x += w;
    }
  }
  return runs;
}
