// Frame-aware animation support: when a job is created with "Use frames" the
// server prepares everything the chat agent needs to SEE the footage under the
// selected range and draw anchored annotations on it, and it re-checks those
// anchors before rendering.
//
// Frame SOURCE = Premiere itself. The sequence is exported frame by frame
// through QE's exportFramePNG (with the animation's own track hidden), so a
// frame is exactly what plays under the overlay: every Motion transform,
// crop, punch-in, nested sequence, and Premiere's own read of the media are
// baked in. This replaced decoding the V1 source file with ffmpeg, which
// silently disagreed with Premiere on BOTH position (a 7680x2160 recording
// shown at Scale 100 / Position x=1 vs our letterbox guess) and TIME (an OBS
// HEVC file Premiere plays at 2x the timestamps ffmpeg decodes), putting every
// drawing seconds off. The media path survives only as a fallback for builds
// without QE frame export, flagged in the map so the agent knows it's a guess.
//
// Outputs (all in the kit workspace, removed on discard):
//  - public/frames/<jobId>/full/t0012.50.png  canvas-resolution frames every
//    `step` seconds across the whole range (the agent's ground truth).
//  - public/frames/<jobId>/sheets/sheet-....png  contact sheets of those frames
//    (12 per sheet) cheap enough to Read in bulk for a first survey.
//  - src/jobs/<jobId>/frames-map.json  the frame list + a change analysis:
//    screen changes with their magnitude, stable "shots" between them, black
//    spans, and the canvas facts, so timing decisions can be checked against
//    numbers rather than eyeballed.
// The whole pass is best-effort: any failure becomes a warning and the job
// still works (the agent falls back to a free-canvas animation).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegBin } from "../paths.js";
import { round3, callHostHealing } from "../tools/util.js";
import { formatTimecode } from "../transcription/timecode.js";
import { liveEnv } from "../config.js";
import { log } from "../log.js";
import {
  grayFrames, detectChanges, shotsFromChanges, blackSpans, frameName, THUMB_W, THUMB_H,
} from "../../animation-kit/scripts/frame-analysis.mjs";
import { runAnchorCheck } from "../../animation-kit/scripts/check-anchors.mjs";

export const DEFAULT_STEP_SEC = 0.5;  // one exported frame every N seconds (EDITAGENT_ANIM_FRAME_STEP)
export const MAX_FRAMES = 400;        // the step widens on long ranges so a selection never exports more
export const FRAME_WIDTH = 1568;      // default downscale for full frames the agent Reads (vision detail plateaus ~1.15MP)
export const SHEET_COLS = 4;
export const SHEET_ROWS = 3;
export const SHEET_TILE_W = 480;
const EXPORT_BATCH = 40;              // frames per host call (~0.25s each at 4K)
const FF_TIMEOUT_MS = 180000;

export { frameName };

/** The configured export step, clamped to something sane. */
export function frameStepSec() {
  const v = parseFloat(liveEnv("EDITAGENT_ANIM_FRAME_STEP") || "");
  return Number.isFinite(v) && v >= 0.1 && v <= 10 ? v : DEFAULT_STEP_SEC;
}

/**
 * Rel times to export for a range: every `step` seconds from 0, never past
 * the end, widened when the count would exceed `maxFrames`. Pure (unit-tested).
 * @returns {{step:number, times:number[]}}
 */
export function planExportTimes(durationSec, step = DEFAULT_STEP_SEC, maxFrames = MAX_FRAMES) {
  const dur = Math.max(0, Number(durationSec) || 0);
  let s = Number(step) > 0 ? Number(step) : DEFAULT_STEP_SEC;
  if (dur / s + 1 > maxFrames) s = Math.ceil((dur / (maxFrames - 1)) * 20) / 20; // round up to 0.05
  const times = [];
  const last = Math.max(0, dur - 0.02); // a hair inside the range so the final frame is still ours
  for (let t = 0; t <= last + 1e-9; t = Math.round((t + s) * 1000) / 1000) times.push(Math.round(t * 100) / 100);
  if (!times.length) times.push(0);
  return { step: s, times };
}

/**
 * Sequence timecodes (ruler, as QE expects) for rel times. Pure (unit-tested).
 * @returns {Array<{t:number, tc:string, name:string}>}
 */
export function timecodesFor(times, { startSec, fps, dropFrame = false, zeroPointFrames = 0 }) {
  return times.map((t) => {
    const frame = Math.round((startSec + t) * fps) + zeroPointFrames;
    return { t, tc: formatTimecode(frame, fps, dropFrame), name: frameName(t).replace(/\.png$/, "") };
  });
}

/** The frame size of the FIRST video stream in an `ffmpeg -i` stderr dump. Pure (unit-tested). */
export function parseVideoSize(stderr) {
  const line = /Stream #[^\n]*?Video:[^\n]*/.exec(String(stderr || ""));
  if (!line) return null;
  const m = /(\d{2,5})x(\d{2,5})/.exec(line[0]);
  if (!m) return null;
  const width = Number(m[1]), height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * How a source frame fits into the canvas when Premiere scales it to the
 * frame (letterboxed). Only the media FALLBACK uses this; Premiere-exported
 * frames need no mapping. Pure (unit-tested).
 */
export function fitTransform(canvasW, canvasH, srcW, srcH) {
  const scale = Math.min(canvasW / srcW, canvasH / srcH);
  return {
    scale: round3(scale),
    ox: Math.round((canvasW - srcW * scale) / 2),
    oy: Math.round((canvasH - srcH * scale) / 2),
  };
}

/** The ffmpeg -vf chain that maps a source frame into canvas space (fallback only). Pure (unit-tested). */
export function canvasMapFilter(canvasW, canvasH) {
  return `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=decrease,pad=${canvasW}:${canvasH}:(ow-iw)/2:(oh-ih)/2`;
}

/**
 * Collapse per-segment spans that are contiguous in BOTH rel time and source
 * time (fallback path). Pure (unit-tested).
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

/**
 * Fallback frame source: rel-time -> source-time spans from the live V1 clips
 * overlapping the selected range (V1 = the base footage by convention). Only
 * used when Premiere can't export frames itself. Pure (unit-tested).
 * @returns {{spans:Array, warnings:string[]}}
 */
export function v1FrameSpans(clips, range) {
  const spans = [];
  const warnings = [];
  for (const c of clips || []) {
    if (c.trackType !== "video" || c.trackIndex !== 0 || !c.mediaPath) continue;
    const start = c.start.seconds, end = c.end.seconds;
    const ovStart = Math.max(start, range.startSec);
    const ovEnd = Math.min(end, range.endSec);
    if (!(ovEnd > ovStart)) continue;
    if (c.speedIsNormal === false) {
      warnings.push(`${String(c.name || "a V1 clip")} is speed-changed, so no frames from it.`);
      continue;
    }
    spans.push({
      relStart: round3(ovStart - range.startSec),
      relEnd: round3(ovEnd - range.startSec),
      mediaPath: c.mediaPath,
      sourceInSec: round3(c.sourceIn.seconds + (ovStart - start)),
    });
  }
  spans.sort((a, b) => a.relStart - b.relStart);
  return { spans, warnings };
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
 * Export frames straight out of Premiere (QE exportFramePNG) at the given
 * sequence timecodes, in batches, with the job's own track hidden so a
 * previous version of this animation never shows up in its own reference.
 * Throws when the host can't do it at all (the caller falls back to media).
 * @returns {Promise<{frames:Array<{t:number,file:string}>, errors:string[]}>}
 */
export async function exportSequenceFrames(ctx, { items, dir, hideTrack = null, onProgress = () => {}, token = null }) {
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const errors = [];
  for (let i = 0; i < items.length; i += EXPORT_BATCH) {
    if (token && token.aborted) throw new Error("Cancelled");
    const batch = items.slice(i, i + EXPORT_BATCH);
    onProgress(`Grabbing frames from Premiere… ${Math.min(i + batch.length, items.length)}/${items.length}`);
    const r = await callHostHealing(ctx, "exportSequenceFrames", {
      items: batch.map((b) => ({ tc: b.tc, name: b.name })),
      dir,
      hideTrack,
    }, { timeoutMs: 120000 + batch.length * 3000 });
    const written = new Set((r && r.written) || []);
    for (const b of batch) {
      const file = `${b.name}.png`;
      if (written.has(b.name) && existsSync(join(dir, file))) frames.push({ t: b.t, file });
      else errors.push(`${b.tc}`);
    }
    for (const e of (r && r.errors) || []) if (errors.length < 5) errors.push(String(e));
  }
  if (!frames.length) throw new Error(`Premiere exported no frames${errors.length ? ` (${errors[0]})` : ""}.`);
  return { frames, errors };
}

/**
 * Fallback: decode the V1 source media with ffmpeg at the same times, mapped
 * into canvas space by a plain fit (Premiere's transforms are NOT applied and
 * some files decode at a different clock in Premiere: see the header).
 */
async function extractMediaFrames({ job, spans, step, dir, media, onProgress = () => {}, token = null }) {
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const warnings = [];
  const usable = spans.filter((sp) => media.get(sp.mediaPath));
  for (let i = 0; i < usable.length; i++) {
    if (token && token.aborted) throw new Error("Cancelled");
    const sp = usable[i];
    const dur = sp.relEnd - sp.relStart;
    onProgress(`Decoding footage frames… ${i + 1}/${usable.length}`);
    try {
      const vf = `fps=1/${step},${canvasMapFilter(job.width, job.height)}`;
      const pattern = join(dir, `mf${i}-%04d.png`);
      const r = await runFf(["-ss", String(sp.sourceInSec), "-t", String(dur), "-i", sp.mediaPath, "-vf", vf, pattern]);
      if (r.code !== 0) throw new Error(`ffmpeg exited ${r.code}. ${r.stderr.slice(-200)}`);
      for (const f of readdirSync(dir)) {
        const m = new RegExp(`^mf${i}-(\\d+)\\.png$`).exec(f);
        if (!m) continue;
        const rel = Math.round((sp.relStart + (Number(m[1]) - 1) * step) * 100) / 100;
        const name = frameName(rel);
        renameSync(join(dir, f), join(dir, name));
        frames.push({ t: rel, file: name });
      }
    } catch (e) {
      warnings.push(`Frame extraction failed: ${e.message}`);
    }
  }
  frames.sort((a, b) => a.t - b.t);
  return { frames, warnings };
}

/**
 * Change analysis over the exported frames: screen changes, shots, black.
 * One ffmpeg decode of small gray thumbnails; pure math after that.
 */
export function analyzeFrames(files, times, step) {
  const gray = grayFrames(ffmpegBin(), files, { w: THUMB_W, h: THUMB_H });
  const changes = detectChanges(gray, times, THUMB_W, THUMB_H);
  const endT = times.length ? times[times.length - 1] + step : 0;
  return { changes, shots: shotsFromChanges(times, changes, endT), black: blackSpans(gray, times, step) };
}

/** Contact sheets of the full frames (SHEET_COLS x SHEET_ROWS per sheet). */
async function writeSheets(fullDir, frames, sheetDir) {
  mkdirSync(sheetDir, { recursive: true });
  const per = SHEET_COLS * SHEET_ROWS;
  const sheets = [];
  for (let i = 0; i < frames.length; i += per) {
    const group = frames.slice(i, i + per);
    const tmp = mkdtempSync(join(tmpdir(), "oca-sheet-"));
    try {
      const list = join(tmp, "list.txt");
      writeFileSync(list, group.map((f) => `file '${join(fullDir, f.file).replace(/'/g, "'\\''")}'\nduration 1`).join("\n") + "\n");
      const file = `sheet-${frameName(group[0].t).replace(/^t|\.png$/g, "")}-${frameName(group[group.length - 1].t).replace(/^t|\.png$/g, "")}.png`;
      const cols = Math.min(SHEET_COLS, group.length);
      const rows = Math.ceil(group.length / cols);
      const vf = `scale=${SHEET_TILE_W}:-2,pad=iw+6:ih+6:3:3:color=#202020,tile=${cols}x${rows}`;
      let r = await runFf(["-f", "concat", "-safe", "0", "-i", list, "-fps_mode", "passthrough", "-vf", vf, "-frames:v", "1", "-y", join(sheetDir, file)]);
      if (r.code !== 0) r = await runFf(["-f", "concat", "-safe", "0", "-i", list, "-vsync", "0", "-vf", vf, "-frames:v", "1", "-y", join(sheetDir, file)]);
      if (r.code !== 0) throw new Error(`ffmpeg exited ${r.code}. ${r.stderr.slice(-200)}`);
      sheets.push({ file, from: group[0].t, to: group[group.length - 1].t, cols, rows, times: group.map((f) => f.t) });
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  return sheets;
}

/**
 * Prepare a frame-aware job: export the sequence's frames (Premiere first,
 * media fallback), analyze them, write contact sheets + frames-map.json.
 * Never throws for a footage problem: every issue becomes a warning and the
 * map is still written (possibly with no frames, which the frames guide tells
 * the agent to treat as free canvas).
 * @param {{ctx?:object, job:object, seq?:object, spans?:Array, kitDirPath:string, onProgress?:Function, token?:object}} opts
 * @returns {Promise<{warnings:string[], hasVideo:boolean, source:string, frameCount:number, changes:Array, shots:Array, blackSpans:Array}>}
 */
export async function prepareFrameAssets({ ctx = null, job, seq = null, spans: rawSpans = [], kitDirPath, onProgress = () => {}, token = null }) {
  const warnings = [];
  const aborted = () => { if (token && token.aborted) throw new Error("Cancelled"); };
  const framesRoot = join(kitDirPath, "public", "frames", job.id);
  const fullDir = join(framesRoot, "full");
  const sheetDir = join(framesRoot, "sheets");
  mkdirSync(fullDir, { recursive: true });
  const durationSec = job.durationInFrames / job.fps;
  const plan = planExportTimes(durationSec, frameStepSec());
  const step = plan.step;

  let frames = [];
  let source = "none";
  const media = new Map();

  // 1) Premiere's own frames.
  if (ctx && job.range && seq) {
    try {
      const items = timecodesFor(plan.times, {
        startSec: job.range.startSec,
        fps: job.fps,
        dropFrame: !!seq.dropFrame,
        zeroPointFrames: Number(seq.zeroPointFrames) || 0,
      });
      const r = await exportSequenceFrames(ctx, { items, dir: fullDir, hideTrack: job.trackIndex != null ? job.trackIndex : null, onProgress, token });
      frames = r.frames;
      source = "sequence";
      if (r.errors.length) warnings.push(`${r.errors.length} frame(s) could not be exported from Premiere.`);
    } catch (e) {
      aborted();
      log(`animation frames (${job.id}): Premiere frame export unavailable: ${e.message}`);
      warnings.push("Premiere could not export sequence frames, so the frames come from the V1 source file instead (transforms and timing may differ from what plays).");
    }
  }

  // 2) Fallback: decode the V1 source media.
  if (!frames.length) {
    const spans = mergeFrameSpans(rawSpans);
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
    if (spans.some((sp) => media.get(sp.mediaPath))) {
      const r = await extractMediaFrames({ job, spans, step, dir: fullDir, media, onProgress, token });
      frames = r.frames;
      warnings.push(...r.warnings);
      if (frames.length) source = "media";
    }
  }

  // 3) Analysis + sheets.
  let analysis = { changes: [], shots: [], black: [] };
  let sheets = [];
  if (frames.length) {
    aborted();
    onProgress("Scanning the frames for screen changes…");
    try {
      analysis = analyzeFrames(frames.map((f) => join(fullDir, f.file)), frames.map((f) => f.t), step);
    } catch (e) {
      warnings.push(`Frame analysis failed: ${e.message}`);
    }
    try {
      sheets = await writeSheets(fullDir, frames, sheetDir);
    } catch (e) {
      warnings.push(`Contact sheets failed: ${e.message}`);
    }
  } else {
    warnings.push("No video frames are available for this selection; the animation will use a free canvas.");
  }

  const map = {
    version: 2,
    jobId: job.id,
    source, // "sequence" (Premiere's own frames: exact) | "media" (decoded source file: a guess) | "none"
    ffmpeg: ffmpegBin(),
    canvas: { width: job.width, height: job.height, fps: job.fps },
    durationSec: round3(durationSec),
    step,
    frameWidth: Math.min(FRAME_WIDTH, job.width),
    frames,                                   // [{t, file}] under public/frames/<id>/full/
    sheets: sheets.map((s) => ({ ...s, file: `sheets/${s.file}` })), // under public/frames/<id>/
    changes: analysis.changes,                // [{t, score, kind}] new content first seen at t
    shots: analysis.shots,                    // [{start, end}] stable stretches between major changes
    black: analysis.black,
    hiddenTrack: source === "sequence" ? job.trackIndex : null,
    media: source === "media"
      ? [...media.entries()].filter(([, size]) => size).map(([path, size]) => ({ path, ...size, fit: fitTransform(job.width, job.height, size.width, size.height) }))
      : [],
  };
  writeFileSync(join(kitDirPath, "src", "jobs", job.id, "frames-map.json"), JSON.stringify(map, null, 2));
  if (warnings.length) log(`animation frames (${job.id}): ${warnings.join(" | ")}`);
  return { warnings, hasVideo: frames.length > 0, source, frameCount: frames.length, changes: analysis.changes, shots: analysis.shots, blackSpans: analysis.black };
}

/**
 * The server-side anchor check run before a render: the same judgement the
 * agent's check-anchors script makes, with the same sheets, so a FAIL can be
 * sent back to the agent as an automatic message before anything is rendered.
 * Never throws: an unusable check reports status "skipped".
 * @returns {{status:"ok"|"fail"|"warn"|"none"|"missing"|"skipped", report:string, fails:number, warns:number}}
 * ("none" = nothing to check: not frame-aware or no frames; "missing" = the
 * agent never declared anchors.json for a job that does have footage.)
 */
export function verifyJobAnchors(job, kitDirPath) {
  try {
    const out = runAnchorCheck({ kitDir: kitDirPath, jobId: job.id, writeSheets: true, ffmpeg: ffmpegBin() });
    if (out.missing) return { status: out.reason === "no-anchors" ? "missing" : "none", report: out.report, fails: 0, warns: 0 };
    const status = out.fails || out.errors.length ? "fail" : out.warns ? "warn" : "ok";
    return { status, report: out.report, fails: out.fails, warns: out.warns };
  } catch (e) {
    log(`animation frames (${job.id}): anchor check failed: ${e.message}`);
    return { status: "skipped", report: `Frame check skipped: ${e.message}`, fails: 0, warns: 0 };
  }
}

/** Number of automatic fix-up turns allowed when the anchor check fails (0 disables the gate). */
export function verifyRounds() {
  const v = parseInt(liveEnv("EDITAGENT_ANIM_VERIFY_ROUNDS") || "", 10);
  return Number.isFinite(v) && v >= 0 ? Math.min(v, 3) : 1;
}

/** Remove a job's extracted frames from the workspace (discard cleanup). */
export function removeFrameAssets(jobId, kitDirPath) {
  try { rmSync(join(kitDirPath, "public", "frames", jobId), { recursive: true, force: true }); } catch { /* best-effort */ }
}

// Where the shipped kit scripts live (so tests can point at them).
export const KIT_SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "animation-kit", "scripts");
