// Final render + Premiere placement for an animation job. The agent never
// renders the deliverable — the server does, with pinned encoder settings:
//  - solid bg  -> Remotion h264 (PNG frames, CRF 14) then an ffmpeg ALL-INTRA
//    transcode (-g 1 -bf 0). Premiere's long-GOP H.264 decoder is unreliable
//    ("Error retrieving frame"), and all-intra edits flawlessly.
//  - transparent -> Remotion ProRes 4444 with alpha (.mov), already all-intra;
//    just remuxed with -an so no silent audio track reaches the timeline.
// Every render gets a NEW versioned filename: re-rendering onto a file Premiere
// has imported goes stale in its media cache.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { liveEnv } from "../config.js";
import { remotionCliEntry } from "./kit.js";
import { log } from "../log.js";

const ffmpegBin = () => liveEnv("FFMPEG_BIN") || "ffmpeg";

function runProcess(bin, args, { cwd, token, onStdout, onStderr, timeoutMs = 900000, label = bin } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(`Could not run ${label}: ${e.message}`));
      return;
    }
    if (token) { token.child = child; if (token.children) token.children.add(child); }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    let err = "";
    child.stdout.on("data", (d) => { const s = d.toString(); if (onStdout) onStdout(s); });
    child.stderr.on("data", (d) => { const s = d.toString(); err += s; if (err.length > 20000) err = err.slice(-20000); if (onStderr) onStderr(s); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`Could not run ${label}: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (token) { if (token.child === child) token.child = null; if (token.children) token.children.delete(child); }
      if (token && token.aborted) return reject(new Error("Cancelled"));
      if (timedOut) return reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 60000)} min.`));
      if (code === 0) return resolve({ stderr: err });
      reject(new Error(`${label} failed (exit ${code}). ${err.slice(-600)}`));
    });
  });
}

/** Parse "Duration: 00:01:23.45" out of ffmpeg -i stderr. */
export function parseFfDuration(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(text || ""));
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function probeDurationSec(path, token) {
  // `ffmpeg -i <file>` exits non-zero (no output specified) but prints the
  // Duration line we need — capture stderr from the rejection too.
  let stderr = "";
  try {
    const r = await runProcess(ffmpegBin(), ["-hide_banner", "-i", path], { token, timeoutMs: 30000, label: "ffmpeg probe" });
    stderr = r.stderr;
  } catch (e) {
    stderr = String(e.message || "");
  }
  return parseFfDuration(stderr);
}

/** Best-effort "Rendered 123/456" progress out of the Remotion CLI output. */
export function parseRenderProgress(chunk) {
  const matches = String(chunk || "").match(/(\d+)\s*\/\s*(\d+)/g);
  if (!matches || !matches.length) return null;
  const m = /(\d+)\s*\/\s*(\d+)/.exec(matches[matches.length - 1]);
  const done = Number(m[1]), total = Number(m[2]);
  if (!total || done > total) return null;
  return Math.min(99, Math.round((done / total) * 100));
}

function renderTimeoutMs() {
  const v = parseInt(liveEnv("EDITAGENT_ANIM_RENDER_TIMEOUT_MS") || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 1800000; // 30 min hard stop for one render
}

/**
 * Render one version of the job's composition into its output folder.
 * @returns {Promise<{path:string, file:string, durationSec:number|null}>}
 */
export async function renderJob({ kitDirPath, job, version, onProgress = () => {}, token }) {
  const transparent = job.background === "transparent";
  const ext = transparent ? ".mov" : ".mp4";
  const file = `${job.id}-v${version}${ext}`;
  const outPath = join(job.outDir, file);
  const tmpPath = join(job.outDir, `.render-tmp-${version}${ext}`);
  mkdirSync(job.outDir, { recursive: true });
  rmSync(tmpPath, { force: true });

  const cli = remotionCliEntry(kitDirPath);
  if (!existsSync(cli)) throw new Error("The animation workspace isn't installed yet (Remotion CLI missing). Create the animation again to set it up.");

  const args = [cli, "render", job.id, tmpPath, "--timeout=120000", "--muted", "--image-format=png", "--overwrite"];
  if (transparent) args.push("--codec=prores", "--prores-profile=4444", "--pixel-format=yuva444p10le");
  else args.push("--codec=h264", "--crf=14");

  onProgress(`Rendering animation v${version}…`);
  let lastPct = -1;
  await runProcess(process.execPath, args, {
    cwd: kitDirPath,
    token,
    timeoutMs: renderTimeoutMs(),
    label: "remotion render",
    onStdout: (s) => {
      const pct = parseRenderProgress(s);
      if (pct != null && pct !== lastPct) { lastPct = pct; onProgress(`Rendering animation v${version}: ${pct}%`); }
    },
    onStderr: (s) => {
      const pct = parseRenderProgress(s);
      if (pct != null && pct !== lastPct) { lastPct = pct; onProgress(`Rendering animation v${version}: ${pct}%`); }
    },
  });
  if (!existsSync(tmpPath)) throw new Error("Remotion reported success but produced no file.");

  // Premiere-safe finishing pass.
  onProgress("Preparing the clip for Premiere…");
  rmSync(outPath, { force: true });
  if (transparent) {
    await runProcess(ffmpegBin(), ["-y", "-i", tmpPath, "-c", "copy", "-an", outPath], { token, timeoutMs: 300000, label: "ffmpeg remux" });
  } else {
    await runProcess(
      ffmpegBin(),
      ["-y", "-i", tmpPath, "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-g", "1", "-bf", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", outPath],
      { token, timeoutMs: 900000, label: "ffmpeg all-intra transcode" }
    );
  }
  rmSync(tmpPath, { force: true });

  // Sanity: the clip must match the selected range (within a generous 0.25s —
  // container timestamps round a little).
  const expected = job.durationInFrames / job.fps;
  const durationSec = await probeDurationSec(outPath, token);
  if (durationSec != null && Math.abs(durationSec - expected) > Math.max(0.25, 2 / job.fps)) {
    log(`animation render duration mismatch: got ${durationSec}s, expected ${expected}s`);
    throw new Error(`The render came out ${durationSec.toFixed(2)}s but the selection is ${expected.toFixed(2)}s. The composition duration is fixed by the server — reload and try again.`);
  }
  return { path: outPath, file, durationSec };
}
