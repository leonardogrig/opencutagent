/**
 * rough.js bridge — DOM-free, seeded geometry → drawable SVG sub-strokes.
 * This is the heart of the hand-drawn look. Everything is deterministic:
 * generation is pure and always seeded (see theme/seeds.ts).
 */
import rough from "roughjs";
import type { Drawable, Options } from "roughjs/bin/core";
import { getSubpaths } from "@remotion/paths";
import { tokens } from "../theme/tokens";

/** Single shared generator — needs no canvas / DOM. */
export const gen = rough.generator();

export type StrokeKind = "outline" | "fill";
export type Stroke = { d: string; color: string; width: number; kind: StrokeKind };

export type RoughInput = {
  seed?: number;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  fillStyle?: Options["fillStyle"];
  fillWeight?: number;
  hachureGap?: number;
  roughness?: number;
  bowing?: number;
};

const isDef = <T,>(v: T | undefined): v is T => v !== undefined;

/** Merge caller options over ROUGH defaults. Stroke always defaults to ink so
 *  shapes are visible on the dark canvas; pass stroke:"none" to suppress it. */
export const roughOpts = (o: RoughInput = {}): Options => {
  const d = tokens.rough;
  const out: Options = {
    roughness: isDef(o.roughness) ? o.roughness : d.roughness,
    bowing: isDef(o.bowing) ? o.bowing : d.bowing,
    strokeWidth: isDef(o.strokeWidth) ? o.strokeWidth : d.strokeWidth,
    stroke: isDef(o.stroke) ? o.stroke : tokens.color.ink,
    curveStepCount: d.curveStepCount,
    preserveVertices: d.preserveVertices,
    seed: isDef(o.seed) ? o.seed : 1,
    fillStyle: isDef(o.fillStyle) ? o.fillStyle : d.fillStyle,
    fillWeight: isDef(o.fillWeight) ? o.fillWeight : d.fillWeight,
    hachureGap: isDef(o.hachureGap) ? o.hachureGap : d.hachureGap,
  };
  if (isDef(o.fill)) out.fill = o.fill;
  return out;
};

/**
 * Convert a rough Drawable into individually-drawable sub-strokes:
 * - outline paths ('path') and hachure/zigzag fill lines ('fillSketch') → kind
 *   'outline' (self-draw via stroke-dashoffset).
 * - solid fill regions ('fillPath') → kind 'fill' (fade in; can't be "drawn").
 */
export const roughStrokes = (make: (g: typeof gen) => Drawable): Stroke[] => {
  const drawable = make(gen);
  return gen.toPaths(drawable).flatMap((p) => {
    const hasStroke = !!p.stroke && p.stroke !== "none";
    const hasFill = !!p.fill && p.fill !== "none";
    if (!hasStroke && !hasFill) return []; // invisible outline (e.g. stroke:"none" fills)
    const isSolidFill = hasFill && !hasStroke;
    const color = hasStroke ? (p.stroke as string) : (p.fill as string);
    const kind: StrokeKind = isSolidFill ? "fill" : "outline";
    const width = p.strokeWidth || tokens.stroke.thin;
    return getSubpaths(p.d).map((d) => ({ d, color, width, kind }));
  });
};
