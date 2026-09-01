#!/usr/bin/env node
// Check every anchored drawing of a frame-aware job against the footage:
// for each entry in src/jobs/<jobId>/anchors.json, sample the exported frames
// around the drawing's time span, compare the anchor's rect across them, and
// say whether the target is really there for the WHOLE span (not appearing
// later, not disappearing earlier). Also writes a contact sheet per anchor
// (frames just before / at start / middle / at end / just after, rect
// outlined) so you can SEE the moments that matter.
//
//   node scripts/check-anchors.mjs <jobId>
//
// anchors.json format:
//   { "anchors": [
//       { "id": "title-box", "what": "the workflow title", "rect": {"x":466,"y":646,"w":218,"h":56},
//         "from": 1.78, "to": 3.2, "text": "a new workflow", "drawIn": 0.4, "expectMotion": false }
//   ] }
// - text / words: the label drawn with this anchor (or its word count; omit
//   for a bare box/underline). drawIn: seconds the drawing takes to appear.
//   The check fails text that can't be read in the time the target is visible.
// - rect: canvas pixels around the on-screen target (the thing the drawing
//   points at, NOT the drawing itself).
// - from/to: rel seconds the drawing is VISIBLE (first frame to last frame).
// - expectMotion: true when the region legitimately animates (a spinner, a
//   scrolling list) so changes are reported but not failed.
//
// The server runs this same check before rendering; a FAIL comes back to you
// as an automatic message, so run it yourself first.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  grayFrames, judgeAnchor, formatAnchorReport, clampRect, regionThumbSize, nearestFrameIndex, countWords,
} from "./frame-analysis.mjs";

/** Parse + validate anchors.json content. Returns {anchors, errors}. */
export function parseAnchors(json, canvasW, canvasH) {
  const errors = [];
  const list = json && Array.isArray(json.anchors) ? json.anchors : Array.isArray(json) ? json : null;
  if (!list) return { anchors: [], errors: ["anchors.json must be {\"anchors\": [...]}"] };
  const anchors = [];
  list.forEach((a, i) => {
    const id = String((a && a.id) || `anchor-${i + 1}`);
    const rect = clampRect(a && a.rect, canvasW, canvasH);
    const from = Number(a && a.from), to = Number(a && a.to);
    if (!rect) { errors.push(`${id}: rect must be {x,y,w,h} in canvas pixels inside ${canvasW}x${canvasH}`); return; }
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) { errors.push(`${id}: from/to must be rel seconds with to > from`); return; }
    // Text budget: `text` (the label itself) or `words` (a count); `drawIn` =
    // seconds the drawing takes to appear. Both feed the readability check.
    const words = a.text != null ? countWords(a.text) : Math.max(0, Math.round(Number(a.words) || 0));
    const drawIn = Math.max(0, Number(a.drawIn) || 0);
    anchors.push({ id, what: a.what ? String(a.what) : "", rect, from, to, expectMotion: !!a.expectMotion, words, drawIn, text: a.text != null ? String(a.text) : undefined });
  });
  return { anchors, errors };
}

/** The exported frames to sample for one anchor: the span plus one step each side. */
export function anchorSamples(frames, from, to, step) {
  const lo = from - step - 1e-6, hi = to + step + 1e-6;
  const picked = frames.filter((f) => f.t >= lo && f.t <= hi);
  if (!picked.length) {
    const i = nearestFrameIndex(frames, (from + to) / 2);
    return i >= 0 ? [frames[i]] : [];
  }
  return picked;
}

/**
 * Run the check for a job in a kit workspace. Returns
 * { ok, results, report, fails, warns, missing, errors }.
 * `missing` is true when there is no anchors.json at all.
 */
export function runAnchorCheck({ kitDir = process.cwd(), jobId, writeSheets = true, ffmpeg = null }) {
  const jobDir = join(kitDir, "src", "jobs", jobId);
  const mapPath = join(jobDir, "frames-map.json");
  const anchorsPath = join(jobDir, "anchors.json");
  if (!existsSync(mapPath)) return { ok: true, results: [], report: "No frames-map.json: not a frame-aware job.", fails: 0, warns: 0, missing: true, reason: "no-map", errors: [] };
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const frames = (map.frames || []).map((f) => ({ ...f, path: join(kitDir, "public", "frames", jobId, "full", f.file) }));
  if (!frames.length) return { ok: true, results: [], report: "No footage frames for this job (free canvas): nothing to check.", fails: 0, warns: 0, missing: true, reason: "no-frames", errors: [] };
  if (!existsSync(anchorsPath)) return { ok: false, results: [], report: `No anchors.json in src/jobs/${jobId}/: declare every anchored drawing there, then re-run.`, fails: 0, warns: 0, missing: true, reason: "no-anchors", errors: [] };
  let parsed;
  try { parsed = parseAnchors(JSON.parse(readFileSync(anchorsPath, "utf8")), map.canvas.width, map.canvas.height); }
  catch (e) { return { ok: false, results: [], report: `anchors.json is not valid JSON: ${e.message}`, fails: 0, warns: 0, missing: false, reason: "bad-json", errors: [String(e.message)] }; }
  const step = Number(map.step) || 0.5;
  const ff = ffmpeg || map.ffmpeg || "ffmpeg";
  const sheetDir = join(kitDir, "public", "frames", jobId, "check");
  const results = [];
  for (const a of parsed.anchors) {
    const samples = anchorSamples(frames, a.from, a.to, step);
    const size = regionThumbSize(a.rect);
    let regions;
    try {
      regions = grayFrames(ff, samples.map((s) => s.path), { w: size.w, h: size.h, crop: a.rect });
    } catch (e) {
      results.push({ ...a, verdict: "unknown", changes: [], notes: [`could not read the frames: ${e.message}`], sheet: null });
      continue;
    }
    const judged = judgeAnchor(samples.map((s, i) => ({ t: s.t, region: regions[i] })), { from: a.from, to: a.to, step, expectMotion: a.expectMotion, size, words: a.words, drawIn: a.drawIn });
    let sheet = null;
    if (writeSheets) {
      // Show the moment the region changed too, not just the span's ends.
      const extra = judged.changes.filter((c) => c.level === "fail").map((c) => c.t);
      try { sheet = writeSheet(ff, sheetDir, a, samples, step, jobId, extra); } catch (e) { judged.notes.push(`sheet not written: ${e.message}`); }
    }
    results.push({ ...a, ...judged, sheet });
  }
  const fails = results.filter((r) => r.verdict === "fail").length;
  const warns = results.filter((r) => r.verdict === "warn").length;
  const errors = parsed.errors;
  let report = formatAnchorReport(results, { step });
  if (errors.length) report = errors.map((e) => `anchors.json: ${e}`).join("\n") + "\n" + report;
  const out = { ok: fails === 0 && errors.length === 0, results, report, fails, warns, missing: false, errors };
  try { writeFileSync(join(jobDir, "anchor-report.json"), JSON.stringify({ ...out, results: results.map(({ path, ...r }) => r) }, null, 2)); } catch { /* best-effort */ }
  return out;
}

/**
 * Contact sheet: the frames just before, at the start, middle, end, and just
 * after the span, cropped to the rect padded by 50% (min 160px each way) with
 * the rect outlined, tiled left-to-right. Returns the sheet path relative to
 * public/ (as staticFile() would take it).
 */
function writeSheet(ff, sheetDir, a, samples, step, jobId, extraTimes = []) {
  mkdirSync(sheetDir, { recursive: true });
  const want = [a.from - step, a.from, (a.from + a.to) / 2, ...extraTimes, a.to, a.to + step].sort((x, y) => x - y);
  const picks = [];
  const seen = new Set();
  for (const t of want) {
    const i = nearestFrameIndex(samples, t);
    if (i >= 0 && !seen.has(i)) { seen.add(i); picks.push(samples[i]); }
  }
  picks.sort((x, y) => x.t - y.t);
  const padX = Math.max(160, Math.round(a.rect.w * 0.5)), padY = Math.max(160, Math.round(a.rect.h * 0.5));
  const cx = Math.max(0, a.rect.x - padX), cy = Math.max(0, a.rect.y - padY);
  const cw = a.rect.w + (a.rect.x - cx) + padX, ch = a.rect.h + (a.rect.y - cy) + padY;
  const tileW = 480;
  const inputs = [];
  const filters = [];
  picks.forEach((p, i) => {
    inputs.push("-i", p.path);
    // crop with `min()` so the box never exceeds the frame, outline the rect, scale.
    filters.push(`[${i}:v]crop='min(${cw},iw-${cx})':'min(${ch},ih-${cy})':${cx}:${cy},drawbox=${a.rect.x - cx}:${a.rect.y - cy}:${a.rect.w}:${a.rect.h}:color=#ff3b30@0.9:thickness=4,scale=${tileW}:-2,pad=iw+8:ih+8:4:4:color=#202020[t${i}]`);
  });
  const stack = picks.length > 1 ? `${picks.map((_, i) => `[t${i}]`).join("")}hstack=inputs=${picks.length}[out]` : "[t0]copy[out]";
  const file = `${a.id.replace(/[^a-z0-9_-]/gi, "_")}.png`;
  execFileSync(ff, ["-hide_banner", "-nostdin", "-y", "-v", "error", ...inputs, "-filter_complex", filters.join(";") + ";" + stack, "-map", "[out]", "-frames:v", "1", join(sheetDir, file)], { stdio: ["ignore", "ignore", "pipe"] });
  return `frames/${jobId}/check/${file}` + ` (tiles: ${picks.map((p) => p.t.toFixed(2) + "s").join(", ")})`;
}

function main() {
  const jobId = process.argv[2];
  if (!jobId) { console.error("Usage: node scripts/check-anchors.mjs <jobId>"); process.exit(2); }
  const out = runAnchorCheck({ jobId });
  console.log(out.report);
  if (out.results.some((r) => r.sheet)) console.log("Sheets are under public/; Read them to see the target just before, during and after each drawing.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
