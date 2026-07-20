// Cheap "does this media file have an audio stream?" probe. Silent video is a
// normal citizen of an OpenCutAgent timeline (every animation clip the panel
// places on V2 is a muted render), and feeding one to the transcriber or the
// loudness scanner makes ffmpeg die with the cryptic "Output file does not
// contain any stream". Both paths skip such sources instead, via this probe.
//
// `ffmpeg -i <file>` with no output always exits non-zero but prints the
// stream table on stderr — that's all we need. Results are memoized per
// path+mtime so a timeline with hundreds of clips probes each source once.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { log } from "../log.js";

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

/** Whether an `ffmpeg -i` stderr dump lists at least one audio stream. Pure (unit-tested). */
export function stderrListsAudio(text) {
  return /^\s*Stream #.*: Audio/m.test(String(text || ""));
}

const memo = new Map(); // `${path}|${mtime}` -> boolean

/**
 * True when the file has an audio stream, false when it provably doesn't.
 * A probe failure (ffmpeg missing, unreadable file) returns true so the real
 * pipeline runs and reports its own, more specific error.
 */
export function hasAudioStream(mediaPath) {
  let key = mediaPath;
  try { key = `${mediaPath}|${Math.round(statSync(mediaPath).mtimeMs)}`; } catch { /* keep path-only key */ }
  if (memo.has(key)) return Promise.resolve(memo.get(key));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(FFMPEG_BIN, ["-hide_banner", "-nostdin", "-i", mediaPath], { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      resolve(true);
      return;
    }
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 65536) stderr = stderr.slice(-65536); });
    child.on("error", () => resolve(true));
    child.on("close", () => {
      const has = stderrListsAudio(stderr);
      memo.set(key, has);
      if (!has) log(`probe: no audio stream in ${mediaPath.split(/[\\/]/).pop()} (will be skipped by audio passes)`);
      resolve(has);
    });
  });
}
