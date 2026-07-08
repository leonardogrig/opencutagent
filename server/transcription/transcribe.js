import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { log } from "../log.js";
import { liveEnv } from "../config.js";
import { recordUsage } from "../usage.js";

const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
// ElevenLabs Scribe batch API list price; override in .env if their pricing changes.
const scribeRatePerHourUsd = () => Number(liveEnv("EDITAGENT_SCRIBE_RATE") || 0.22);
// Model precedence: explicit opt (panel dropdown) > .env > default.
const scribeModel = (m) => m || liveEnv("EDITAGENT_SCRIBE_MODEL") || "scribe_v2";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

/**
 * Pluggable transcription engine interface. v1 ships ElevenLabs Scribe; the
 * shape ({ words: [{ type, text, start, end, speaker_id }] }) is what
 * segments.js consumes, so a Deepgram/Whisper engine only needs to map into it.
 */

export class TranscribeError extends Error {
  constructor(message) {
    super(message);
    this.name = "TranscribeError";
  }
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) =>
      reject(new TranscribeError(`Could not run "${bin}": ${e.message}. Is it installed and on PATH?`))
    );
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new TranscribeError(`${bin} exited ${code}: ${stderr.slice(-500)}`))
    );
  });
}

// Extract only the [startSec, endSec] window of the source as mono 16kHz PCM
// (the de-facto STT input contract). `-ss`/`-t` come AFTER `-i` so the seek is
// sample-accurate; the output starts at 0, so the Scribe word times are
// window-relative and get `+startSec` added back to become source seconds.
function extractAudioRange(mediaPath, startSec, endSec, destWav) {
  const dur = Math.max(0.05, endSec - startSec);
  return run(FFMPEG_BIN, [
    "-y", "-i", mediaPath,
    "-ss", String(Math.max(0, startSec)), "-t", String(dur),
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    destWav,
  ]);
}

const r3 = (x) => Math.round(x * 1000) / 1000;

/* ---------- pure interval math (unit-tested in server/test/transcribeRanges.js) ----------
 * We transcribe ONLY the source audio that's actually on the timeline. The used clip
 * source ranges are merged into a few continuous "islands" (padded for word context,
 * nearby ranges coalesced so we make few Scribe calls, not one per clip), and a union
 * cache records which source seconds have already been transcribed so a reload after
 * cutting never re-bills audio we've already paid for. */

// Pad each range, then merge any that overlap or sit within `mergeGapSec` of each other.
export function mergeIntervals(ranges, opts = {}) {
  const mergeGapSec = opts.mergeGapSec == null ? 2.0 : opts.mergeGapSec;
  const padSec = opts.padSec == null ? 0.25 : opts.padSec;
  const rs = (ranges || [])
    .filter((r) => r && isFinite(r.start) && isFinite(r.end) && r.end > r.start)
    .map((r) => [Math.max(0, r.start - padSec), r.end + padSec])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of rs) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + mergeGapSec) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out.map(([s, e]) => ({ start: r3(s), end: r3(e) }));
}

// The parts of `needed` NOT already inside any `covered` interval (interval subtraction).
export function subtractIntervals(needed, covered, eps = 0.05) {
  const cov = (covered || []).map((c) => [c.start, c.end]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const n of needed || []) {
    let segs = [[n.start, n.end]];
    for (const [cs, ce] of cov) {
      const next = [];
      for (const [s, e] of segs) {
        if (ce <= s + eps || cs >= e - eps) { next.push([s, e]); continue; } // disjoint
        if (cs > s + eps) next.push([s, Math.min(cs, e)]);                    // left remainder
        if (ce < e - eps) next.push([Math.max(ce, s), e]);                    // right remainder
      }
      segs = next;
    }
    for (const [s, e] of segs) if (e - s > eps) out.push({ start: r3(s), end: r3(e) });
  }
  return out;
}

// Shift word/audio-event timestamps by `off` seconds (window-relative -> source seconds).
function offsetWords(words, off) {
  return (words || []).map((w) => {
    const o = { ...w };
    if (typeof o.start === "number") o.start = r3(o.start + off);
    if (typeof o.end === "number") o.end = r3(o.end + off);
    return o;
  });
}

// Merge two source-time word lists: concat, sort by start, drop near-duplicates that the
// island padding can transcribe twice at a shared boundary.
export function mergeWords(existing, incoming) {
  const all = [...(existing || []), ...(incoming || [])]
    .filter(Boolean)
    .sort((a, b) => (a.start || 0) - (b.start || 0) || (a.end || 0) - (b.end || 0));
  const out = [];
  for (const w of all) {
    const prev = out[out.length - 1];
    if (
      prev &&
      Math.abs((prev.start || 0) - (w.start || 0)) < 0.03 &&
      Math.abs((prev.end || 0) - (w.end || 0)) < 0.05 &&
      (prev.text || "") === (w.text || "")
    ) continue;
    out.push(w);
  }
  return out;
}

async function callScribe(wavPath, apiKey, { model, language, numSpeakers } = {}) {
  const buf = readFileSync(wavPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), basename(wavPath));
  form.append("model_id", scribeModel(model));
  form.append("diarize", "true");
  form.append("tag_audio_events", "true");
  form.append("timestamps_granularity", "word");
  if (language) form.append("language_code", language);
  if (numSpeakers) form.append("num_speakers", String(numSpeakers));

  const resp = await fetch(SCRIBE_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let detail = null;
    try { detail = JSON.parse(text).detail; } catch { /* not JSON */ }
    if (detail?.status === "quota_exceeded" || /quota/i.test(text)) {
      const err = new TranscribeError(
        `ElevenLabs credit quota exceeded. ${detail?.message || text.slice(0, 200)} ` +
        "Everything transcribed so far is cached and will not re-bill. To finish: wait for your monthly credit reset (or upgrade the plan), then Reload. " +
        "Tip: running Remove Silences or cutting retakes first shrinks the timeline audio that still needs transcribing."
      );
      err.code = "quota_exceeded";
      throw err;
    }
    if (resp.status === 401) {
      throw new TranscribeError(
        `ElevenLabs rejected the API key (401). Update it in the panel's settings (gear icon > ElevenLabs) and make sure it has the speech_to_text permission scope. ${text.slice(0, 200)}`
      );
    }
    throw new TranscribeError(`ElevenLabs Scribe returned ${resp.status}: ${text.slice(0, 400)}`);
  }
  return resp.json();
}

function cacheKey(mediaPath) {
  // Stable per source content: stem + short hash of (abs path, size, mtime).
  // Re-transcribes only if the source file itself changes.
  const st = statSync(mediaPath);
  const h = createHash("sha1")
    .update(`${mediaPath}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest("hex")
    .slice(0, 10);
  const stem = basename(mediaPath, extname(mediaPath)).replace(/[^\w.-]/g, "_");
  return `${stem}.${h}.json`;
}

/**
 * Transcribe ONLY the source audio that's on the timeline. `ranges` are the used clip
 * source windows ([{start,end}] in source seconds); they're merged into padded islands
 * and only the parts not already in the union cache are sent to Scribe — so off-timeline
 * footage is never billed, and a reload after cutting (a subset of what's cached) is free.
 * Returns `{ payload: { words } }` with word times in SOURCE seconds (so segments.js
 * slicing is unchanged). Falls back to reusing a prior whole-file transcript
 * (the pre-ranged cache format) if one is already cached.
 */
export async function transcribeSourceRanges(mediaPath, ranges, opts = {}) {
  const { cacheDir, model, language, numSpeakers, refresh = false } = opts;
  const apiKey = liveEnv("ELEVENLABS_API_KEY");
  if (!apiKey) {
    throw new TranscribeError(
      "ELEVENLABS_API_KEY is not set. Add your ElevenLabs API key in the panel's settings (gear icon > ElevenLabs), or in the project .env, then retry."
    );
  }
  if (!existsSync(mediaPath)) {
    throw new TranscribeError(`Source media not found on disk: ${mediaPath}`);
  }

  const mergeGapSec = Number(liveEnv("EDITAGENT_TRANSCRIBE_MERGE_GAP") || 2);
  const padSec = Number(liveEnv("EDITAGENT_TRANSCRIBE_PAD") || 0.25);
  const needed = mergeIntervals(ranges, { mergeGapSec, padSec });
  if (!needed.length) return { payload: { words: [] }, cached: true, path: null };

  const transcriptsDir = join(cacheDir, "transcripts");
  mkdirSync(transcriptsDir, { recursive: true });
  const key = cacheKey(mediaPath);
  const wholePath = join(transcriptsDir, key);                       // legacy whole-file cache
  const rangedPath = join(transcriptsDir, key.replace(/\.json$/, ".ranged.json"));

  // A prior whole-file transcript already covers every range — reuse it, don't re-bill.
  if (existsSync(wholePath) && !refresh) {
    log(`transcript cache hit (whole file): ${basename(wholePath)}`);
    return { payload: JSON.parse(readFileSync(wholePath, "utf8")), cached: true, path: wholePath };
  }

  let cache = { islands: [], words: [] };
  if (existsSync(rangedPath) && !refresh) {
    try {
      const parsed = JSON.parse(readFileSync(rangedPath, "utf8"));
      if (parsed && Array.isArray(parsed.islands) && Array.isArray(parsed.words)) cache = parsed;
    } catch { /* corrupt cache — re-transcribe */ }
  }

  const uncovered = subtractIntervals(needed, cache.islands);
  if (!uncovered.length) {
    log(`transcript cache hit (ranged, ${cache.words.length} words): ${basename(rangedPath)}`);
    return { payload: { words: cache.words }, cached: true, path: rangedPath };
  }

  // Recombine the gaps to transcribe (as few Scribe calls as possible).
  const toDo = mergeIntervals(uncovered, { mergeGapSec, padSec: 0 });
  let words = cache.words;
  let islands = cache.islands;
  for (const isl of toDo) {
    const tmpWav = join(tmpdir(), `editagent-${Date.now()}-${Math.floor(performance.now())}.wav`);
    try {
      log(`extracting audio [${isl.start.toFixed(1)}-${isl.end.toFixed(1)}s]: ${basename(mediaPath)}`);
      await extractAudioRange(mediaPath, isl.start, isl.end, tmpWav);
      log(`transcribing via Scribe [${isl.start.toFixed(1)}-${isl.end.toFixed(1)}s]: ${basename(mediaPath)}`);
      const payload = await callScribe(tmpWav, apiKey, { model, language, numSpeakers });
      const billedSec = isl.end - isl.start;
      recordUsage({
        type: "transcription",
        model: scribeModel(model),
        media: basename(mediaPath),
        seconds: r3(billedSec),
        costUsd: (billedSec / 3600) * scribeRatePerHourUsd(),
      });
      words = mergeWords(words, offsetWords(payload.words || [], isl.start));
      // Persist the union cache after EVERY island: if a later island fails
      // (quota, network), the Scribe work already billed here survives and the
      // retry only pays for what's still uncovered.
      islands = mergeIntervals([...islands, isl], { mergeGapSec: 0, padSec: 0 });
      writeFileSync(rangedPath, JSON.stringify({ model: scribeModel(model), islands, words }, null, 2));
    } finally {
      try { rmSync(tmpWav, { force: true }); } catch { /* ignore */ }
    }
  }
  log(`ranged transcript saved: ${basename(rangedPath)} (${words.length} words, ${islands.length} island(s))`);
  return { payload: { words }, cached: false, path: rangedPath };
}
