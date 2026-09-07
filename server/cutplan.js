// Cut planning for the Retakes apply: turn Keep/Cut marks (plus the optional
// "Remove pauses" and "Remove fillers" trims) into SOURCE-second spans whose
// edges are placed INSIDE the quiet between words, then map those spans onto
// the live timeline.
//
// Why edges are refined and never taken straight from the transcript: on a
// real recording (measured 2026-09-07, scribe_v2) a word's START timestamp
// sits a median 48 ms AFTER the loudness onset (90th percentile 242 ms) and a
// word's END sits a median 178 ms BEFORE the voice actually stops. Cutting at
// the raw timestamp of a kept segment's first word therefore clips its first
// letters, which is exactly the "cuts through words" symptom. So a cut edge
// is chosen like this:
//   1. the transcript gives the NEIGHBOURHOOD: the gap between the last word
//      on one side and the first word on the other;
//   2. the loudness envelope (audio/levels.js, the same data the Remove
//      Silences tab scans) finds the actual quiet stretch inside that gap,
//      tolerating short blips (a click, a lip smack);
//   3. the kept side receives its margin of air (marginBefore ahead of an
//      onset, marginAfter behind a word end); the removed side gives it up.
//   4. no quiet at all (continuous speech, a sentence boundary with no pause)
//      falls back to the lowest-energy window between the words; no envelope
//      at all (ffmpeg missing) falls back to conservative timestamp pads.
// Everything here is pure (unit-tested in test/cutplan.js); review.js
// applyReview wires it to the live timeline.
import { isFiller, DEFAULT_FILLERS } from "./transcription/segments.js";
import { sourceRangeToTimelineFrames } from "./transcription/timecode.js";
import { estimateThreshold } from "./audio/silence.js";

// Air kept on the kept side of a cut edge (mirrors the Remove Silences defaults).
export const DEFAULT_MARGIN_BEFORE_SEC = 0.12;
export const DEFAULT_MARGIN_AFTER_SEC = 0.12;
// "Remove pauses": a stretch of no speech longer than this (real, envelope-
// measured) inside the kept speech shrinks to the two margins. User-set in the panel.
export const DEFAULT_PAUSE_MIN_SEC = 0.25;
// Timestamp-only pads when no envelope is available: sized to cover the 90th
// percentile of Scribe's onset lateness (0.24 s) and end earliness (0.33 s).
export const FALLBACK_LEAD_SEC = 0.25;
export const FALLBACK_TAIL_SEC = 0.3;
// A loud island this short inside a gap is a blip (click, breath tick), not speech.
const BLIP_SEC = 0.06;
// How far a quiet stretch may be extended past the transcript's gap while the
// envelope stays quiet (Scribe's word ends are early, so the real gap starts sooner).
const EXTEND_SEC = 0.5;
const EPS = 1e-3;

/** Normalize a media path for cross-platform comparison (mirrors premiere.jsx samePath). */
export function normPath(p) {
  return String(p == null ? "" : p).replace(/\\/g, "/").toLowerCase();
}

/**
 * Wrap a levels envelope ({db, hopSec}) with the threshold that separates
 * speech from quiet. thresholdDb defaults to the speech-anchored estimate the
 * Remove Silences tab suggests for the same file.
 */
export function makeEnv(envelope, thresholdDb) {
  if (!envelope || !Array.isArray(envelope.db) || !(envelope.hopSec > 0)) return null;
  const th = Number.isFinite(thresholdDb) ? thresholdDb : estimateThreshold(envelope.db);
  return { db: envelope.db, hopSec: envelope.hopSec, thresholdDb: th };
}

/**
 * The longest quiet stretch inside [a, b] (source seconds), where loud islands
 * no longer than blipSec are ignored, extended outward past a and b while the
 * envelope stays quiet (capped). Returns { q0, q1 } or null when nothing in the
 * window is quiet.
 */
export function quietStretch(env, a, b, opts = {}) {
  if (!env) return null;
  const { db, hopSec, thresholdDb } = env;
  const n = db.length;
  const blipSec = opts.blipSec != null ? opts.blipSec : BLIP_SEC;
  const extendSec = opts.extendSec != null ? opts.extendSec : EXTEND_SEC;
  const i0 = Math.max(0, Math.floor(a / hopSec));
  const i1 = Math.min(n, Math.ceil(b / hopSec));
  if (i1 <= i0) return null;
  const blipWin = Math.max(1, Math.round(blipSec / hopSec));
  const quiet = (k) => db[k] < thresholdDb;

  let best = null;
  let k = i0;
  while (k < i1) {
    if (!quiet(k)) { k++; continue; }
    let j = k;
    while (j < i1) {
      if (quiet(j)) { j++; continue; }
      let m = j;
      while (m < i1 && !quiet(m)) m++;
      if (m - j <= blipWin && m < i1) { j = m; continue; } // a blip inside the gap: keep going
      break;
    }
    if (!best || j - k > best[1] - best[0]) best = [k, j];
    k = j + 1;
  }
  if (!best) return null;
  const cap = Math.round(extendSec / hopSec);
  let s = best[0];
  let e = best[1];
  let s2 = s;
  while (s2 > 0 && s - s2 < cap && quiet(s2 - 1)) s2--;
  let e2 = e;
  while (e2 < n && e2 - e < cap && quiet(e2)) e2++;
  return { q0: s2 * hopSec, q1: e2 * hopSec };
}

/** Centre of the quietest window in [a, b] (the best cut point in continuous speech). */
export function minLevelPoint(env, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (!env) return (lo + hi) / 2;
  const { db, hopSec } = env;
  const i0 = Math.max(0, Math.floor(lo / hopSec));
  const i1 = Math.min(db.length, Math.ceil(hi / hopSec));
  if (i1 <= i0) return (lo + hi) / 2;
  let bi = i0;
  for (let k = i0; k < i1; k++) if (db[k] < db[bi]) bi = k;
  return Math.min(hi, Math.max(lo, (bi + 0.5) * hopSec));
}

/**
 * Where a KEPT span should START: its first word starts at wordStart, the last
 * sound before it (on the removed side) ends at prevEnd. Returns the cut time:
 * marginBefore of air ahead of the real onset when the gap has quiet, else the
 * quietest point between the words.
 */
export function headCut(env, prevEnd, wordStart, marginBefore = DEFAULT_MARGIN_BEFORE_SEC) {
  if (!(wordStart > prevEnd + EPS)) return minLevelPoint(env, Math.min(prevEnd, wordStart) - 0.03, Math.max(prevEnd, wordStart) + 0.03);
  if (!env) return Math.max(prevEnd, wordStart - FALLBACK_LEAD_SEC);
  const q = quietStretch(env, prevEnd, wordStart);
  if (!q) return minLevelPoint(env, prevEnd, wordStart);
  return Math.max(q.q0, q.q1 - marginBefore);
}

/**
 * Where a KEPT span should END: its last word ends at wordEnd, the next sound
 * after it (on the removed side) starts at nextStart. Returns the cut time:
 * marginAfter of air behind the real word end when the gap has quiet, else the
 * quietest point between the words.
 */
export function tailCut(env, wordEnd, nextStart, marginAfter = DEFAULT_MARGIN_AFTER_SEC) {
  if (!(nextStart > wordEnd + EPS)) return minLevelPoint(env, Math.min(wordEnd, nextStart) - 0.03, Math.max(wordEnd, nextStart) + 0.03);
  if (!env) return Math.min(nextStart, wordEnd + FALLBACK_TAIL_SEC);
  const q = quietStretch(env, wordEnd, nextStart);
  if (!q) return minLevelPoint(env, wordEnd, nextStart);
  return Math.min(q.q1, q.q0 + marginAfter);
}

/**
 * Sounds the transcript did not hear: loud stretches of the envelope inside
 * [a, b] that are at least minSec long and sit at least tolSec away from every
 * transcript token (word or audio event). Throat clears, coughs, chair creaks
 * and lip smacks between sentences show up here (Scribe marks only a few of
 * them as events); a word Scribe dropped mid-sentence does not, because it is
 * within tolSec of its neighbours. Returns [{ start, end }] in source seconds.
 */
export function findUnrecognizedSounds(env, tokens, a, b, opts = {}) {
  if (!env) return [];
  const minSec = opts.minSec != null ? opts.minSec : 0.25;
  const tolSec = opts.tolSec != null ? opts.tolSec : 0.2;
  const joinSec = opts.joinSec != null ? opts.joinSec : 0.1;
  const { db, hopSec, thresholdDb } = env;
  const i0 = Math.max(0, Math.floor(a / hopSec));
  const i1 = Math.min(db.length, Math.ceil(b / hopSec));
  const runs = [];
  for (let k = i0; k < i1; ) {
    if (db[k] < thresholdDb) { k++; continue; }
    let j = k;
    while (j < i1 && db[j] >= thresholdDb) j++;
    const start = k * hopSec;
    const end = j * hopSec;
    const last = runs[runs.length - 1];
    if (last && start - last.end < joinSec) last.end = end;
    else runs.push({ start, end });
    k = j;
  }
  const toks = (tokens || []).filter((w) => w.start != null && (w.type || "word") !== "spacing");
  return runs.filter((r) => {
    if (r.end - r.start < minSec) return false;
    return !toks.some((w) => (w.end != null ? w.end : w.start) > r.start - tolSec && w.start < r.end + tolSec);
  });
}

const segKey = (s) => `${normPath(s.mediaPath)}|${s.trackType}|${s.trackIndex}`;
const isCut = (s) => s.decision === "cut" && !s.protected;
const hasSpeech = (s) => s.sourceSpeechInSec != null && s.sourceSpeechOutSec != null;

// Content tokens (words + audio events) of one media whose midpoint lies in [a, b].
function tokensIn(words, a, b) {
  const out = [];
  for (const w of words || []) {
    if (w.start == null || (w.type || "word") === "spacing") continue;
    const end = w.end != null ? w.end : w.start;
    const mid = (w.start + end) / 2;
    if (mid >= a && mid <= b) out.push({ type: w.type || "word", text: w.text || "", start: w.start, end });
  }
  out.sort((x, y) => x.start - y.start);
  return out;
}

/** Filler words inside one segment's tile: { count, sec }. Used to annotate segments at load. */
export function fillerStats(words, seg, fillers = DEFAULT_FILLERS) {
  const set = new Set(fillers.map((f) => String(f).toLowerCase()));
  let count = 0;
  let sec = 0;
  for (const t of tokensIn(words, seg.sourceInSec, seg.sourceOutSec)) {
    if (t.type === "audio_event" || !isFiller(t.text, set)) continue;
    count += 1;
    sec += Math.max(0, t.end - t.start);
  }
  return { count, sec: Math.round(sec * 1000) / 1000 };
}

/**
 * Plan the spans to remove, in SOURCE seconds, grouped by media + track.
 * @param {Array} segments  review segments (tiles with decisions + speech extents)
 * @param {object} opts
 *   wordsByMedia   { normPath -> Scribe word list } (needed for fillers only)
 *   envelopes      { normPath -> env from makeEnv } (optional; refines edges)
 *   marginBeforeSec / marginAfterSec   air kept on the kept side of an edge
 *   trimPauses     also shrink every pause longer than pauseMinSec inside the
 *                  kept speech (between words, between sentences, clip edges)
 *   pauseMinSec    a real (envelope-measured) pause must exceed this to be cut
 *   removeFillers  also cut filler words inside kept segments
 *   fillers        filler word list (default DEFAULT_FILLERS)
 * @returns {Array<{mediaPath,trackType,trackIndex,start,end,kind,index}>}
 *   kind: "cut" (a marked segment), "pause", "filler"; merged when touching.
 */
export function planCutSpans(segments, opts = {}) {
  const mBefore = opts.marginBeforeSec != null ? opts.marginBeforeSec : DEFAULT_MARGIN_BEFORE_SEC;
  const mAfter = opts.marginAfterSec != null ? opts.marginAfterSec : DEFAULT_MARGIN_AFTER_SEC;
  const pauseMin = opts.pauseMinSec != null ? opts.pauseMinSec : DEFAULT_PAUSE_MIN_SEC;
  const wordsByMedia = opts.wordsByMedia || {};
  const envelopes = opts.envelopes || {};
  const fillerSet = new Set((opts.fillers || DEFAULT_FILLERS).map((f) => String(f).toLowerCase()));

  const groups = new Map();
  for (const s of segments || []) {
    if (s.mediaPath == null || s.sourceInSec == null || s.sourceOutSec == null) continue;
    const k = segKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }

  const spans = [];
  for (const [, list] of groups) {
    list.sort((a, b) => a.sourceInSec - b.sourceInSec || a.sourceOutSec - b.sourceOutSec);
    const media = normPath(list[0].mediaPath);
    const env = envelopes[media] || null;
    const words = wordsByMedia[media] || null;
    const push = (start, end, kind, index) => {
      if (end - start > 0.005) spans.push({ mediaPath: list[0].mediaPath, trackType: list[0].trackType, trackIndex: list[0].trackIndex, start, end, kind, index });
    };

    // Split into runs of source-contiguous tiles (one run = one continuous
    // stretch of footage on the timeline; a clip edge ends the run, so a tile
    // never borrows air from across a cut the silence pass already made).
    let runStart = 0;
    for (let i = 1; i <= list.length; i++) {
      if (i < list.length && list[i].sourceInSec - list[i - 1].sourceOutSec <= EPS) continue;
      const run = list.slice(runStart, i);
      runStart = i;
      planRun(run, { env, words, mBefore, mAfter, pauseMin, trimPauses: !!opts.trimPauses, removeFillers: !!opts.removeFillers, fillerSet, push });
    }
  }

  // Merge touching/overlapping spans per media+track (a filler at a kept
  // segment's head folds into the cut before it, a trailing pause into the cut after it).
  spans.sort((a, b) => segKey(a).localeCompare(segKey(b)) || a.start - b.start);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && segKey(last) === segKey(sp) && sp.start <= last.end + EPS) {
      last.end = Math.max(last.end, sp.end);
      if (sp.kind === "cut") last.kind = "cut"; // a marked cut owns the merged span
    } else {
      merged.push({ ...sp });
    }
  }
  return merged;
}

function planRun(run, o) {
  const { env, words, mBefore, mAfter, pauseMin, push } = o;
  const runIn = run[0].sourceInSec;
  const runOut = run[run.length - 1].sourceOutSec;

  // 1) Marked cuts: each maximal group of consecutive Cut tiles becomes one span
  //    whose edges sit in the quiet next to the neighbouring KEPT words.
  for (let i = 0; i < run.length; ) {
    if (!isCut(run[i])) { i++; continue; }
    let j = i;
    while (j + 1 < run.length && isCut(run[j + 1])) j++;
    const group = run.slice(i, j + 1);
    const L = i > 0 ? run[i - 1] : null;
    const R = j + 1 < run.length ? run[j + 1] : null;
    let gStart = null;
    let gEnd = null;
    for (const g of group) {
      if (!hasSpeech(g)) continue;
      if (gStart == null || g.sourceSpeechInSec < gStart) gStart = g.sourceSpeechInSec;
      if (gEnd == null || g.sourceSpeechOutSec > gEnd) gEnd = g.sourceSpeechOutSec;
    }
    let start = group[0].sourceInSec;
    let end = group[group.length - 1].sourceOutSec;
    // A protected neighbour is hands-off: its whole tile stays, edge included.
    if (L && !L.protected && hasSpeech(L)) {
      const nextSound = gStart != null ? gStart : R && hasSpeech(R) ? R.sourceSpeechInSec : end;
      start = clamp(tailCut(env, L.sourceSpeechOutSec, nextSound, mAfter), L.sourceSpeechOutSec, end);
    }
    if (R && !R.protected && hasSpeech(R)) {
      const prevSound = gEnd != null ? gEnd : L && hasSpeech(L) ? L.sourceSpeechOutSec : start;
      end = clamp(headCut(env, prevSound, R.sourceSpeechInSec, mBefore), start, R.sourceSpeechInSec);
    }
    push(start, end, "cut", group[0].index);
    i = j + 1;
  }

  // 2) "Remove pauses": every stretch of no speech longer than pauseMin that
  //    lies between two KEPT sounds (or between a clip edge and a kept sound)
  //    shrinks to the two margins. Pauses INSIDE a sentence count as much as
  //    pauses between sentences: the walk is over the run's tokens, not its
  //    tiles. A gap that touches a Cut tile belongs to step 1.
  if (o.trimPauses) {
    const toks = words ? tokensIn(words, runIn, runOut) : [];
    const owner = (t) => {
      const mid = (t.start + t.end) / 2;
      return run.find((s) => mid >= s.sourceInSec && mid <= s.sourceOutSec) || null;
    };
    // Without stored words (older reviews, unit fixtures) fall back to each tile's speech extent.
    const items = toks.length
      ? toks.map((t) => ({ start: t.start, end: t.end, seg: owner(t) }))
      : run.filter(hasSpeech).map((s) => ({ start: s.sourceSpeechInSec, end: s.sourceSpeechOutSec, seg: s }));
    const kept = (it) => !!it.seg && !isCut(it.seg) && !it.seg.protected;
    const bounds = [{ end: runIn, head: true }, ...items, { start: runOut, tail: true }];
    for (let i = 0; i < bounds.length - 1; i++) {
      const A = bounds[i];
      const B = bounds[i + 1];
      if (A.head && B.tail) continue;
      if (!(A.head ? kept(B) : kept(A)) || !(B.tail ? kept(A) : kept(B))) continue;
      const gapA = A.end;
      const gapB = B.start;
      if (!(gapB > gapA + EPS)) continue;
      let q0, q1;
      if (env) {
        const q = quietStretch(env, gapA, gapB);
        if (!q) continue; // no real pause here (continuous voice, a breath, noise)
        q0 = q.q0; q1 = q.q1;
      } else {
        q0 = A.head ? gapA : gapA + FALLBACK_TAIL_SEC;
        q1 = B.tail ? gapB : gapB - FALLBACK_LEAD_SEC;
      }
      // A clip edge has no speech on its side: the pause is measured from the edge.
      const p0 = A.head ? runIn : q0;
      const p1 = B.tail ? runOut : q1;
      if (p1 - p0 <= pauseMin) continue;
      const start = A.head ? runIn : q0 + mAfter;
      const end = B.tail ? runOut : q1 - mBefore;
      const seg = A.head ? B.seg : A.seg;
      if (end > start) push(start, end, "pause", seg ? seg.index : run[0].index);
    }
  }

  // 3) "Remove fillers": every filler word inside a kept, unprotected tile,
  //    consecutive fillers as one span, edges in the quiet next to the real words.
  if (o.removeFillers && words) {
    const toks = tokensIn(words, runIn, runOut);
    const owner = (t) => {
      const mid = (t.start + t.end) / 2;
      return run.find((s) => mid >= s.sourceInSec && mid <= s.sourceOutSec) || null;
    };
    const isFillerTok = (t) => t.type !== "audio_event" && isFiller(t.text, o.fillerSet);
    for (let i = 0; i < toks.length; ) {
      if (!isFillerTok(toks[i])) { i++; continue; }
      let j = i;
      while (j + 1 < toks.length && isFillerTok(toks[j + 1])) j++;
      const seg = owner(toks[i]);
      if (seg && !isCut(seg) && !seg.protected) {
        const prevEnd = i > 0 ? toks[i - 1].end : runIn;
        const nextStart = j + 1 < toks.length ? toks[j + 1].start : runOut;
        const a = i > 0 ? tailCut(env, prevEnd, toks[i].start, mAfter) : runIn;
        const b = j + 1 < toks.length ? headCut(env, toks[j].end, nextStart, mBefore) : runOut;
        push(clamp(a, runIn, toks[i].start), clamp(Math.max(b, toks[j].end), a, runOut), "filler", seg.index);
      }
      i = j + 1;
    }
  }
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Map source spans onto the LIVE timeline: a span lands wherever a live clip of
 * the same media + track carries that source range (so a span that straddles a
 * razor yields one range per piece, and footage no longer on the timeline
 * yields nothing). Returns [{ index, kind, startFrame, endFrame, sec }].
 */
export function mapSpansToTimeline(timeline, spans) {
  const seq = timeline.sequence;
  const byKey = new Map();
  for (const c of timeline.clips || []) {
    if (!c.hasMedia) continue;
    const k = segKey(c);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  const out = [];
  for (const sp of spans || []) {
    for (const c of byKey.get(segKey(sp)) || []) {
      const lo = Math.max(sp.start, c.sourceIn.seconds);
      const hi = Math.min(sp.end, c.sourceOut.seconds);
      if (hi - lo <= 0) continue;
      const r = sourceRangeToTimelineFrames(lo, hi, c, seq.timebase);
      if (!r || r.endFrame - r.startFrame < 1) continue;
      out.push({ index: sp.index, kind: sp.kind, startFrame: r.startFrame, endFrame: r.endFrame, sec: Math.round((r.endSeconds - r.startSeconds) * 1000) / 1000 });
    }
  }
  out.sort((a, b) => a.startFrame - b.startFrame);
  return out;
}
