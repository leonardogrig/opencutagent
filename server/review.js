// Shared "retake review" state + operations, used by BOTH the panel RPC and the
// MCP tools so they operate on the same segment list. The AI analysis itself is
// done by Claude (in the conversation, via MCP tools) — no external LLM.
import { getTimeline, round3, isAborted, fmtDur } from "./tools/util.js";
import { hasAudioStream } from "./audio/probe.js";
import { liveEnv } from "./config.js";
import { transcribeSourceRanges } from "./transcription/transcribe.js";
import { groupIntoCaptionChunks, sliceWordsToWindow, DEFAULT_FILLERS } from "./transcription/segments.js";
import { sourceRangeToTimelineFrames } from "./transcription/timecode.js";
import { getLevels } from "./audio/levels.js";
import { captureUndo } from "./undo.js";
import { applyRangesBatched, selectClips } from "./silences.js";
import { planCutSpans, mapSpansToTimeline, makeEnv, fillerStats, findUnrecognizedSounds, normPath, DEFAULT_MARGIN_BEFORE_SEC, DEFAULT_MARGIN_AFTER_SEC, DEFAULT_PAUSE_MIN_SEC } from "./cutplan.js";
import { log } from "./log.js";

// A clip is split into segments on an internal pause >= this (besides sentence
// ends and cut-off words): sub-clip false starts the silence pass didn't
// separate still get their own segment.
const PHRASE_GAP_SEC = 0.5;
// Segments shorter than this that DO contain speech are flagged (not auto-cut) —
// they may be a real short word ("Yes.") or a clipped false start.
const MIN_FRAGMENT_SEC = 0.5;
// Label of a segment carved out for a loud sound the transcript did not hear
// (throat clear, cough, noise). Word-empty, so it is auto-cut like a pop.
export const SOUND_TEXT = "(unrecognized sound)";

/**
 * Merge envelope-detected sounds into a clip's sentence phrases as word-empty
 * phrases of their own, in time order. Pure (unit-tested).
 */
export function addSoundPhrases(phrases, sounds) {
  if (!sounds || !sounds.length) return phrases;
  const all = phrases.concat(sounds.map((s) => ({ start: s.start, end: s.end, text: SOUND_TEXT, speaker: null, wordCount: 0, sound: true })));
  all.sort((x, y) => x.start - y.start);
  return all;
}

/**
 * Split one timeline clip into contiguous source-second segments that exactly
 * tile [sourceIn, sourceOut]: boundaries fall at phrase starts and the edges are
 * snapped to the clip, so cutting any subset never leaves a silent sliver. A
 * word-empty clip (pop/breath/noise the silence pass left behind) still yields
 * one cuttable segment covering the whole clip.
 */
export function partitionClip(clip, phrases) {
  const inS = clip.sourceIn.seconds;
  const outS = clip.sourceOut.seconds;
  if (!phrases.length) {
    return [{ start: inS, end: outS, text: "(no speech)", speaker: null, wordCount: 0, speechStart: null, speechEnd: null }];
  }
  const parts = [];
  for (let i = 0; i < phrases.length; i++) {
    const start = i === 0 ? inS : phrases[i].start;
    const end = i === phrases.length - 1 ? outS : phrases[i + 1].start;
    // Where the WORDS actually are inside the tile: segments tile the whole clip,
    // so a segment can hold minutes of dead air after its last word. The speech
    // extent (clamped to the tile; a word midpoint-sliced into the clip can end
    // past sourceOut) is what the pause trim measures from.
    parts.push({
      start,
      end,
      text: phrases[i].text,
      speaker: phrases[i].speaker,
      wordCount: phrases[i].wordCount || 0,
      speechStart: Math.max(start, phrases[i].start),
      speechEnd: Math.min(end, phrases[i].end),
    });
  }
  return parts;
}

/**
 * Tag and (optionally) pre-mark fragment segments:
 *  - "empty" (no recognized words — a pop/breath/noise): auto-marked Cut.
 *  - "short" (has speech but under MIN_FRAGMENT_SEC): flagged for review only.
 * Both are always reviewable; nothing is hard-deleted here.
 */
export function classifyFragments(segments, opts = {}) {
  const autoCutEmpty = opts.autoCutEmpty !== false; // default on
  const flagShort = opts.flagShort !== false; // default on
  const minFragSec = opts.minFragmentSec || MIN_FRAGMENT_SEC;
  let autoCut = 0;
  let flagged = 0;
  for (const s of segments) {
    if (s.wordCount === 0) {
      s.fragment = "empty";
      if (autoCutEmpty) {
        s.decision = "cut";
        s.reason = "no speech (pop / breath / noise)";
        autoCut += 1;
      }
    } else if (flagShort && s.durationSec < minFragSec) {
      s.fragment = "short";
      s.reason = s.reason || `very short (${fmtDur(s.durationSec)}), possible false start`;
      flagged += 1;
    }
  }
  return { autoCut, flagged };
}

/**
 * Transcribe the timeline into reviewable, indexed segments (all "keep" by
 * default) and store them on ctx.review. Shared by panel "Transcribe" and
 * the ppro_get_retake_segments tool.
 */
export async function buildReview(ctx, opts = {}, onProgress = () => {}) {
  onProgress("Reading the timeline…");
  const timeline = await getTimeline(ctx);
  const seq = timeline.sequence;

  // Same clip policy as the silence tab: video clips with media by default,
  // an explicit clip id, or one track (the Retakes track picker sends "A1"...).
  const clips = selectClips(timeline, opts.clipId, opts.track);
  if (clips.length === 0) throw new Error("No clips with source media on the timeline.");

  // Segmentation is SENTENCE-LEVEL, independent of how the silence pass shaped
  // the clips: one segment per sentence, pause (>= PHRASE_GAP_SEC) or cut-off
  // word, with a word cap for punctuation-less run-ons. A clip that repeats a
  // line several times with no pause between attempts still splits into its
  // attempts (sentence enders + cut-off dashes), so a retake is never hidden
  // inside one big "keep". The clip only bounds a segment (never crosses a cut);
  // where the CUT lands is decided at apply time (cutplan.js), not here.
  const maxWords = Math.max(4, Number(liveEnv("EDITAGENT_SEGMENT_WORDS")) || 24);

  const segments = [];
  const skipped = [];
  // Transcribe ONLY the source audio that's on the timeline: gather each source's used
  // clip windows first, so a source is sent to Scribe as its union of used ranges (merged
  // into a few islands) — never the whole file, never the off-timeline / silence-removed
  // parts. The result is still one source-time word list per source, sliced per clip below.
  const rangesByMedia = new Map();
  for (const clip of clips) {
    if (!clip.speedIsNormal) continue; // skipped below too; just don't request its audio
    if (!rangesByMedia.has(clip.mediaPath)) rangesByMedia.set(clip.mediaPath, []);
    rangesByMedia.get(clip.mediaPath).push({ start: clip.sourceIn.seconds, end: clip.sourceOut.seconds });
  }

  const wordsByMedia = new Map();
  const envByMedia = new Map();
  const soundThreshold = (() => {
    const raw = String(liveEnv("EDITAGENT_CUT_THRESHOLD_DB") || "").trim().toLowerCase();
    if (raw === "off" || raw === "0" || raw === "false") return null; // sounds off with the envelope
    return raw ? Number(raw) : NaN;
  })();
  for (const clip of clips) {
    if (isAborted(ctx)) throw new Error("Cancelled");
    if (!clip.speedIsNormal) {
      skipped.push({ clip: clip.id, reason: `non-100% speed (${clip.speed}x)` });
      continue;
    }
    // Silent video (graphics, placed animation renders on V2) has nothing to
    // transcribe and would kill the ffmpeg WAV extract with a cryptic error.
    if (!(await hasAudioStream(clip.mediaPath))) {
      skipped.push({ clip: clip.id, reason: "no audio stream (silent clip)" });
      continue;
    }
    if (!wordsByMedia.has(clip.mediaPath)) {
      onProgress(`Transcribing ${clip.mediaPath.split(/[\\\/]/).pop()}…`);
      const { payload } = await transcribeSourceRanges(clip.mediaPath, rangesByMedia.get(clip.mediaPath), { cacheDir: ctx.cacheDir, refresh: opts.refresh, model: opts.transcribeModel, cacheOnly: !!opts.cacheOnly, onProgress });
      wordsByMedia.set(clip.mediaPath, payload.words || []);
    }
    // Slice the source words to THIS clip's window, then phrase within the clip
    // so a segment never spans a cut the silence pass already made.
    const clipWords = sliceWordsToWindow(wordsByMedia.get(clip.mediaPath), clip.sourceIn.seconds, clip.sourceOut.seconds);
    let phrases = groupIntoCaptionChunks(clipWords, { maxWords, gapSec: PHRASE_GAP_SEC });
    // Sounds the transcript missed (throat clears, coughs, noise) come from the
    // loudness envelope and get segments of their own. Cached like the silence
    // scan; a silent resync (cacheOnly) never runs ffmpeg for it.
    if (soundThreshold !== null) {
      if (!envByMedia.has(clip.mediaPath)) {
        let env = null;
        try {
          onProgress(`Reading loudness: ${clip.mediaPath.split(/[\\\/]/).pop()}…`);
          const { envelope } = await getLevels(clip.mediaPath, { cacheDir: ctx.cacheDir, cacheOnly: !!opts.cacheOnly });
          env = makeEnv(envelope, soundThreshold);
        } catch (e) {
          log(`sounds: no loudness envelope for ${clip.mediaPath} (${e.message})`);
        }
        envByMedia.set(clip.mediaPath, env);
      }
      const env = envByMedia.get(clip.mediaPath);
      if (env) phrases = addSoundPhrases(phrases, findUnrecognizedSounds(env, clipWords, clip.sourceIn.seconds, clip.sourceOut.seconds));
    }
    for (const part of partitionClip(clip, phrases)) {
      const r = sourceRangeToTimelineFrames(part.start, part.end, clip, seq.timebase);
      if (!r || r.endFrame - r.startFrame < 1) continue;
      const fillers = fillerStats(clipWords, { sourceInSec: part.start, sourceOutSec: part.end }, DEFAULT_FILLERS);
      const pauses = transcriptPauses(clipWords, part.start, part.end, part.start <= clip.sourceIn.seconds + 1e-3);
      segments.push({
        clipId: clip.id,
        // Source range + track — STABLE identity used by reconcile() to find this
        // segment's footage on the live timeline after edits shift everything.
        // (clipId/itemIndex renumber after any razor, so never key on those.)
        mediaPath: clip.mediaPath,
        sourceInSec: round3(part.start),
        sourceOutSec: round3(part.end),
        // Speech extent inside the tile (source seconds) — null for no-speech
        // segments. Feeds the cut-edge planner on apply.
        sourceSpeechInSec: part.speechStart != null ? round3(part.speechStart) : null,
        sourceSpeechOutSec: part.speechEnd != null ? round3(part.speechEnd) : null,
        trackType: clip.trackType,
        trackIndex: clip.trackIndex,
        startFrame: r.startFrame,
        endFrame: r.endFrame,
        startSec: round3(r.startSeconds),
        endSec: round3(r.endSeconds),
        durationSec: round3(r.endSeconds - r.startSeconds),
        text: part.text,
        wordCount: part.wordCount,
        // Filler words (um, uh...) inside the tile: what "Remove fillers" would cut.
        fillerCount: fillers.count,
        fillerSec: fillers.sec,
        // Transcript gaps (seconds) inside the tile, for the panel's pause estimate.
        pauses,
        speaker: part.speaker != null ? `S${part.speaker}` : null,
        decision: "keep",
        protected: false,
        manual: false,
        fragment: null,
        reason: null,
        group: null,
      });
    }
  }
  segments.sort((a, b) => a.startFrame - b.startFrame || a.trackIndex - b.trackIndex);
  const deduped = dedupeStackedSegments(segments);
  if (!deduped.length && skipped.length) {
    throw new Error(
      `Nothing to transcribe: all ${skipped.length} clip(s) were skipped (${[...new Set(skipped.map((s) => s.reason))].join("; ")}).`
    );
  }
  deduped.forEach((s, i) => (s.index = i));
  const fragments = classifyFragments(deduped, opts);

  // Rebuilding after a timeline edit must not throw away the user's (or
  // Claude's) review: carry Keep/Cut/Protected marks onto the new tiling by
  // source-range overlap. Explicit fresh loads (Start Over) skip this.
  if (opts.carryMarks && ctx.review && Array.isArray(ctx.review.segments) && ctx.review.segments.length) {
    carryOverMarks(ctx.review.segments, deduped);
  }

  // Source-time words per media stay server-side (never pushed to the panel):
  // apply needs them to place filler cuts between the right words.
  const wordsOut = {};
  for (const [mediaPath, words] of wordsByMedia) wordsOut[normPath(mediaPath)] = words;
  ctx.review = { sequence: seq.name, frameRate: seq.frameRate, dropFrame: seq.dropFrame, segments: deduped, skipped, fragments, wordsByMedia: wordsOut, track: opts.track && opts.track !== "auto" ? String(opts.track).toUpperCase() : null };
  return ctx.review;
}

/**
 * Copy non-default review marks (Cut / Protected / manual / group / reason)
 * from an old segment list onto a freshly rebuilt one, matching by media +
 * track + source-range overlap (>= 50% of the new segment's span). Segments
 * left at their defaults carry nothing, so deterministic auto-cuts (no-speech)
 * on the new list are never un-done by a default old neighbor. Pure (unit-tested).
 * @returns {number} how many new segments received marks
 */
export function carryOverMarks(oldSegments, newSegments) {
  const marked = new Map(); // media|trackType|trackIndex -> [old segments with explicit marks]
  for (const o of oldSegments) {
    if (o.mediaPath == null || o.sourceInSec == null || o.sourceOutSec == null) continue;
    if (!(o.decision === "cut" || o.protected || o.manual || o.group != null)) continue;
    const k = `${normPath(o.mediaPath)}|${o.trackType}|${o.trackIndex}`;
    if (!marked.has(k)) marked.set(k, []);
    marked.get(k).push(o);
  }
  let carried = 0;
  for (const s of newSegments) {
    if (s.mediaPath == null || s.sourceInSec == null || s.sourceOutSec == null) continue;
    const span = s.sourceOutSec - s.sourceInSec;
    if (span <= 0) continue;
    const cands = marked.get(`${normPath(s.mediaPath)}|${s.trackType}|${s.trackIndex}`);
    if (!cands) continue;
    let best = null, bestOv = 0;
    for (const o of cands) {
      const ov = Math.min(s.sourceOutSec, o.sourceOutSec) - Math.max(s.sourceInSec, o.sourceInSec);
      if (ov > bestOv) { bestOv = ov; best = o; }
    }
    if (!best || bestOv < span * 0.5) continue;
    s.protected = !!best.protected;
    s.decision = best.protected ? "keep" : best.decision;
    s.manual = !!best.manual;
    if (best.group != null) s.group = best.group;
    if (best.reason) s.reason = best.reason;
    carried++;
  }
  return carried;
}

/**
 * Drop exact-duplicate tiles that come from the SAME footage stacked on two
 * video tracks (a common talking-head pattern: a scaled copy of the A-roll on
 * V2 for punch-ins). Without this every spoken line lists twice in the panel.
 * Only true duplicates collapse — same media, same source window, same timeline
 * frames; the copy on the LOWEST video track wins (input must be sorted by
 * startFrame then trackIndex, which buildReview does). Pure (unit-tested).
 */
export function dedupeStackedSegments(segments) {
  const seen = new Set();
  const out = [];
  for (const s of segments) {
    const key = s.mediaPath == null
      ? null
      : `${normPath(s.mediaPath)}|${s.startFrame}|${s.endFrame}|${Math.round((s.sourceInSec || 0) * 100)}|${Math.round((s.sourceOutSec || 0) * 100)}`;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Gaps of no transcript token inside one tile, in seconds: between consecutive
 * tokens, after the last token to the tile end, and (for a clip's first tile)
 * from the clip start to the first token. Only gaps >= 0.15 s, rounded. The
 * panel sums those above the user's pause setting for its "~Xs pauses" estimate.
 */
export function transcriptPauses(words, inSec, outSec, atClipHead = false) {
  const toks = [];
  for (const w of words || []) {
    if (w.start == null || (w.type || "word") === "spacing") continue;
    const end = w.end != null ? w.end : w.start;
    const mid = (w.start + end) / 2;
    if (mid >= inSec && mid <= outSec) toks.push({ start: w.start, end });
  }
  toks.sort((a, b) => a.start - b.start);
  const out = [];
  const add = (g) => { if (g >= 0.15) out.push(Math.round(g * 100) / 100); };
  if (!toks.length) { if (atClipHead) add(outSec - inSec); return out; }
  if (atClipHead) add(toks[0].start - inSec);
  for (let i = 1; i < toks.length; i++) add(toks[i].start - toks[i - 1].end);
  add(outSec - toks[toks.length - 1].end);
  return out;
}

export function requireReview(ctx) {
  if (!ctx.review || !ctx.review.segments || !ctx.review.segments.length) {
    throw new Error("No segments loaded yet. Run ppro_get_retake_segments (or click “Transcribe” in the panel) first.");
  }
  return ctx.review;
}

/**
 * Classify every review segment against the LIVE timeline and compute its CURRENT
 * timeline position — the foundation for playhead-sync highlighting and re-insert.
 *
 *  - "present"  source range fully covered by one live clip → highlightable.
 *  - "partial"  overlaps a live clip but isn't fully covered (a later cut sliced
 *               into it) → highlightable but NOT re-insertable (re-inserting would
 *               duplicate the part still on the timeline).
 *  - "absent"   no live clip covers it → it was removed → the only re-insertable state.
 *
 * Matching is by media path + track + source-range overlap (NOT clipId, which
 * renumbers after a razor); positions come from clip EDGES so they survive ripple
 * shifts. Pass a pre-fetched `timeline` to avoid a redundant host read.
 */
export async function reconcile(ctx, timeline = null) {
  const review = requireReview(ctx);
  if (!timeline) timeline = await getTimeline(ctx);
  const fps = (timeline.sequence && timeline.sequence.frameRate) || review.frameRate || 30;
  const eps = Math.max(1 / fps, 0.02);

  const liveByMedia = new Map();
  for (const c of timeline.clips) {
    if (!c.hasMedia) continue;
    const key = normPath(c.mediaPath);
    if (!liveByMedia.has(key)) liveByMedia.set(key, []);
    liveByMedia.get(key).push(c);
  }

  const map = review.segments.map((s) => {
    const out = { index: s.index, state: "absent", liveStartSec: null, liveEndSec: null };
    if (s.mediaPath == null || s.sourceInSec == null || s.sourceOutSec == null) return out; // pre-source-range segment
    const inS = s.sourceInSec, outS = s.sourceOutSec;
    const candidates = (liveByMedia.get(normPath(s.mediaPath)) || []).filter(
      (c) => c.trackType === s.trackType && c.trackIndex === s.trackIndex
    );
    let best = null;
    for (const c of candidates) {
      const cIn = c.sourceIn.seconds, cOut = c.sourceOut.seconds;
      const ov = Math.min(outS, cOut) - Math.max(inS, cIn);
      if (ov <= 0) continue;
      const contained = inS >= cIn - eps && outS <= cOut + eps;
      if (!best || ov > best.ov) best = { c, ov, contained };
    }
    if (best) {
      const c = best.c;
      const cIn = c.sourceIn.seconds, cOut = c.sourceOut.seconds;
      // Live span = the part of the segment's source range the clip still
      // carries. Both edges come from the overlap: clamping only the start and
      // adding the full original duration would make a head-trimmed segment
      // claim the next segment's footage (cut it, and the keeper after it gets
      // razored too).
      const s0 = Math.max(inS, cIn);
      const s1 = Math.min(outS, cOut);
      let liveStart = c.start.seconds + (s0 - cIn);
      liveStart = Math.max(c.start.seconds, Math.min(liveStart, c.end.seconds));
      const liveEnd = Math.max(liveStart, Math.min(liveStart + (s1 - s0), c.end.seconds));
      out.liveStartSec = round3(liveStart);
      out.liveEndSec = round3(liveEnd);
      out.state = best.contained ? "present" : "partial";
    }
    return out;
  });

  return { map, timeline, revision: ctx.state.revision, frameRate: round3(fps) };
}

/**
 * Choose the timeline time (seconds) to re-insert segment `index` at: right before
 * the next still-present segment (so it lands exactly where it was), else just
 * after the previous present one, else the very start. `map` is reconcile()'s
 * array. Pure (unit-tested in server/test/retakeSegments.js).
 */
export function reinsertTarget(segments, map, index) {
  const byIndex = new Map(map.map((m) => [m.index, m]));
  let prev = null;
  for (const s of segments) {
    const m = byIndex.get(s.index);
    if (!m || m.state === "absent") continue;
    if (s.index > index && m.liveStartSec != null) return m.liveStartSec; // next present → insert before it
    if (s.index < index && m.liveEndSec != null) prev = m.liveEndSec;     // remember the latest present before it
  }
  return prev != null ? prev : 0;
}

/** Push the current segments to the panel so it reflects the latest Keep/Cut marks. */
function pushToPanel(ctx) {
  try {
    ctx.bridge.notifyPanel({ type: "reviewUpdate", segments: ctx.review.segments });
  } catch {
    /* panel may be closed; ignore */
  }
}

/**
 * Apply Keep/Cut decisions to the in-memory segments and push to the panel.
 * decisions: [{ index, decision: "keep"|"cut", group?, reason? }].
 * Protected segments are never changed.
 */
export function markDecisions(ctx, decisions = []) {
  const review = requireReview(ctx);
  const byIndex = new Map();
  for (const d of decisions) if (Number.isInteger(d.index)) byIndex.set(d.index, d);
  let changed = 0;
  for (const s of review.segments) {
    const d = byIndex.get(s.index);
    if (!d || s.protected) continue;
    if (d.decision === "keep" || d.decision === "cut") {
      if (s.decision !== d.decision) changed++;
      s.decision = d.decision;
      s.manual = false; // came from analysis, not a manual override
      if (typeof d.reason === "string") s.reason = d.reason;
      if (Number.isInteger(d.group)) s.group = d.group;
    }
  }
  pushToPanel(ctx);
  return { ...summarize(review), changed };
}

/* ===================== Apply: cuts with edges placed in the quiet =====================
 * Segments TILE each clip (a tile's edge is the next sentence's first word), which is the
 * right shape for REVIEW but the wrong place to CUT: a word's timestamp sits inside the
 * word (see cutplan.js for the measurements), so cutting on a tile edge clips the first
 * letters of the kept sentence. Apply therefore plans its spans from the marks:
 *   - a run of Cut tiles becomes one span whose edges sit in the quiet next to the
 *     neighbouring kept words (marginBefore of air ahead of a kept onset, marginAfter
 *     behind a kept word end), found on the loudness envelope of the source file;
 *   - "Remove pauses" (trimPauses, pauseMinSec) also shrinks every real pause longer than
 *     the user's setting inside the kept speech, between words as much as between sentences;
 *   - "Remove fillers" (removeFillers) also cuts um/uh/... out of kept sentences.
 * Spans are mapped onto the LIVE timeline by media + track + source overlap right
 * before deleting (stored frames go stale after the first ripple). */

function marginSec(envKey, def) {
  const v = Number(liveEnv(envKey));
  return Number.isFinite(v) && v >= 0 ? v / 1000 : def;
}

/**
 * Loudness envelopes for the review's source files, wrapped with the speech
 * threshold (EDITAGENT_CUT_THRESHOLD_DB, else the speech-anchored estimate).
 * Cached per file like the Remove Silences scan; a file that cannot be scanned
 * (ffmpeg missing, media offline) simply gets timestamp-based edges.
 */
async function loadEnvelopes(ctx, review, onProgress) {
  const raw = String(liveEnv("EDITAGENT_CUT_THRESHOLD_DB") || "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return {};
  const thresholdDb = raw ? Number(raw) : NaN;
  const out = {};
  const paths = new Map();
  for (const s of review.segments) if (s.mediaPath != null && !paths.has(normPath(s.mediaPath))) paths.set(normPath(s.mediaPath), s.mediaPath);
  for (const [key, mediaPath] of paths) {
    try {
      onProgress(`Reading loudness: ${String(mediaPath).split(/[\\\/]/).pop()}…`);
      const { envelope } = await getLevels(mediaPath, { cacheDir: ctx.cacheDir });
      const env = makeEnv(envelope, thresholdDb);
      if (env) out[key] = env;
    } catch (e) {
      log(`cut edges: no loudness envelope for ${mediaPath} (${e.message}); using transcript timings`);
    }
  }
  return out;
}

/**
 * Ripple/lift-delete every Cut (non-protected) segment, plus the pause/filler trims when
 * asked, via the batched razor→lift→close path (applyRangesBatched in silences.js).
 * Spans are planned in source time (planCutSpans) and RECONCILED onto the live timeline
 * right before deleting; lift-deletes never shift anything, so all frames stay valid for
 * the whole batch and the single close pass runs last.
 */
export async function applyReview(ctx, { removeGaps = false, trimPauses = false, pauseMinSec, removeFillers = false, chunkSize } = {}, onProgress = () => {}) {
  const review = requireReview(ctx);
  const ripple = removeGaps === true;
  const { map, timeline } = await reconcile(ctx); // one host read; also the pre-apply snapshot
  const fps = (timeline.sequence && timeline.sequence.frameRate) || review.frameRate || 30;
  const byIndex = new Map(map.map((m) => [m.index, m]));

  // Count the Cut marks that are ALREADY gone from the live timeline separately —
  // "requested 0 because everything was removed earlier" must never read as
  // "apply did nothing" (a stale panel list makes that the #1 confusion).
  const marked = review.segments.filter((s) => s.decision === "cut" && !s.protected);
  let alreadyGone = 0;
  let alreadyGoneSec = 0;
  for (const s of marked) {
    const m = byIndex.get(s.index);
    if (!m || m.state === "absent" || m.liveStartSec == null || m.liveEndSec == null) {
      alreadyGone += 1;
      alreadyGoneSec += s.durationSec || 0;
    }
  }

  const envelopes = marked.length || trimPauses || removeFillers ? await loadEnvelopes(ctx, review, onProgress) : {};
  const envPause = Number(liveEnv("EDITAGENT_PAUSE_MS"));
  const spans = planCutSpans(review.segments, {
    wordsByMedia: review.wordsByMedia || {},
    envelopes,
    marginBeforeSec: marginSec("EDITAGENT_CUT_MARGIN_BEFORE_MS", DEFAULT_MARGIN_BEFORE_SEC),
    marginAfterSec: marginSec("EDITAGENT_CUT_MARGIN_AFTER_MS", DEFAULT_MARGIN_AFTER_SEC),
    trimPauses,
    pauseMinSec: Number.isFinite(pauseMinSec) && pauseMinSec >= 0 ? pauseMinSec : Number.isFinite(envPause) && envPause >= 0 ? envPause / 1000 : DEFAULT_PAUSE_MIN_SEC,
    removeFillers,
  });
  const frames = mapSpansToTimeline(timeline, spans);
  const pauseSpans = frames.filter((f) => f.kind === "pause").length;
  const fillerSpans = frames.filter((f) => f.kind === "filler").length;

  const res = await applyRangesBatched(ctx, frames, { ripple, fps, chunkSize, timeline, onProgress });
  const applied = res.applied;
  if (applied > 0) {
    ctx.state.revision += 1;
    // XML rebuild leaves the original sequence untouched — nothing to snapshot.
    if (timeline && !res.rebuild) captureUndo(ctx, "retake", timeline, { ripple, applied });
  }
  return {
    applied,
    appliedSec: res.appliedSec,
    ripple,
    aborted: res.aborted,
    rebuild: res.rebuild || undefined,
    sequenceName: res.sequenceName,
    undoable: applied > 0 && !!timeline && !res.rebuild,
    requested: res.requested,
    cutsMarked: marked.length,
    pauseSpans,
    fillerSpans,
    refined: Object.keys(envelopes).length > 0,
    alreadyGone,
    alreadyGoneSec: round3(alreadyGoneSec),
    errors: res.errors.length ? res.errors : undefined,
    revision: ctx.state.revision,
  };
}

export function summarize(review) {
  const cuts = review.segments.filter((s) => s.decision === "cut" && !s.protected);
  return {
    total: review.segments.length,
    cut: cuts.length,
    keep: review.segments.length - cuts.length,
    removedSeconds: round3(cuts.reduce((a, s) => a + (s.durationSec || 0), 0)),
  };
}

/* ===================== Soft Apply — timeline markers (non-destructive) =====================
 * Premiere's scripting API CANNOT recolor timeline clips (TrackItems) — a documented,
 * still-open limitation (Adobe DVAPR-4217788); projectItem.setColorLabel only colors the
 * bin item (one color per source, and all retakes share one source). So "Soft Apply"
 * annotates the LIVE timeline with colored SEQUENCE MARKERS instead of deleting: one hue
 * band over each retake group's duplicate takes + a GREEN band over the keeper, and RED
 * over no-speech. planEditMarkers is the pure planner (unit-tested in test/retakeSegments.js);
 * the host op applyEditMarkers (premiere.jsx) lays the markers; both carry a comment
 * sentinel so we only ever clear our OWN markers (never the user's). */

// Premiere's fixed marker color indices (0..6). Green=keeper and Red=no-speech are
// reserved; the rest cycle as group hues (White is least distinct, so it goes last).
export const MARKER_COLORS = { GREEN: 0, RED: 1, PURPLE: 2, ORANGE: 3, YELLOW: 4, WHITE: 5, BLUE: 6 };
const GROUP_HUES = [MARKER_COLORS.PURPLE, MARKER_COLORS.ORANGE, MARKER_COLORS.YELLOW, MARKER_COLORS.BLUE, MARKER_COLORS.WHITE];
export const EDIT_MARKER_SENTINEL = "OpenCutAgent"; // marker-comment prefix that identifies ours

// Marker name/comment cross into ExtendScript via evalScript; keep them ASCII so a
// transport-encoding quirk can never mangle them (transcript text can contain anything).
function asciiSnippet(t, max = 48) {
  const s = String(t == null ? "" : t)
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "..." : s;
}

// The keeper of a cut-run: scan forward past the run (skipping empties) to the first real
// segment — if it's kept, that's the keeper; else try the same scan backward.
function nearestKeep(cutIdxs, byIndex, isKeep, isEmpty, n) {
  const hi = cutIdxs[cutIdxs.length - 1], lo = cutIdxs[0];
  const scan = (start, step) => {
    for (let k = start, hops = 0; k >= 0 && k < n && hops < 5; k += step) {
      const s = byIndex.get(k);
      if (!s) return null;
      if (isEmpty(s)) { hops++; continue; }
      return isKeep(s) ? s : null; // first real segment in this direction decides it
    }
    return null;
  };
  return scan(hi + 1, 1) || scan(lo - 1, -1);
}

/**
 * Plan the Soft-Apply markers for a review against a live reconcile() map. Pure:
 * (segments, map, opts) -> { markers, stats }. Each marker is { startSec, endSec,
 * colorIndex, name, comment } in timeline seconds.
 *
 *  - consecutive no-speech (fragment "empty") segments -> one RED span per run;
 *  - each retake group (cuts sharing a `group` id; fallback: a contiguous run of cuts)
 *    -> one hue span over the duplicates + a GREEN span over the keeper;
 *  - clean standalone takes -> no marker;
 *  - segments removed from the live timeline ("absent") are skipped (can't mark gone footage).
 */
export function planEditMarkers(segments, map, opts = {}) {
  const sentinel = opts.sentinel || EDIT_MARKER_SENTINEL;
  const byMap = new Map((map || []).map((m) => [m.index, m]));
  const byIndex = new Map(segments.map((s) => [s.index, s]));
  const ordered = [...segments].sort((a, b) => a.index - b.index);

  const pos = (s) => {
    const m = byMap.get(s.index);
    if (!m || m.state === "absent" || m.liveStartSec == null || m.liveEndSec == null) return null;
    return { start: m.liveStartSec, end: m.liveEndSec };
  };
  const isEmpty = (s) => s.fragment === "empty";
  const isCut = (s) => s.decision === "cut" && !s.protected && !isEmpty(s);
  const isKeep = (s) => !isEmpty(s) && !isCut(s); // kept (incl. protected) non-empty

  const markers = [];

  // 1) no-speech: merge consecutive empties into one red span
  let noSpeech = 0;
  for (let i = 0; i < ordered.length; ) {
    if (!isEmpty(ordered[i])) { i++; continue; }
    let j = i, first = null, last = null, count = 0;
    for (; j < ordered.length && isEmpty(ordered[j]); j++) {
      const p = pos(ordered[j]);
      if (!p) continue;
      if (!first) first = p;
      last = p; count++;
    }
    if (first && last) {
      markers.push({
        startSec: first.start, endSec: last.end, colorIndex: MARKER_COLORS.RED,
        name: count > 1 ? `No speech x${count}` : "No speech",
        comment: `${sentinel} | no speech${count > 1 ? ` x${count}` : ""}`,
      });
      noSpeech++;
    }
    i = j;
  }

  // 2) bucket non-empty cuts into groups (by `group` id; fallback: a contiguous run).
  //    A grouped cut resets the synthetic run so a following ungrouped cut never merges in.
  const buckets = new Map();
  const order = [];
  let synth = 0, prevSynthKey = null;
  for (const s of ordered) {
    if (!isCut(s)) { prevSynthKey = null; continue; }
    let key;
    if (Number.isInteger(s.group)) { key = "g" + s.group; prevSynthKey = null; }
    else { key = prevSynthKey || ("s" + synth++); prevSynthKey = key; }
    if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
    buckets.get(key).push(s.index);
  }

  // 3) per group: hue span over the duplicates + green span over the keeper
  let groups = 0, keepers = 0, hueN = 0;
  for (const key of order) {
    const idxs = buckets.get(key).slice().sort((a, b) => a - b);
    let dupStart = null, dupEnd = null, dupCount = 0;
    for (const idx of idxs) {
      const p = pos(byIndex.get(idx));
      if (!p) continue;
      if (dupStart == null) dupStart = p.start;
      dupEnd = p.end; dupCount++;
    }
    if (dupStart == null) continue; // every duplicate already removed -> nothing to mark

    const hue = GROUP_HUES[hueN % GROUP_HUES.length];
    hueN++; groups++;
    markers.push({
      startSec: dupStart, endSec: dupEnd, colorIndex: hue,
      name: `Retake x${dupCount} - drop`,
      comment: `${sentinel} | ${key} | ${dupCount} dup take(s) | ${asciiSnippet(byIndex.get(idxs[0]).text)}`,
    });

    const keeper = nearestKeep(idxs, byIndex, isKeep, isEmpty, ordered.length);
    const kp = keeper ? pos(keeper) : null;
    if (kp) {
      keepers++;
      markers.push({
        startSec: kp.start, endSec: kp.end, colorIndex: MARKER_COLORS.GREEN,
        name: "Keep (final take)",
        comment: `${sentinel} | ${key} keeper | ${asciiSnippet(keeper.text)}`,
      });
    }
  }

  markers.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  return { markers, stats: { groups, keepers, noSpeech, created: markers.length } };
}

/* ===================== Transcript export (YouTube-ready SubRip / .srt) =====================
 * Export the FINAL kept speech as SubRip captions — the format YouTube's "Upload
 * subtitles/CC" accepts directly. Only "keep" segments that contain speech are emitted
 * (cuts and no-speech pops are dropped). When `compact` (the panel's ripple checkbox) is
 * set, the time occupied by still-present cuts is subtracted so the caption times line up
 * with the tightened video Apply All produces; cuts already removed from the live timeline
 * ("absent") aren't double-counted. Live reconcile positions are preferred (fresh after any
 * edit), falling back to the stored timeline seconds. Pure + unit-tested (test/retakeSegments.js). */

// seconds -> "HH:MM:SS,mmm" (SubRip uses a comma before the milliseconds).
export function srtTimestamp(sec) {
  const ms = Math.max(0, Math.round((sec || 0) * 1000));
  const p2 = (n) => (n < 10 ? "0" + n : "" + n);
  const p3 = (n) => (n < 10 ? "00" + n : n < 100 ? "0" + n : "" + n);
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  return `${p2(hh)}:${p2(mm)}:${p2(ss)},${p3(ms % 1000)}`;
}

// Greedy word-wrap a caption into <=maxLen-char lines (YouTube renders ~1-2 lines).
export function wrapCaption(text, maxLen = 42) {
  const words = String(text == null ? "" : text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "";
  const lines = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if ((line + " " + w).length <= maxLen) line += " " + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/**
 * Build ordered caption cues for the kept speech on the final timeline. Pure:
 * (segments, map, opts) -> [{ index, startSec, endSec, text }] sorted by time.
 *  - keeps only (a cut is decision "cut" && !protected); no-speech (fragment "empty" /
 *    wordCount 0 / blank text) dropped — nothing to caption;
 *  - opts.compact (ripple): subtract the running duration of still-present cuts so cue
 *    times match the tightened video; absent cuts (already applied) aren't double-counted;
 *  - positions come from the reconcile `map` (live) when the segment is on the timeline,
 *    else the stored startSec/endSec.
 */
export function buildTranscriptCues(segments, map, opts = {}) {
  const compact = !!opts.compact;
  const byMap = new Map((map || []).map((m) => [m.index, m]));
  const ordered = [...segments].sort((a, b) => (a.startSec || 0) - (b.startSec || 0) || a.index - b.index);
  const pos = (s) => {
    const m = byMap.get(s.index);
    if (m && m.state !== "absent" && m.liveStartSec != null && m.liveEndSec != null) {
      return { start: m.liveStartSec, end: m.liveEndSec, absent: false };
    }
    return { start: s.startSec, end: s.endSec, absent: !!(m && m.state === "absent") };
  };
  const isCut = (s) => s.decision === "cut" && !s.protected;
  const hasSpeech = (s) => s.fragment !== "empty" && s.wordCount > 0 && String(s.text == null ? "" : s.text).trim();

  const cues = [];
  let removed = 0; // cumulative duration of cuts that ripple will close before this point
  for (const s of ordered) {
    const p = pos(s);
    if (isCut(s)) {
      if (compact && !p.absent && p.start != null && p.end != null) removed += Math.max(0, p.end - p.start);
      continue; // cuts never get a caption
    }
    if (!hasSpeech(s) || p.start == null || p.end == null) continue; // kept pause/breath -> no caption
    let start = Math.max(0, p.start - removed);
    let end = Math.max(0, p.end - removed);
    if (!(end > start)) end = start + 0.1; // guarantee a positive, visible duration
    cues.push({ index: s.index, startSec: round3(start), endSec: round3(end), text: String(s.text).replace(/\s+/g, " ").trim() });
  }
  // Trim any 1ms rounding overlap so consecutive cues never collide (keeps
  // YouTube happy). When the minimum-duration bump would re-overlap the next
  // cue (two cues sharing a start), push the next cue's start too.
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].endSec > cues[i + 1].startSec) cues[i].endSec = cues[i + 1].startSec;
    if (!(cues[i].endSec > cues[i].startSec)) {
      cues[i].endSec = round3(cues[i].startSec + 0.1);
      if (cues[i + 1].startSec < cues[i].endSec) cues[i + 1].startSec = cues[i].endSec;
    }
  }
  return cues;
}

/** Serialize cues to a SubRip (.srt) document (1-based index, CR-free, single trailing NL). */
export function formatSrt(cues, opts = {}) {
  const wrap = opts.wrap !== false;
  const maxLen = opts.maxLineLen || 42;
  const out = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    out.push(String(i + 1));
    out.push(`${srtTimestamp(c.startSec)} --> ${srtTimestamp(c.endSec)}`);
    out.push(wrap ? wrapCaption(c.text, maxLen) : c.text);
    out.push(""); // blank separator line between cues
  }
  return out.join("\n").replace(/\n+$/, "") + (cues.length ? "\n" : "");
}
