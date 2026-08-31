// Frame-aware animation support: when a job is created with "Use frames" the
// server prepares everything the chat agent needs to SEE the footage under the
// selected range and draw anchored annotations on it:
//  - frames-map.json  (in the kit job folder): rel-time -> source-time spans,
//    per-media pixel size + letterbox fit into the canvas, black-screen spans,
//    and the resolved ffmpeg path, so the workspace's grab-frames script can
//    extract more frames without knowing anything about Premiere.
//  - an overview strip (small thumbnails every few seconds) in
//    public/frames/<jobId>/overview/, cheap enough to Read in bulk, so the
//    agent knows what is on screen WHEN before spending on full-size frames.
//
// Every frame image is mapped into CANVAS coordinate space (scaled to fit the
// composition and letterboxed, exactly how Premiere fits footage to a
// sequence), so a pixel the agent measures in a frame IS a canvas coordinate.
// The whole pass is best-effort: any failure becomes a warning and the job
// still works (the agent falls back to a free-canvas animation).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpegBin } from "../paths.js";
import { round3, fmtDur } from "../tools/util.js";
import { log } from "../log.js";

export const OVERVIEW_STEP_SEC = 3;   // one thumbnail every N seconds
export const OVERVIEW_WIDTH = 640;    // small on purpose: bulk-readable
export const FRAME_WIDTH = 1568;      // default full-frame width (vision detail plateaus ~1.15MP)
const ANALYZE_CAP_SEC = 1200;         // skip the automatic scan on very long selections
const FF_TIMEOUT_MS = 180000;

/** The frame size of the FIRST video stream in an `ffmpeg -i` stderr dump. Pure (unit-tested). */
export function parseVideoSize(stderr) {
  const line = /Stream #[^\n]*?Video:[^\n]*/.exec(String(stderr || ""));
  if (!line) return null;
  // Dimensions appear as ", 2560x1440" after the pixel format; codec tags like
  // (avc1 / 0x31637634) never match because they have a single digit before x.
  const m = /(\d{2,5})x(\d{2,5})/.exec(line[0]);
  if (!m) return null;
  const width = Number(m[1]), height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * blackdetect ranges out of ffmpeg stderr, shifted by `relOffset` (the span's
 * rel start; with a fast `-ss` input seek the filter's timestamps start at ~0).
 * Pure (unit-tested).
 */
export function parseBlackdetect(stderr, relOffset = 0) {
  const out = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(String(stderr || "")))) {
    const start = Number(m[1]), end = Number(m[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      out.push({ start: round3(relOffset + start), end: round3(relOffset + end) });
    }
  }
  return out;
}

/**
 * How a source frame fits into the canvas: scaled to fit (letterboxed), the way
 * Premiere's "Set to Frame Size" places footage. canvasX = ox + sourceX*scale.
 * Pure (unit-tested).
 */
export function fitTransform(canvasW, canvasH, srcW, srcH) {
  const scale = Math.min(canvasW / srcW, canvasH / srcH);
  return {
    scale: round3(scale),
    ox: Math.round((canvasW - srcW * scale) / 2),
    oy: Math.round((canvasH - srcH * scale) / 2),
  };
}

/** The ffmpeg -vf chain that maps any source frame into canvas space. Pure (unit-tested). */
export function canvasMapFilter(canvasW, canvasH) {
  return `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=decrease,pad=${canvasW}:${canvasH}:(ow-iw)/2:(oh-ih)/2`;
}

/** "t0012.40.png": rel seconds, zero-padded so names sort chronologically. Pure (unit-tested). */
export function frameName(relSec, prefix = "t") {
  const s = Math.max(0, Number(relSec) || 0);
  let int = Math.floor(s);
  let frac = Math.round((s - int) * 100);
  if (frac >= 100) { int += 1; frac = 0; }
  return `${prefix}${String(int).padStart(4, "0")}.${String(frac).padStart(2, "0")}.png`;
}

/**
 * Collapse per-segment spans that are contiguous in BOTH rel time and source
 * time (adjacent segments of one clip tile with no gap) so the scan runs a few
 * ffmpeg passes instead of one per segment. Pure (unit-tested).
 */
export function mergeFrameSpans(spans, tol = 0.05) {
  const sorted = (spans || [])
    .filter((s) => s && s.mediaPath && s.sourceInSec != null && s.relEnd > s.relStart)
    .slice()
    .sort((a, b) => a.relStart - b.relStart);
  const out = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    const contiguous = prev && prev.mediaPath === s.mediaPath &&
      Math.abs(prev.relEnd - s.relStart) <= tol &&
      Math.abs(prev.sourceInSec + (prev.relEnd - prev.relStart) - s.sourceInSec) <= tol;
    if (contiguous) prev.relEnd = s.relEnd;
    else out.push({ relStart: s.relStart, relEnd: s.relEnd, mediaPath: s.mediaPath, sourceInSec: s.sourceInSec });
  }
  return out.map((s) => ({ ...s, relStart: round3(s.relStart), relEnd: round3(s.relEnd), sourceInSec: round3(s.sourceInSec) }));
}

/** Run ffmpeg, resolving {code, stderr} (probes exit non-zero by design). */
function runFf(args, { timeoutMs = FF_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegBin(), ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      reject(new Error(`Could not run ffmpeg: ${e.message}`));
      return;
    }
    let stderr = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 262144) stderr = stderr.slice(-262144); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`Could not run ffmpeg: ${e.message}`)); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

/**
 * Probe media, scan for black screens, extract the overview strip, and write
 * frames-map.json into the kit job folder. Never throws for a footage problem —
 * every issue becomes a warning and the map is still written (possibly with no
 * usable media, which the frames guide tells the agent to treat as free canvas).
 * @param {{job:object, spans:Array, kitDirPath:string, onProgress?:Function, token?:object}} opts
 * @returns {Promise<{warnings:string[], hasVideo:boolean, blackSpans:Array, overviewCount:number}>}
 */
export async function prepareFrameAssets({ job, spans: rawSpans, kitDirPath, onProgress = () => {}, token = null }) {
  const warnings = [];
  const aborted = () => { if (token && token.aborted) throw new Error("Cancelled"); };
  const spans = mergeFrameSpans(rawSpans);
  const framesDir = join(kitDirPath, "public", "frames", job.id);
  const overviewDir = join(framesDir, "overview");
  mkdirSync(overviewDir, { recursive: true });

  // Probe each source once for its pixel size (also proves it has video at all).
  const media = new Map();
  for (const sp of spans) if (!media.has(sp.mediaPath)) media.set(sp.mediaPath, null);
  for (const path of media.keys()) {
    aborted();
    const name = path.split(/[\\/]/).pop();
    if (!existsSync(path)) { warnings.push(`Source file not found: ${name}.`); continue; }
    try {
      const r = await runFf(["-i", path], { timeoutMs: 30000 });
      const size = parseVideoSize(r.stderr);
      if (size) media.set(path, size);
      else warnings.push(`${name} has no video stream, so no frames from it.`);
    } catch (e) {
      warnings.push(`Could not probe ${name}: ${e.message}`);
    }
  }

  const usable = spans.filter((sp) => media.get(sp.mediaPath));
  const totalSec = usable.reduce((a, sp) => a + (sp.relEnd - sp.relStart), 0);
  const black = [];
  let overviewCount = 0;

  if (!usable.length) {
    warnings.push("No video frames are available for this selection; the animation will use a free canvas.");
  } else if (totalSec > ANALYZE_CAP_SEC) {
    warnings.push(`The selection is ${fmtDur(totalSec)} of footage, so the automatic frame scan was skipped (frames can still be grabbed on demand).`);
  } else {
    onProgress("Scanning the footage for the animation…");
    for (let i = 0; i < usable.length; i++) {
      aborted();
      const sp = usable[i];
      const dur = sp.relEnd - sp.relStart;
      // Black-screen spans: cheap to detect here, saves the agent ever Reading one.
      try {
        const r = await runFf([
          "-ss", String(sp.sourceInSec), "-t", String(dur), "-i", sp.mediaPath,
          "-vf", "blackdetect=d=0.3:pix_th=0.10", "-an", "-f", "null", "-",
        ]);
        black.push(...parseBlackdetect(r.stderr, sp.relStart));
      } catch (e) {
        warnings.push(`Black-screen scan failed: ${e.message}`);
      }
      aborted();
      // Overview thumbnails, canvas-mapped then shrunk. Extracted as a numbered
      // sequence per span, then renamed to their rel-time names.
      try {
        const vf = `fps=1/${OVERVIEW_STEP_SEC},${canvasMapFilter(job.width, job.height)},scale=${OVERVIEW_WIDTH}:-2`;
        const pattern = join(overviewDir, `ov${i}-%04d.png`);
        const r = await runFf(["-ss", String(sp.sourceInSec), "-t", String(dur), "-i", sp.mediaPath, "-vf", vf, pattern]);
        if (r.code !== 0) throw new Error(`ffmpeg exited ${r.code}. ${r.stderr.slice(-200)}`);
        for (const f of readdirSync(overviewDir)) {
          const m = new RegExp(`^ov${i}-(\\d+)\\.png$`).exec(f);
          if (!m) continue;
          const rel = sp.relStart + (Number(m[1]) - 1) * OVERVIEW_STEP_SEC;
          renameSync(join(overviewDir, f), join(overviewDir, frameName(rel)));
          overviewCount++;
        }
      } catch (e) {
        warnings.push(`Overview thumbnails failed: ${e.message}`);
      }
    }
  }

  black.sort((a, b) => a.start - b.start);
  const map = {
    version: 1,
    jobId: job.id,
    ffmpeg: ffmpegBin(),
    canvas: { width: job.width, height: job.height, fps: job.fps },
    frameWidth: Math.min(FRAME_WIDTH, job.width),
    media: [...media.entries()]
      .filter(([, size]) => size)
      .map(([path, size]) => ({ path, ...size, fit: fitTransform(job.width, job.height, size.width, size.height) })),
    spans: usable,
    black,
    overview: { step: OVERVIEW_STEP_SEC, dir: `public/frames/${job.id}/overview`, count: overviewCount },
  };
  writeFileSync(join(kitDirPath, "src", "jobs", job.id, "frames-map.json"), JSON.stringify(map, null, 2));
  if (warnings.length) log(`animation frames (${job.id}): ${warnings.join(" | ")}`);
  return { warnings, hasVideo: usable.length > 0, blackSpans: black, overviewCount };
}

/** Remove a job's extracted frames from the workspace (discard cleanup). */
export function removeFrameAssets(jobId, kitDirPath) {
  try { rmSync(join(kitDirPath, "public", "frames", jobId), { recursive: true, force: true }); } catch { /* best-effort */ }
}
