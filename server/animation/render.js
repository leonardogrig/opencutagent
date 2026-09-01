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
import { ffmpegBin } from "../paths.js";
import { fmtDur } from "../tools/util.js";

/**
 * `timeoutMs` is a wall-clock ceiling (0 = none); `stallMs` is the one that
 * matters for long jobs: it restarts on every byte of output, so a step that
 * takes an hour but keeps reporting is left alone while a wedged process is
 * caught and REPORTED instead of hanging forever.
 */
function runProcess(bin, args, { cwd, token, onStdout, onStderr, timeoutMs = 900000, stallMs = 0, label = bin } = {}) {
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
    let stalled = false;
    const kill = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs) : null;
    let stallTimer = stallMs ? setTimeout(() => { stalled = true; kill(); }, stallMs) : null;
    const markProgress = () => {
      if (!stallMs) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { stalled = true; kill(); }, stallMs);
    };
    const clearTimers = () => { if (timer) clearTimeout(timer); if (stallTimer) clearTimeout(stallTimer); };
    let err = "";
    child.stdout.on("data", (d) => { markProgress(); const s = d.toString(); if (onStdout) onStdout(s); });
    child.stderr.on("data", (d) => { markProgress(); const s = d.toString(); err += s; if (err.length > 20000) err = err.slice(-20000); if (onStderr) onStderr(s); });
    child.on("error", (e) => { clearTimers(); reject(new Error(`Could not run ${label}: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimers();
      if (token) { if (token.child === child) token.child = null; if (token.children) token.children.delete(child); }
      if (token && token.aborted) return reject(new Error("Cancelled"));
      if (stalled) return reject(new Error(`${label} stopped reporting progress for ${Math.round(stallMs / 60000)} min and looked stuck, so it was stopped.`));
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

/**
 * If the LIVE sequence's frame size differs from the job's composition size
 * (the size was captured wrong at creation, or the user changed sequences),
 * render with Remotion's --scale so the clip still comes out at the sequence's
 * real resolution. Only when the aspect ratio matches — scaling can't fix a
 * horizontal composition for a vertical sequence. Pure (unit-tested).
 * @returns {{scale:number, outWidth:number|null, warning:string|null}}
 */
export function renderScale(job, seqW, seqH) {
  const w = Number(seqW), h = Number(seqH);
  if (!(w > 0) || !(h > 0) || !(job.width > 0) || !(job.height > 0)) return { scale: 1, outWidth: null, warning: null };
  if (w === job.width && h === job.height) return { scale: 1, outWidth: w, warning: null };
  const aspectJob = job.width / job.height;
  const aspectSeq = w / h;
  if (Math.abs(aspectJob - aspectSeq) > 0.01) {
    return {
      scale: 1,
      outWidth: null,
      warning: `The sequence is ${w}x${h} but this animation was created at ${job.width}x${job.height} (a different shape). Create a new animation to match.`,
    };
  }
  return { scale: w / job.width, outWidth: w, warning: null };
}

/**
 * No wall-clock ceiling by default: a long 4K composition can legitimately
 * render for a very long time, and killing it at an arbitrary minute mark only
 * throws away work. Progress is policed by renderStallMs instead. Opt in with
 * EDITAGENT_ANIM_RENDER_TIMEOUT_MS.
 * @returns {number} milliseconds, or 0 for no cap
 */
function renderTimeoutMs() {
  const v = parseInt(liveEnv("EDITAGENT_ANIM_RENDER_TIMEOUT_MS") || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Remotion prints a line per frame, so silence this long means it is wedged. */
function renderStallMs() {
  const v = parseInt(liveEnv("EDITAGENT_ANIM_RENDER_STALL_MS") || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 600000; // 10 min without a single frame
}

/**
 * Browser tabs, not CPU, are the scarce resource at high resolutions: six
 * concurrent 4K pages starve the headless renderer until pages stop running JS
 * altogether, and whatever delayRender() is open at that moment (in practice
 * the font handle, the only long-lived one) trips the frame timeout. Fewer
 * pages costs some wall clock and buys a render that finishes. Pure.
 * @returns {number|null} concurrency to pass, or null for Remotion's default
 */
export function renderConcurrency(width, height) {
  const forced = parseInt(liveEnv("EDITAGENT_ANIM_CONCURRENCY") || "", 10);
  if (Number.isFinite(forced) && forced > 0) return forced;
  const pixels = Number(width) * Number(height);
  if (!Number.isFinite(pixels) || pixels <= 0) return null;
  if (pixels >= 3840 * 2160) return 3; // 4K and up
  if (pixels >= 2560 * 1440) return 4; // 1440p
  return null; // 1080p and below: Remotion's default is fine
}

function renderAttempts() {
  const v = parseInt(liveEnv("EDITAGENT_ANIM_RENDER_ATTEMPTS") || "", 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 5) : 2;
}

/**
 * A Remotion render can die thousands of frames in for reasons that have
 * nothing to do with the scene: a recycled browser tab that never finishes a
 * delayRender(), a headless renderer that crashes under memory pressure. Those
 * are transient (the same frame range renders fine on the next run), and the
 * user paid for a multi-minute agent turn to get here, so a bare retry is worth
 * far more than a clean error. A cancel or a hard timeout is NOT transient.
 */
export function isTransientRenderError(message) {
  const m = String(message || "");
  if (/Cancelled/i.test(m)) return false;
  if (/timed out after \d+ min/i.test(m)) return false; // our own opt-in hard stop
  if (/stopped reporting progress/i.test(m)) return true; // wedged: a fresh run usually gets through
  return /delayRender|renderer crashed|Target closed|Session closed|Protocol error|browser has disconnected|out of memory|ENOMEM|exit 1\b/i.test(m);
}

/**
 * Render one version of the job's composition into its output folder.
 * @returns {Promise<{path:string, file:string, durationSec:number|null}>}
 */
export async function renderJob({ kitDirPath, job, version, scale = 1, onProgress = () => {}, token }) {
  const transparent = job.background === "transparent";
  const ext = transparent ? ".mov" : ".mp4";
  const file = `${job.id}-v${version}${ext}`;
  const outPath = join(job.outDir, file);
  const tmpPath = join(job.outDir, `.render-tmp-${version}${ext}`);
  mkdirSync(job.outDir, { recursive: true });
  rmSync(tmpPath, { force: true });

  const cli = remotionCliEntry(kitDirPath);
  if (!existsSync(cli)) throw new Error("The animation workspace isn't installed yet (Remotion CLI missing). Create the animation again to set it up.");

  // { final: true } marks the DELIVERABLE render: the kit's DebugFrame (the
  // footage frame a frame-aware agent composites under its stills to verify
  // positioning) reads this input prop and renders nothing, so a leftover debug
  // layer can never ship inside the placed clip. Agent stills don't pass it.
  const args = [cli, "render", job.id, tmpPath, "--timeout=120000", "--muted", "--image-format=png", "--overwrite", '--props={"final":true}'];
  if (transparent) args.push("--codec=prores", "--prores-profile=4444", "--pixel-format=yuva444p10le");
  else args.push("--codec=h264", "--crf=14");
  if (Number.isFinite(scale) && scale > 0 && Math.abs(scale - 1) > 0.001) args.push(`--scale=${scale}`);
  const concurrency = renderConcurrency(job.width * (scale || 1), job.height * (scale || 1));
  if (concurrency) args.push(`--concurrency=${concurrency}`);

  const attempts = renderAttempts();
  for (let attempt = 1; ; attempt++) {
    onProgress(attempt === 1 ? `Rendering animation v${version}…` : `Rendering animation v${version} (attempt ${attempt} of ${attempts})…`);
    let lastPct = -1;
    const onChunk = (s) => {
      const pct = parseRenderProgress(s);
      if (pct != null && pct !== lastPct) { lastPct = pct; onProgress(`Rendering animation v${version}: ${pct}%`); }
    };
    try {
      await runProcess(process.execPath, args, {
        cwd: kitDirPath,
        token,
        timeoutMs: renderTimeoutMs(),
        stallMs: renderStallMs(),
        label: "remotion render",
        onStdout: onChunk,
        onStderr: onChunk,
      });
      break;
    } catch (e) {
      if ((token && token.aborted) || attempt >= attempts || !isTransientRenderError(e.message)) throw e;
      log(`animation render attempt ${attempt}/${attempts} failed, retrying: ${String(e.message).slice(-300)}`);
      onProgress("The renderer stumbled. Starting that render over…");
      rmSync(tmpPath, { force: true });
    }
  }
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
    throw new Error(`The render came out ${fmtDur(durationSec)} but the selection is ${fmtDur(expected)}. The composition duration is fixed by the server — reload and try again.`);
  }
  return { path: outPath, file, durationSec };
}
