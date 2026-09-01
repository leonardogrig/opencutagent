// Frame analysis shared by the kit's frame scripts (grab-frames, check-anchors)
// and the OpenCutAgent server (which imports this same file): change detection
// across the exported footage frames, black-screen spans, and the per-anchor
// "is the target really on screen for the whole time the drawing shows?"
// judgement. Everything here is plain math over 8-bit gray buffers so it is
// unit-testable with synthetic frames; the only IO is grayFrames(), which asks
// ffmpeg to decode PNGs into those buffers.
//
// Calibrated on real dark-theme screen recordings (n8n): a side panel opening
// changes ~30% of 16x9 blocks, a full panel swap 75-90%, typing into a field
// or a list refresh 12-17%, a cursor pass under 10%.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Default analysis thumbnail size (whole frame). */
export const THUMB_W = 320;
export const THUMB_H = 180;

/** Screen-change thresholds on the changed-block fraction (see changedBlocks). */
export const MAJOR_CHANGE = 0.25; // a new shot: a panel/page/window replaced what was there
export const MINOR_CHANGE = 0.10; // something meaningful moved (typing, a list refresh)

/** Region thresholds (see pixelChange): the target under an anchor changed. */
export const REGION_FAIL = 0.12;  // fraction of region pixels that changed by > 16 levels
export const REGION_WARN = 0.04;

/** "t0012.40.png": rel seconds, zero-padded so names sort chronologically. */
export function frameName(relSec, prefix = "t") {
  const s = Math.max(0, Number(relSec) || 0);
  let int = Math.floor(s);
  let frac = Math.round((s - int) * 100);
  if (frac >= 100) { int += 1; frac = 0; }
  return `${prefix}${String(int).padStart(4, "0")}.${String(frac).padStart(2, "0")}.png`;
}

/**
 * Fraction of grid blocks whose mean absolute difference exceeds `th`. Robust
 * on dark UIs where a whole panel can swap while most pixels stay near-black
 * (a plain changed-pixel count under-reports those by 10x).
 */
export function changedBlocks(a, b, w, h, { cols = 16, rows = 9, th = 6 } = {}) {
  const cw = w / cols, ch = h / rows;
  let changed = 0;
  for (let by = 0; by < rows; by++) {
    const y0 = Math.floor(by * ch), y1 = Math.floor((by + 1) * ch);
    for (let bx = 0; bx < cols; bx++) {
      const x0 = Math.floor(bx * cw), x1 = Math.floor((bx + 1) * cw);
      let sum = 0, cnt = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) { sum += Math.abs(a[row + x] - b[row + x]); cnt++; }
      }
      if (cnt && sum / cnt > th) changed++;
    }
  }
  return changed / (cols * rows);
}

/** Pixel-level change between two same-size buffers: {frac (|d|>th), meanAbs}. */
export function pixelChange(a, b, th = 16) {
  const n = Math.min(a.length, b.length);
  if (!n) return { frac: 0, meanAbs: 0 };
  let c = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > th) c++;
  }
  return { frac: c / n, meanAbs: sum / n };
}

export function meanLuma(a) {
  if (!a.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

/**
 * Screen changes between consecutive frames. `frames[i]` is a gray buffer of
 * w*h at `times[i]` (rel seconds, ascending). Returns [{t, score, kind}] where
 * t is the time of the frame the new content is FIRST seen in.
 */
export function detectChanges(frames, times, w, h, { major = MAJOR_CHANGE, minor = MINOR_CHANGE } = {}) {
  const out = [];
  for (let i = 1; i < frames.length; i++) {
    const score = changedBlocks(frames[i - 1], frames[i], w, h);
    if (score >= minor) out.push({ t: r2(times[i]), score: r3(score), kind: score >= major ? "major" : "minor" });
  }
  return out;
}

/**
 * Stable stretches ("shots") between MAJOR changes, over [times[0], endT].
 * A drawing anchored to something on screen should live inside one shot.
 */
export function shotsFromChanges(times, changes, endT) {
  if (!times.length) return [];
  const cuts = changes.filter((c) => c.kind === "major").map((c) => c.t);
  const out = [];
  let start = times[0];
  for (const t of cuts) {
    if (t > start) out.push({ start: r2(start), end: r2(t), dur: r2(t - start) });
    start = t;
  }
  if (endT > start) out.push({ start: r2(start), end: r2(endT), dur: r2(endT - start) });
  return out;
}

/**
 * How long an anchored annotation needs on screen to be READ, in seconds:
 * a bare stroke (box/underline/arrow) registers in ~half a second; text needs
 * its draw-in plus ~a quarter second per word plus a settle. Pure.
 */
export function readTimeSec(words = 0, drawInSec = 0) {
  const w = Math.max(0, Number(words) || 0);
  const d = Math.max(0, Number(drawInSec) || 0);
  return w > 0 ? 0.6 + 0.25 * w + d : 0.5 + d;
}

/** Word count of a label (0 for none). Pure. */
export function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

/** Spans where the whole frame is (near) black. Each frame covers [t, t+step). */
export function blackSpans(frames, times, step, { maxMean = 14 } = {}) {
  const out = [];
  let cur = null;
  for (let i = 0; i < frames.length; i++) {
    const black = meanLuma(frames[i]) <= maxMean;
    if (black) {
      if (cur && Math.abs(cur.end - times[i]) < step * 1.5) cur.end = times[i] + step;
      else { cur = { start: times[i], end: times[i] + step }; out.push(cur); }
    } else cur = null;
  }
  return out.map((s) => ({ start: r2(s.start), end: r2(s.end) }));
}

/** Index of the exported frame nearest to rel time t (frames sorted by t). */
export function nearestFrameIndex(frames, t) {
  if (!frames.length) return -1;
  let best = 0;
  for (let i = 1; i < frames.length; i++) if (Math.abs(frames[i].t - t) < Math.abs(frames[best].t - t)) best = i;
  return best;
}

/**
 * Which exported frames represent the window [from, to] sampled every
 * `every` seconds: each tick snaps to its nearest exported frame, duplicates
 * collapse. Frames are {t, file}. Pure (unit-tested serverside).
 */
export function pickFrames(frames, from, to, every) {
  const step = Number(every) > 0 ? Number(every) : 0;
  const out = [];
  const seen = new Set();
  const push = (i) => { if (i >= 0 && !seen.has(i)) { seen.add(i); out.push(frames[i]); } };
  if (!frames.length) return out;
  const gap = frames.length > 1 ? frames[1].t - frames[0].t : 0;
  if (!step || step <= gap + 1e-6) {
    // Asking for the export density (or finer): every frame inside the window.
    for (let i = 0; i < frames.length; i++) if (frames[i].t >= from - 1e-6 && frames[i].t <= to + 1e-6) push(i);
    if (!out.length) push(nearestFrameIndex(frames, from));
    return out;
  }
  for (let t = Number(from); t <= Number(to) + 1e-6; t = Math.round((t + step) * 1000) / 1000) push(nearestFrameIndex(frames, t));
  return out;
}

/**
 * Judge one anchored drawing against the footage. `samples` are the frames
 * around its span: [{t, region}] where region is the gray crop of the
 * anchor's rect (same size for all samples), sorted by t, ideally covering
 * [from - step, to + step]. The reference is the sample nearest the middle of
 * the span; a sample inside the span that differs from it means the target
 * was not (yet / any more) what the drawing points at.
 */
export function judgeAnchor(samples, { from, to, step = 0.5, expectMotion = false, fail = REGION_FAIL, warn = REGION_WARN, size = null, words = 0, drawIn = 0 } = {}) {
  const res = { verdict: "ok", from, to, refT: null, changes: [], startsEarly: null, outlives: null, before: null, after: null, tooBusy: null, notes: [] };
  let inside = samples.filter((s) => s.t >= from - 1e-6 && s.t <= to + 1e-6);
  const mid = (from + to) / 2;
  if (!inside.length) {
    // A span shorter than the frame step (a target that flashes by): judge on
    // the nearest frame rather than shrugging; brevity is exactly the case
    // the time budget below exists for.
    if (!samples.length) {
      res.verdict = "unknown";
      res.notes.push("no footage frame near this drawing's time span");
      return res;
    }
    const i = nearestFrameIndex(samples, mid);
    inside = [samples[i]];
    res.notes.push(`the span is shorter than the frame step (${step}s): judged on the frame at ${samples[i].t.toFixed(2)}s`);
  }
  let ref = inside[0];
  for (const s of inside) if (Math.abs(s.t - mid) < Math.abs(ref.t - mid)) ref = s;
  res.refT = ref.t;
  // Two views of "did the region change": the changed-pixel fraction catches
  // solid targets (a button, a title bar) and the block view catches THIN ones
  // (a dashed outline, text on dark) whose pixels are few but spread out.
  const differs = (a, b) => {
    const { frac } = pixelChange(a, b);
    const blocks = size ? changedBlocks(a, b, size.w, size.h, { cols: 8, rows: 8, th: 4 }) : 0;
    const score = Math.max(frac, blocks >= 0.25 ? fail : blocks >= 0.10 ? Math.max(warn, blocks / 2) : 0);
    return { frac: r3(frac), blocks: r3(blocks), score };
  };
  for (const s of inside) {
    if (s === ref) continue;
    const d = differs(ref.region, s.region);
    if (d.score >= warn) res.changes.push({ t: r2(s.t), frac: d.frac, blocks: d.blocks, level: d.score >= fail ? "fail" : "warn" });
  }
  const fails = res.changes.filter((c) => c.level === "fail");
  const early = fails.filter((c) => c.t < ref.t);
  const late = fails.filter((c) => c.t > ref.t);
  if (early.length) res.startsEarly = { until: r2(Math.max(...early.map((c) => c.t))) };
  if (late.length) res.outlives = { from: r2(Math.min(...late.map((c) => c.t))) };
  // Context: does the target already exist just before, and survive just after?
  const before = samples.filter((s) => s.t < from - 1e-6).sort((a, b) => b.t - a.t)[0];
  const after = samples.filter((s) => s.t > to + 1e-6).sort((a, b) => a.t - b.t)[0];
  if (before) res.before = { t: r2(before.t), same: differs(ref.region, before.region).score < fail };
  if (after) res.after = { t: r2(after.t), same: differs(ref.region, after.region).score < fail };
  // Time budget: the annotation must be readable in the time the target is
  // really there. Text on a briefly-visible target is the classic overreach.
  const visibleFrom = res.startsEarly ? res.startsEarly.until + step : from;
  const visibleTo = res.outlives ? res.outlives.from : to;
  const visible = Math.max(0, visibleTo - visibleFrom);
  const needed = readTimeSec(words, drawIn);
  res.visibleSec = r2(visible);
  res.neededSec = r2(needed);
  if (words > 0 && visible < needed) {
    res.tooBusy = { visibleSec: r2(visible), neededSec: r2(needed), words };
  }
  if (expectMotion) {
    res.verdict = res.tooBusy ? "fail" : "ok";
    res.notes.push("expectMotion: region changes were not judged");
    if (res.tooBusy) res.notes.push(busyNote(res.tooBusy));
    return res;
  }
  if (fails.length || res.tooBusy) res.verdict = "fail";
  else if (res.changes.length) res.verdict = "warn";
  if (res.tooBusy) res.notes.push(busyNote(res.tooBusy));
  else if (words === 0 && visible < 0.5) res.notes.push(`the target is on screen for only ${visible.toFixed(2)}s: too brief for any annotation, consider skipping it`);
  if (res.startsEarly) res.notes.push(`the target is not there yet: the region still looks different at ${res.startsEarly.until.toFixed(2)}s (drawing starts at ${from.toFixed(2)}s)`);
  if (res.outlives) res.notes.push(`the target is gone: the region changes at ${res.outlives.from.toFixed(2)}s but the drawing stays until ${to.toFixed(2)}s`);
  if (fails.length && !res.startsEarly && !res.outlives) res.notes.push("the region changes in the middle of the span");
  if (res.verdict === "warn") res.notes.push("small changes inside the region (a cursor pass, a caret, a hover state): check the sheet, usually fine");
  return res;
}

function busyNote(b) {
  return `too much for the time it has: ${b.words} word(s) need ~${b.neededSec.toFixed(1)}s to draw and read but the target is visible for ${b.visibleSec.toFixed(2)}s. Drop the text (a border/underline/arrow alone reads in half a second)` +
    (b.visibleSec >= 1.5 ? " or cut it to one or two words" : "") + ".";
}

/** Human-readable report for the agent / the chat notice. */
export function formatAnchorReport(results, { step = 0.5 } = {}) {
  const lines = [];
  for (const r of results) {
    const head = `${r.id}${r.what ? ` (${r.what})` : ""}: ${r.from.toFixed(2)}s - ${r.to.toFixed(2)}s -> ${r.verdict.toUpperCase()}`;
    lines.push(head);
    for (const n of r.notes) lines.push(`  - ${n}`);
    // Context lines only when the span itself holds at that end (otherwise the failure note already says it).
    if (r.before && !r.before.same && !r.startsEarly) lines.push(`  - info: the target appears between ${r.before.t.toFixed(2)}s and ${Math.min(r.from, r.before.t + step).toFixed(2)}s`);
    if (r.after && !r.after.same && !r.outlives) lines.push(`  - info: the target disappears between ${Math.max(r.to, r.after.t - step).toFixed(2)}s and ${r.after.t.toFixed(2)}s (keep a margin before it)`);
    if (r.sheet) lines.push(`  - sheet: ${r.sheet}`);
  }
  const fails = results.filter((r) => r.verdict === "fail").length;
  const warns = results.filter((r) => r.verdict === "warn").length;
  lines.push(fails ? `${fails} anchor(s) FAIL: fix their timing or position before signalling render.json.` : warns ? `No failures (${warns} warning(s)).` : "All anchors match the footage.");
  return lines.join("\n");
}

/**
 * Decode PNG frames into 8-bit gray buffers with one ffmpeg call. `crop` is
 * {x,y,w,h} in the frames' own pixels (canvas px for exported frames) taken
 * BEFORE scaling to w x h; omit it for whole-frame thumbnails. Returns an
 * array of Uint8Array(w*h), one per file, in order.
 */
export function grayFrames(ffmpeg, files, { w = THUMB_W, h = THUMB_H, crop = null } = {}) {
  if (!files.length) return [];
  const dir = mkdtempSync(join(tmpdir(), "oca-gray-"));
  try {
    const list = join(dir, "list.txt");
    // The concat demuxer with a duration per image is the one form that emits
    // exactly one frame per file across ffmpeg versions (a bare list dedups).
    writeFileSync(list, files.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'\nduration 1`).join("\n") + "\n");
    const vf = (crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "") + `scale=${w}:${h}:flags=area`;
    const run = (fpsFlag) => execFileSync(ffmpeg || "ffmpeg", [
      "-hide_banner", "-nostdin", "-v", "error", "-f", "concat", "-safe", "0", "-i", list,
      ...fpsFlag, "-vf", vf, "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
    let raw;
    try { raw = run(["-fps_mode", "passthrough"]); } catch { raw = run(["-vsync", "0"]); }
    const size = w * h;
    const n = Math.floor(raw.length / size);
    if (n !== files.length) throw new Error(`ffmpeg decoded ${n} of ${files.length} frame(s)`);
    const out = [];
    for (let i = 0; i < n; i++) out.push(new Uint8Array(raw.buffer, raw.byteOffset + i * size, size));
    return out;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Clamp an anchor rect to the canvas and round to whole pixels (null if empty). */
export function clampRect(rect, canvasW, canvasH) {
  if (!rect) return null;
  const x = Math.max(0, Math.floor(Number(rect.x) || 0));
  const y = Math.max(0, Math.floor(Number(rect.y) || 0));
  const w = Math.min(canvasW - x, Math.ceil(Number(rect.w) || 0));
  const h = Math.min(canvasH - y, Math.ceil(Number(rect.h) || 0));
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Region analysis size: keep the crop's aspect, cap the width so small targets keep detail. */
export function regionThumbSize(rect, maxW = 256) {
  const w = Math.max(8, Math.min(maxW, rect.w));
  const h = Math.max(4, Math.round((rect.h * w) / rect.w));
  return { w, h };
}

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
