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

function run(bin, args, onStderrChunk) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 8192) stderr = stderr.slice(-4096); // keep the tail for error messages
      if (onStderrChunk) { try { onStderrChunk(s); } catch { /* progress must never kill the job */ } }
    });
    p.on("error", (e) =>
      reject(new TranscribeError(`Could not run "${bin}": ${e.message}. Is it installed and on PATH?`))
    );
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new TranscribeError(`${bin} exited ${code}: ${stderr.slice(-500)}`))
    );
  });
}

// Fast+accurate seek: a coarse input seek (`-ss` BEFORE `-i`, keyframe-fast) lands a
// couple of seconds early, then a precise output seek covers the remainder. Without the
// input seek, ffmpeg decodes the whole file up to the window — minutes on a 2h source.
const SEEK_CUSHION_SEC = 2;

// Extract only the [startSec, endSec] window of the source as mono 16kHz PCM
// (the de-facto STT input contract). The output starts at 0, so the Scribe word
// times are window-relative and get `+startSec` added back to become source seconds.
function extractAudioRange(mediaPath, startSec, endSec, destWav) {
  const dur = Math.max(0.05, endSec - startSec);
  const seek = Math.max(0, startSec - SEEK_CUSHION_SEC);
  return run(FFMPEG_BIN, [
    "-y", "-ss", String(seek), "-i", mediaPath,
    "-ss", String(Math.max(0, startSec) - seek), "-t", String(dur),
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    destWav,
  ]);
}

// Pull the latest output position (seconds) from an ffmpeg `-progress` stderr chunk.
// ffmpeg emits `out_time_ms=` in MICROseconds (historical quirk) plus `out_time=` as
// HH:MM:SS.micro; either works, prefer the numeric one. Returns null if the chunk has no
// progress line.
export function parseFfmpegOutTime(chunk) {
  let sec = null;
  const nums = String(chunk).match(/out_time_ms=(\d+)/g);
  if (nums && nums.length) sec = Number(nums[nums.length - 1].slice("out_time_ms=".length)) / 1e6;
  else {
    const times = String(chunk).match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
    if (times && times.length) {
      const [, h, m, s] = times[times.length - 1].match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      sec = Number(h) * 3600 + Number(m) * 60 + Number(s);
    }
  }
  return sec != null && isFinite(sec) && sec >= 0 ? sec : null;
}

// Extract MANY [start,end] windows in ONE ffmpeg pass, concatenated with a short
// silence spacer between them (apad), as mono 16kHz PCM. One decode of the source,
// one output file — instead of one ffmpeg spawn per island. The filter graph is
// passed via -filter_complex_script (a temp file) so hundreds of islands can't
// blow past ARG_MAX.
function extractConcatAudio(mediaPath, islands, spacerSec, destWav, onOutSec) {
  // Input-seek to just before the batch's first island; atrim times shift accordingly
  // (after an input seek the decoded stream's clock restarts near 0).
  const seek = Math.max(0, islands[0].start - SEEK_CUSHION_SEC);
  const segs = islands.map((isl, i) => {
    const pad = i < islands.length - 1 && spacerSec > 0 ? `,apad=pad_dur=${spacerSec}` : "";
    return `[0:a]atrim=start=${r3(isl.start - seek)}:end=${r3(isl.end - seek)},asetpts=PTS-STARTPTS${pad}[s${i}]`;
  });
  const filter =
    segs.join(";") + ";" +
    islands.map((_, i) => `[s${i}]`).join("") +
    `concat=n=${islands.length}:v=0:a=1[out]`;
  const scriptPath = `${destWav}.filter`;
  writeFileSync(scriptPath, filter);
  const onChunk = onOutSec
    ? (chunk) => { const sec = parseFfmpegOutTime(chunk); if (sec != null) onOutSec(sec); }
    : undefined;
  const done = run(FFMPEG_BIN, [
    "-y", "-ss", String(seek), "-i", mediaPath,
    "-filter_complex_script", scriptPath,
    "-map", "[out]",
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    "-nostats", "-progress", "pipe:2",
    destWav,
  ], onChunk);
  return done.finally(() => { try { rmSync(scriptPath, { force: true }); } catch { /* ignore */ } });
}

const r3 = (x) => Math.round(x * 1000) / 1000;

/* ---------- concat batching (pure, unit-tested in server/test/transcribeRanges.js) ----------
 * Instead of one Scribe upload per island (N HTTP round-trips on a chopped-up timeline),
 * islands are packed into a few duration-capped batches; each batch is concatenated into
 * ONE wav (with silence spacers so Scribe never glues words across a joint) and sent as
 * ONE Scribe call, then word times are remapped from concat time back to source time. */

// Greedy in-order packing: consecutive islands go into one batch until adding the next
// would exceed maxSec of audio. An island longer than maxSec becomes its own batch
// (never split — the union cache and word offsets stay island-aligned).
export function planConcatBatches(islands, maxSec = 1800) {
  const batches = [];
  let cur = [];
  let curDur = 0;
  for (const isl of islands || []) {
    const d = isl.end - isl.start;
    if (cur.length && curDur + d > maxSec) { batches.push(cur); cur = []; curDur = 0; }
    cur.push(isl);
    curDur += d;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// Where each island lands in the concatenated wav: [concatStart, concatEnd] plus its
// source start, with `spacerSec` of silence between islands (none after the last).
export function buildConcatLayout(islands, spacerSec = 1.0) {
  const layout = [];
  let t = 0;
  for (const isl of islands || []) {
    const dur = isl.end - isl.start;
    layout.push({ concatStart: r3(t), concatEnd: r3(t + dur), sourceStart: isl.start });
    t += dur + spacerSec;
  }
  const totalSec = layout.length ? r3(t - spacerSec) : 0;
  return { layout, totalSec };
}

// Map Scribe word times on the concatenated wav back to SOURCE seconds. Each word is
// assigned to the island it overlaps MOST (both lists are time-sorted, so a single
// advancing cursor keeps this O(words + islands)) — so a word overhanging an island
// edge is clamped into that island, while anything Scribe emits entirely inside a
// silence spacer (a hallucination) is dropped.
export function remapConcatWords(words, layout, eps = 0.05) {
  const sorted = [...(words || [])]
    .filter((w) => w && typeof w.start === "number")
    .sort((a, b) => a.start - b.start);
  const out = [];
  let i = 0;
  const overlap = (w, l) =>
    l ? Math.min(typeof w.end === "number" ? w.end : w.start + 0.01, l.concatEnd) - Math.max(w.start, l.concatStart) : -Infinity;
  for (const w of sorted) {
    while (i < layout.length - 1 && w.start >= layout[i + 1].concatStart - eps) i++;
    // candidate islands: the cursor's and the next (a word can straddle a spacer edge)
    const span = overlap(w, layout[i + 1]) > overlap(w, layout[i]) ? layout[i + 1] : layout[i];
    if (!span || overlap(w, span) < -eps) continue; // entirely inside a spacer — hallucinated
    const off = span.sourceStart - span.concatStart;
    const srcEnd = span.sourceStart + (span.concatEnd - span.concatStart);
    const o = { ...w, start: r3(Math.max(span.sourceStart, w.start + off)) };
    if (typeof w.end === "number") {
      o.end = r3(Math.min(srcEnd, w.end + off));
      if (o.end <= o.start) o.end = r3(o.start + 0.01);
    }
    out.push(o);
  }
  return out;
}

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
  // Progress messages ("Transcribing: 42% (3/8 parts done)") for the panel status line;
  // a throwing callback must never kill a transcription that's billing credits.
  const onProgress = (msg) => { if (opts.onProgress) { try { opts.onProgress(msg); } catch { /* ignore */ } } };
  const apiKey = liveEnv("ELEVENLABS_API_KEY");
  if (!apiKey) {
    throw new TranscribeError(
      "ELEVENLABS_API_KEY is not set. Add your ElevenLabs API key in the panel's settings (gear icon > ElevenLabs), or in the project .env, then retry."
    );
  }
  if (!existsSync(mediaPath)) {
    throw new TranscribeError(`Source media not found on disk: ${mediaPath}`);
  }

  const mergeGapSec = Number(liveEnv("EDITAGENT_TRANSCRIBE_MERGE_GAP") || 5);
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

  // Recombine the gaps to transcribe, then pack the islands into a few duration-capped
  // batches — each batch is ONE ffmpeg concat + ONE Scribe call, not one call per island.
  const toDo = mergeIntervals(uncovered, { mergeGapSec, padSec: 0 });
  const spacerSec = 1.0; // silence between islands in a concat wav; keeps Scribe from joining words
  const batchMaxSec = Number(liveEnv("EDITAGENT_TRANSCRIBE_BATCH_SEC") || 360);
  const concurrency = Math.max(1, Math.min(8, Number(liveEnv("EDITAGENT_TRANSCRIBE_CONCURRENCY") || 3)));
  const batches = planConcatBatches(toDo, batchMaxSec);
  let words = cache.words;
  let islands = cache.islands;

  // --- truthful progress: % = audio seconds fully transcribed / total needed. Extraction
  // adds a small measured contribution (ffmpeg -progress) so long extracts visibly move,
  // but a Scribe call in flight never fakes movement — parts are small, so it ticks often.
  const audioOf = (isls) => isls.reduce((a, r) => a + (r.end - r.start), 0);
  const totalAudio = audioOf(toDo);
  let doneAudio = 0;
  let doneBatches = 0;
  const extractedSec = new Map(); // batch index -> seconds extracted so far
  let lastReportAt = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReportAt < 400) return; // don't flood the WS/status line
    lastReportAt = now;
    let extracting = 0;
    for (const sec of extractedSec.values()) extracting += sec;
    // extraction counts for at most 30% of a part's weight; completion is the real signal
    const pct = doneBatches >= batches.length
      ? 100
      : totalAudio > 0 ? Math.min(99, Math.round(((doneAudio + extracting * 0.3) / totalAudio) * 100)) : 0;
    onProgress(`Transcribing: ${pct}% (${doneBatches}/${batches.length} parts done)`);
  };

  const recordBilled = (billedSec) =>
    recordUsage({
      type: "transcription",
      model: scribeModel(model),
      media: basename(mediaPath),
      seconds: r3(billedSec),
      costUsd: (billedSec / 3600) * scribeRatePerHourUsd(),
    });
  // Persist the union cache after EVERY successful Scribe call: if a later call fails
  // (quota, network), the work already billed survives and the retry only pays for
  // what's still uncovered.
  const commit = (batchIslands, srcWords) => {
    words = mergeWords(words, srcWords);
    islands = mergeIntervals([...islands, ...batchIslands], { mergeGapSec: 0, padSec: 0 });
    writeFileSync(rangedPath, JSON.stringify({ model: scribeModel(model), islands, words }, null, 2));
  };
  const scribeOpts = { model, language, numSpeakers };
  let tmpSeq = 0;
  const tmpName = () => join(tmpdir(), `editagent-${Date.now()}-${process.pid}-${++tmpSeq}.wav`);

  // Single-island transcription (also the fallback path if a concat extract fails).
  // Does NOT touch the batch progress counters; its callers do.
  const transcribeOne = async (isl) => {
    const tmpWav = tmpName();
    try {
      log(`transcribing via Scribe [${isl.start.toFixed(1)}-${isl.end.toFixed(1)}s]: ${basename(mediaPath)}`);
      await extractAudioRange(mediaPath, isl.start, isl.end, tmpWav);
      const payload = await callScribe(tmpWav, apiKey, scribeOpts);
      recordBilled(isl.end - isl.start);
      commit([isl], offsetWords(payload.words || [], isl.start));
    } finally {
      try { rmSync(tmpWav, { force: true }); } catch { /* ignore */ }
    }
  };

  const processBatch = async (batch, idx) => {
    const batchAudio = audioOf(batch);
    try {
      await transcribeBatch(batch, idx, batchAudio);
    } finally {
      // A finished part counts fully below; a failed one stops claiming extraction progress.
      extractedSec.delete(idx);
    }
    doneAudio += batchAudio;
    doneBatches += 1;
    report(true);
  };

  const transcribeBatch = async (batch, idx, batchAudio) => {
    if (batch.length === 1) {
      await transcribeOne(batch[0]);
      return;
    }
    const { layout, totalSec } = buildConcatLayout(batch, spacerSec);
    const tmpWav = tmpName();
    try {
      log(
        `extracting ${batch.length} ranges [${batch[0].start.toFixed(1)}-${batch[batch.length - 1].end.toFixed(1)}s, ` +
        `${totalSec.toFixed(0)}s of audio]: ${basename(mediaPath)}`
      );
      try {
        await extractConcatAudio(mediaPath, batch, spacerSec, tmpWav, (outSec) => {
          // out time includes spacers; scale it back to island-audio seconds
          extractedSec.set(idx, Math.min(batchAudio, (outSec / Math.max(totalSec, 0.001)) * batchAudio));
          report();
        });
      } catch (e) {
        // Concat filter failed (odd media/old ffmpeg): fall back to per-island extraction
        // for this batch. Scribe/quota errors below are NOT retried per-island: the audio
        // isn't the problem there, and retrying would re-bill.
        log(`concat extract failed (${e.message.slice(0, 200)}); falling back to per-range transcription`);
        extractedSec.delete(idx);
        for (const isl of batch) await transcribeOne(isl);
        return;
      }
      log(`transcribing via Scribe (${batch.length} ranges, one call): ${basename(mediaPath)}`);
      const payload = await callScribe(tmpWav, apiKey, scribeOpts);
      recordBilled(totalSec);
      commit(batch, remapConcatWords(payload.words || [], layout));
    } finally {
      try { rmSync(tmpWav, { force: true }); } catch { /* ignore */ }
    }
  };

  // Run batches through a small concurrent pool: ElevenLabs transcribes them in parallel,
  // so wall clock is roughly the slowest part instead of the sum. On the first error no
  // NEW batch starts (in-flight ones settle); completed batches are already committed to
  // the cache, so a retry after quota reset only pays for what's still missing.
  if (batches.length) {
    report(true);
    let nextIdx = 0;
    let firstErr = null;
    const worker = async () => {
      while (!firstErr) {
        const idx = nextIdx++;
        if (idx >= batches.length) return;
        try {
          await processBatch(batches[idx], idx);
        } catch (e) {
          if (!firstErr) firstErr = e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    if (firstErr) throw firstErr;
    onProgress(`Transcription done (${batches.length} part(s), ${Math.round(totalAudio)}s of audio).`);
  }
  log(`ranged transcript saved: ${basename(rangedPath)} (${words.length} words, ${islands.length} island(s))`);
  return { payload: { words }, cached: false, path: rangedPath };
}
