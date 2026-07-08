// Loudness envelope extraction — the data behind the Remove Silences waveform.
//
// We decode the source to mono PCM with ffmpeg and STREAM it, reducing each
// short window to its PEAK level (dBFS) without ever holding the whole signal
// in memory. The result is a small evenly-spaced array (~50 values/sec) that
// drives both the panel's dB visualization and the silence detector
// (audio/silence.js).
//
// PEAK per window (not RMS), NORMALIZED to the recording's own peak, with a
// hard −60 dB floor — matching how AutoCut/TimeBolt meter. RMS reads quiet
// audio ~8–12 dB colder, which put half a quiet recording BELOW the panel's
// −60 slider minimum ("−60" detected thousands of silences when the user
// expected "detect nothing"); and without normalization a soft take reads
// 5–15 dB colder than a hot one, so the same threshold shreds quiet speech.
// With the clamp, the envelope never goes below the visible axis, so the
// slider minimum literally disables detection (loud = db >= threshold).
//
// This is transcription-free: the Remove Silences tab needs no Scribe call and
// no API key — just ffmpeg — so it's fast and costs nothing. Cached per source
// file (keyed on path+size+mtime) exactly like transcripts, so reopening a clip
// is instant.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { log } from "../log.js";
import { ENVELOPE_FLOOR_DB } from "./silence.js";

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

// 8 kHz mono is ample for a silence envelope (160 samples per 20 ms window) and
// halves the bytes streamed vs 16 kHz. 20 ms windows → 50 Hz envelope.
const SAMPLE_RATE = 8000;
const WINDOW_SEC = 0.02;
const CACHE_VERSION = 3; // v2: peak-per-window + −60 floor (was RMS/−100); v3: peak-NORMALIZED (recording-relative dB)

export class LevelsError extends Error {
  constructor(message) {
    super(message);
    this.name = "LevelsError";
  }
}

function cacheKey(mediaPath) {
  const st = statSync(mediaPath);
  const h = createHash("sha1")
    .update(`v${CACHE_VERSION}|${mediaPath}|${st.size}|${Math.round(st.mtimeMs)}|${SAMPLE_RATE}|${WINDOW_SEC}`)
    .digest("hex")
    .slice(0, 10);
  const stem = basename(mediaPath, extname(mediaPath)).replace(/[^\w.-]/g, "_");
  return `${stem}.${h}.json`;
}

/**
 * Run ffmpeg, decode to s16le mono @ SAMPLE_RATE, and reduce the stream to a
 * dBFS-per-window array. Resolves { sampleRate, hopSec, windowSec, floorDb,
 * durationSec, db: number[] }.
 */
function extractEnvelope(mediaPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error", "-nostdin",
      "-i", mediaPath,
      "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE),
      "-f", "s16le", "-",
    ];
    const p = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    const windowSamples = Math.round(SAMPLE_RATE * WINDOW_SEC);
    const peaks = []; // linear per-window peaks; converted to normalized dB at close
    let peak = 0;
    let count = 0;
    let totalSamples = 0;
    let carryLowByte = -1; // a split 16-bit sample across chunk boundaries
    let stderr = "";

    const pushWindow = () => {
      peaks.push(peak);
      peak = 0;
      count = 0;
    };

    const addSample = (int16) => {
      const f = int16 < 0 ? -int16 / 32768 : int16 / 32768;
      if (f > peak) peak = f;
      count += 1;
      totalSamples += 1;
      if (count >= windowSamples) pushWindow();
    };

    p.stdout.on("data", (chunk) => {
      let off = 0;
      const len = chunk.length;
      if (carryLowByte >= 0 && len > 0) {
        const sample = (chunk[0] << 8) | carryLowByte;
        addSample(sample > 32767 ? sample - 65536 : sample);
        carryLowByte = -1;
        off = 1;
      }
      const pairEnd = off + (((len - off) >> 1) << 1);
      for (let i = off; i < pairEnd; i += 2) {
        const sample = (chunk[i + 1] << 8) | chunk[i];
        addSample(sample > 32767 ? sample - 65536 : sample);
      }
      if (pairEnd < len) carryLowByte = chunk[pairEnd];
    });

    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) =>
      reject(new LevelsError(`Could not run "${FFMPEG_BIN}": ${e.message}. Is ffmpeg installed and on PATH?`))
    );
    p.on("close", (code) => {
      if (code !== 0) {
        reject(new LevelsError(`ffmpeg exited ${code} for ${basename(mediaPath)}: ${stderr.slice(-400)}`));
        return;
      }
      if (count >= windowSamples / 2) pushWindow(); // flush a substantial tail window

      // NORMALIZE to the recording's own peak (99.9th-percentile window peak —
      // robust to one freak transient) before converting to dB. This is what
      // makes threshold values portable: AutoCut/TimeBolt slider numbers (and
      // their "−30…−42 works for most recordings" advice) are relative to the
      // recording's loudness, not absolute dBFS. Without it, a quietly-recorded
      // take reads 5–15 dB colder and the same threshold shreds soft speech.
      const nonZero = peaks.filter((v) => v > 0).sort((a, b) => a - b);
      const ref = nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.round(0.999 * (nonZero.length - 1)))] : 0;
      const gainDb = ref > 0 ? Math.min(30, -(20 * Math.log10(ref))) : 0; // cap +30 dB (near-silent files)
      const db = peaks.map((v) => {
        let d = v > 0 ? 20 * Math.log10(v) + gainDb : ENVELOPE_FLOOR_DB;
        if (d < ENVELOPE_FLOOR_DB) d = ENVELOPE_FLOOR_DB;
        if (d > 0) d = 0;
        return Math.round(d * 10) / 10;
      });

      resolve({
        sampleRate: SAMPLE_RATE,
        hopSec: WINDOW_SEC,
        windowSec: WINDOW_SEC,
        floorDb: ENVELOPE_FLOOR_DB,
        normGainDb: Math.round(gainDb * 10) / 10,
        durationSec: Math.round((totalSamples / SAMPLE_RATE) * 1000) / 1000,
        db,
      });
    });
  });
}

// In-memory memo of parsed envelopes: buildLevels calls getLevels once per
// CLIP, and a tightened timeline has hundreds of clips from one source — the
// memo makes repeats free (no re-read/re-parse) and logs the hit ONCE per file
// instead of once per clip (which read like something was broken).
// Capped: the server is long-lived and a 2h envelope is ~3MB; evict the oldest
// entry (Map preserves insertion order) once distinct sources pile up.
const ENVELOPE_MEMO_MAX = 8;
const envelopeMemo = new Map(); // outPath -> envelope

function memoSet(outPath, env) {
  envelopeMemo.delete(outPath); // re-insert = refresh recency
  envelopeMemo.set(outPath, env);
  while (envelopeMemo.size > ENVELOPE_MEMO_MAX) {
    envelopeMemo.delete(envelopeMemo.keys().next().value);
  }
}

/**
 * Loudness envelope for a source file, cached on disk under <cacheDir>/levels/.
 * Returns { envelope, cached, path }.
 */
export async function getLevels(mediaPath, opts = {}) {
  const { cacheDir, refresh = false } = opts;
  if (!existsSync(mediaPath)) {
    throw new LevelsError(`Source media not found on disk: ${mediaPath}`);
  }
  const levelsDir = join(cacheDir, "levels");
  mkdirSync(levelsDir, { recursive: true });
  const outPath = join(levelsDir, cacheKey(mediaPath));

  if (!refresh) {
    const memo = envelopeMemo.get(outPath);
    if (memo) return { envelope: memo, cached: true, path: outPath };
    if (existsSync(outPath)) {
      try {
        const env = JSON.parse(readFileSync(outPath, "utf8"));
        if (env && Array.isArray(env.db) && env.hopSec > 0) {
          log(`levels: reusing cached analysis ${basename(outPath)}`);
          memoSet(outPath, env);
          return { envelope: env, cached: true, path: outPath };
        }
      } catch {
        /* fall through and re-extract */
      }
    }
  }

  log(`extracting loudness: ${basename(mediaPath)}`);
  const envelope = await extractEnvelope(mediaPath);
  writeFileSync(outPath, JSON.stringify(envelope));
  memoSet(outPath, envelope);
  log(`levels saved: ${basename(outPath)} (${envelope.db.length} windows, ${envelope.durationSec}s)`);
  return { envelope, cached: false, path: outPath };
}

/**
 * Slice an envelope to a clip's visible source window [inSec, outSec].
 * Returns { db, hopSec, firstWindowSrcSec } — db[0] is at source time
 * firstWindowSrcSec, so callers map to the timeline with the clip's offset.
 */
export function sliceEnvelope(envelope, inSec, outSec) {
  const hop = envelope.hopSec;
  const n = envelope.db.length;
  const startIdx = Math.max(0, Math.floor(inSec / hop));
  const endIdx = Math.min(n, Math.ceil(outSec / hop));
  return {
    db: envelope.db.slice(startIdx, endIdx),
    hopSec: hop,
    firstWindowSrcSec: startIdx * hop,
  };
}
