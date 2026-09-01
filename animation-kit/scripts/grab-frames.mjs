#!/usr/bin/env node
// Cut readable frames out of the footage frames exported for a frame-aware job.
// The server already put a frame every `step` seconds (frames-map.json) in
// public/frames/<jobId>/full/ at CANVAS resolution: exactly what plays under
// the overlay on the Premiere timeline (Premiere's own render of the sequence
// with the animation track hidden). This script only picks, downscales and
// crops those files: no Premiere, no decoding of the source media, instant.
//
//   node scripts/grab-frames.mjs <jobId> <fromSec> <toSec> [--every N] [--width N]
//   node scripts/grab-frames.mjs <jobId> <fromSec> <toSec> --crop x,y,w,h
//
// - Times are rel seconds (0 = the animation's first frame), same clock as
//   brief.md and frames-map.json. Each requested time snaps to the nearest
//   exported frame.
// - Full frames land in public/frames/<jobId>/ as t0012.50.png, downscaled to
//   --width (default from frames-map.json): the script prints the factor to
//   multiply measured pixels by to get canvas coordinates.
// - --crop takes CANVAS pixels and outputs 1:1 canvas-resolution crops named
//   crop-x<X>y<Y>-t0012.50.png: a pixel measured in a crop is (X + px, Y + py)
//   on the canvas, no scaling.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pickFrames, frameName } from "./frame-analysis.mjs";

export { frameName };

/**
 * The -vf chain + the coordinate factor for one cut. Crops are 1:1 canvas
 * pixels; full frames are downscaled to `width` (never upscaled).
 */
export function buildFilter(map, { crop = null, width = null } = {}) {
  const cw = map.canvas.width;
  if (crop) {
    return { vf: `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, factor: 1, prefix: `crop-x${crop.x}y${crop.y}-` };
  }
  const outW = Math.min(Number(width) || map.frameWidth || 1568, cw);
  const factor = Math.round((cw / outW) * 1000) / 1000;
  return { vf: outW < cw ? `scale=${outW}:-2` : null, factor, prefix: "" };
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
  const frames = map.frames || [];
  if (!frames.length) {
    console.log("This job has no footage frames (see frames-map.json): treat it as a free-canvas animation.");
    return;
  }
  const crop = opt("crop") ? parseCrop(opt("crop")) : null;
  if (opt("crop") && !crop) { console.error("Bad --crop: expected x,y,w,h in canvas pixels."); process.exit(2); }
  const { vf, factor, prefix } = buildFilter(map, { crop, width: opt("width") });
  const picks = pickFrames(frames, Number(fromS), Number(toS), opt("every") != null ? opt("every") : map.step || 0);
  const outDir = join("public", "frames", jobId);
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const p of picks) {
    const name = prefix + frameName(p.t);
    const src = join("public", "frames", jobId, "full", p.file);
    try {
      const vfArgs = vf ? ["-vf", vf] : [];
      execFileSync(map.ffmpeg || "ffmpeg", ["-hide_banner", "-nostdin", "-y", "-v", "error", "-i", src, ...vfArgs, join(outDir, name)], { stdio: ["ignore", "ignore", "pipe"] });
      written.push(name);
    } catch (e) {
      console.error(`FAILED ${name}: ${String(e.stderr || e.message).slice(-200)}`);
    }
  }
  console.log(`Wrote ${written.length} frame(s) to ${outDir}/ (footage frames exist every ${map.step}s; times snapped to the nearest one):`);
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
