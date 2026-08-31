#!/usr/bin/env node
// Grab video frames for a frame-aware animation job, mapped into CANVAS
// coordinates (scaled to fit the composition and letterboxed, exactly how the
// footage sits in the sequence). Run from the workspace root:
//
//   node scripts/grab-frames.mjs <jobId> <fromSec> <toSec> [--every N] [--width N]
//   node scripts/grab-frames.mjs <jobId> <fromSec> <toSec> --crop x,y,w,h
//
// - Times are rel seconds (0 = the animation's first frame), same clock as
//   brief.md and frames-map.json.
// - Full frames land in public/frames/<jobId>/ as t0012.40.png, downscaled to
//   --width (default from frames-map.json): the script prints the factor to
//   multiply measured pixels by to get canvas coordinates.
// - --crop takes CANVAS pixels and outputs 1:1 canvas-resolution crops named
//   crop-x<X>y<Y>-t0012.40.png: a pixel measured in a crop is (X + px, Y + py)
//   on the canvas, no scaling.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** "t0012.40.png" for a rel-seconds timestamp (chronological sort). */
export function frameName(relSec, prefix = "t") {
  const s = Math.max(0, Number(relSec) || 0);
  let int = Math.floor(s);
  let frac = Math.round((s - int) * 100);
  if (frac >= 100) { int += 1; frac = 0; }
  return `${prefix}${String(int).padStart(4, "0")}.${String(frac).padStart(2, "0")}.png`;
}

/**
 * Which frames to extract for a rel-time window: walks [fromSec, toSec] in
 * `everySec` steps, maps each time onto its owning span (rel -> source), skips
 * times no span covers (footage already cut away). Pure, unit-tested serverside.
 */
export function planExtractions(map, fromSec, toSec, everySec = 1) {
  const spans = (map.spans || []).slice().sort((a, b) => a.relStart - b.relStart);
  const step = Number(everySec) > 0 ? Number(everySec) : 1;
  const out = [];
  const seen = new Set();
  for (let t = Number(fromSec); t <= Number(toSec) + 1e-6; t = Math.round((t + step) * 1000) / 1000) {
    const sp = spans.find((s) => t >= s.relStart - 1e-6 && t <= s.relEnd + 1e-6);
    if (!sp) continue;
    // Clamp a hair inside the span so a boundary time still decodes a frame.
    const rel = Math.min(Math.max(t, sp.relStart), Math.max(sp.relStart, sp.relEnd - 0.04));
    const name = frameName(rel);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ relSec: Math.round(rel * 100) / 100, name, mediaPath: sp.mediaPath, sourceSec: Math.round((sp.sourceInSec + (rel - sp.relStart)) * 1000) / 1000 });
  }
  return out;
}

/**
 * The -vf chain + the coordinate factor for one extraction. Everything goes
 * through the canvas mapping first (fit + letterbox); crops are cut from the
 * full-resolution canvas, full frames are then downscaled to `width`.
 */
export function buildFilter(map, { crop = null, width = null } = {}) {
  const cw = map.canvas.width, ch = map.canvas.height;
  const base = `scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2`;
  if (crop) {
    return { vf: `${base},crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, factor: 1, prefix: `crop-x${crop.x}y${crop.y}-` };
  }
  const outW = Math.min(Number(width) || map.frameWidth || 1568, cw);
  const factor = Math.round((cw / outW) * 1000) / 1000;
  return { vf: outW < cw ? `${base},scale=${outW}:-2` : base, factor, prefix: "" };
}

function parseCrop(s) {
  const parts = String(s || "").split(",").map((v) => Math.round(Number(v)));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const [x, y, w, h] = parts;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function main() {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith("--"));
  const opt = (name) => {
    const i = args.indexOf("--" + name);
    return i >= 0 ? args[i + 1] : null;
  };
  const [jobId, fromS, toS] = pos;
  if (!jobId || fromS == null || toS == null) {
    console.error("Usage: node scripts/grab-frames.mjs <jobId> <fromSec> <toSec> [--every N] [--width N] [--crop x,y,w,h]");
    process.exit(2);
  }
  const map = JSON.parse(readFileSync(join("src", "jobs", jobId, "frames-map.json"), "utf8"));
  const crop = opt("crop") ? parseCrop(opt("crop")) : null;
  if (opt("crop") && !crop) { console.error("Bad --crop: expected x,y,w,h in canvas pixels."); process.exit(2); }
  const { vf, factor, prefix } = buildFilter(map, { crop, width: opt("width") });
  const plan = planExtractions(map, Number(fromS), Number(toS), opt("every") || 1);
  if (!plan.length) {
    console.log("No footage covers that rel-time window (check frames-map.json spans).");
    return;
  }
  const outDir = join("public", "frames", jobId);
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const p of plan) {
    const name = prefix + p.name;
    try {
      execFileSync(map.ffmpeg || "ffmpeg", [
        "-hide_banner", "-nostdin", "-y",
        "-ss", String(p.sourceSec), "-i", p.mediaPath,
        "-frames:v", "1", "-vf", vf, join(outDir, name),
      ], { stdio: ["ignore", "ignore", "pipe"] });
      written.push(name);
    } catch (e) {
      console.error(`FAILED ${name}: ${String(e.stderr || e.message).slice(-200)}`);
    }
  }
  console.log(`Wrote ${written.length} frame(s) to ${outDir}/:`);
  for (const f of written) console.log("  " + f);
  if (crop) {
    console.log(`Crops are 1:1 canvas pixels; a point at (px,py) in the image is canvas (${crop.x}+px, ${crop.y}+py).`);
  } else if (factor > 1) {
    console.log(`Frames are downscaled: MULTIPLY measured pixels by ${factor} to get canvas coordinates.`);
  } else {
    console.log("Frames are at canvas resolution: measured pixels ARE canvas coordinates.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
