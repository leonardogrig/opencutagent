/** Geometry helpers for sketch scenes (intersection lenses, arcs, etc.). */

/** SVG path (two arcs) for the lens = intersection of circles A and B.
 *  Returns "" when the circles don't properly overlap. */
export const lensPath = (
  ax: number,
  ay: number,
  rA: number,
  bx: number,
  by: number,
  rB: number,
): string => {
  const d = Math.hypot(bx - ax, by - ay);
  if (d >= rA + rB || d <= Math.abs(rA - rB) || d === 0) return "";
  const a = (d * d - rB * rB + rA * rA) / (2 * d);
  const h = Math.sqrt(Math.max(0, rA * rA - a * a));
  const px = ax + (a * (bx - ax)) / d;
  const py = ay + (a * (by - ay)) / d;
  const i1x = px + (h * (by - ay)) / d;
  const i1y = py - (h * (bx - ax)) / d;
  const i2x = px - (h * (by - ay)) / d;
  const i2y = py + (h * (bx - ax)) / d;
  return `M ${i1x} ${i1y} A ${rA} ${rA} 0 0 1 ${i2x} ${i2y} A ${rB} ${rB} 0 0 1 ${i1x} ${i1y} Z`;
};

/** Approximate lens centroid (on the radical line) for arrow targets / labels. */
export const lensCenter = (
  ax: number,
  ay: number,
  rA: number,
  bx: number,
  by: number,
  rB: number,
): { x: number; y: number } => {
  const d = Math.hypot(bx - ax, by - ay) || 1;
  const a = (d * d - rB * rB + rA * rA) / (2 * d);
  return { x: ax + (a * (bx - ax)) / d, y: ay + (a * (by - ay)) / d };
};

/** Point on a circle at angle (degrees, 0 = east, clockwise in SVG y-down). */
export const pointOnCircle = (
  cx: number,
  cy: number,
  r: number,
  deg: number,
): { x: number; y: number } => {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};
