// Derive editable segments from a Scribe word list. Mirrors the proven logic
// in video-use/helpers/pack_transcripts.py (phrase grouping) and adds silence
// + filler detection and a padded/merged cut-list computer.
//
// Scribe `words` entries have type "word", "spacing", or "audio_event".
// Times are seconds relative to the SOURCE media start.

export const DEFAULT_FILLERS = [
  "um", "umm", "umh", "uh", "uhh", "uhm", "er", "err", "erm",
  "ah", "ahh", "hmm", "hm", "mm", "mmm", "mhm", "uh-huh", "huh",
];

function normalizeToken(text) {
  return String(text || "").toLowerCase().replace(/[^a-z'-]/g, "");
}

export function isFiller(text, fillerSet) {
  return fillerSet.has(normalizeToken(text));
}

// Keep only spoken content (drop "spacing"); keep audio events as tokens.
function contentTokens(words) {
  const out = [];
  for (const w of words) {
    const type = w.type || "word";
    if (type === "spacing") continue;
    if (w.start == null) continue;
    out.push({
      type,
      text: w.text || "",
      start: w.start,
      end: w.end != null ? w.end : w.start,
      speaker: w.speaker_id != null ? String(w.speaker_id) : null,
    });
  }
  return out;
}

/**
 * Group content tokens into phrases, breaking on a silence >= silenceThreshold
 * OR a speaker change. Returns [{ start, end, text, speaker }].
 */
export function groupIntoPhrases(words, silenceThreshold = 0.5) {
  const toks = contentTokens(words);
  const phrases = [];
  let cur = [];
  let curStart = null;
  let curSpeaker = null;
  let prevEnd = null;

  const flush = () => {
    if (!cur.length) return;
    const parts = [];
    let wordCount = 0; // type==="word" tokens only — audio events (pops/breaths) don't count
    for (const t of cur) {
      let raw = (t.text || "").trim();
      if (!raw) continue;
      if (t.type === "audio_event") {
        if (!raw.startsWith("(")) raw = `(${raw})`;
      } else {
        wordCount += 1;
      }
      parts.push(raw);
    }
    if (parts.length) {
      let text = parts.join(" ")
        .replace(/ ,/g, ",").replace(/ \./g, ".").replace(/ \?/g, "?").replace(/ !/g, "!");
      phrases.push({ start: curStart, end: cur[cur.length - 1].end, text, speaker: curSpeaker, wordCount });
    }
    cur = [];
    curStart = null;
    curSpeaker = null;
  };

  for (const t of toks) {
    if (curSpeaker != null && t.speaker != null && t.speaker !== curSpeaker) flush();
    if (prevEnd != null && t.start - prevEnd >= silenceThreshold) flush();
    if (curStart == null) {
      curStart = t.start;
      curSpeaker = t.speaker;
    }
    cur.push(t);
    prevEnd = t.end;
  }
  flush();
  return phrases;
}

/**
 * Words whose midpoint falls inside a source-media window [inSec, outSec] — i.e.
 * the words actually audible within ONE timeline clip's source range. Using the
 * midpoint assigns every word to exactly one clip, so phrases built from a slice
 * never straddle a cut. Keeps the original Scribe entry shape (type/start/end/…).
 */
export function sliceWordsToWindow(words, inSec, outSec) {
  const out = [];
  for (const w of words || []) {
    if (w.start == null) continue;
    const end = w.end != null ? w.end : w.start;
    const mid = (w.start + end) / 2;
    if (mid >= inSec && mid <= outSec) out.push(w);
  }
  return out;
}

/**
 * Silent gaps between consecutive content tokens, in source seconds.
 * Returns [{ start, end, duration }].
 */
export function detectSilences(words, minSilenceSec = 0.4) {
  const toks = contentTokens(words);
  const gaps = [];
  for (let i = 0; i < toks.length - 1; i++) {
    const gapStart = toks[i].end;
    const gapEnd = toks[i + 1].start;
    const dur = gapEnd - gapStart;
    if (dur >= minSilenceSec) gaps.push({ start: gapStart, end: gapEnd, duration: dur });
  }
  return gaps;
}

/**
 * Filler tokens, in source seconds. Returns [{ start, end, text }].
 */
export function detectFillers(words, { fillers = DEFAULT_FILLERS } = {}) {
  const set = new Set(fillers.map(normalizeToken));
  const toks = contentTokens(words);
  const out = [];
  for (const t of toks) {
    if (t.type === "audio_event") continue;
    if (isFiller(t.text, set)) out.push({ start: t.start, end: t.end, text: t.text.trim() });
  }
  return out;
}

function mergeRanges(ranges, joinGapSec = 0.05) {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= joinGapSec) {
      last.end = Math.max(last.end, r.end);
      if (r.reason && last.reason && !last.reason.includes(r.reason)) last.reason += `+${r.reason}`;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Compute "remove" ranges in SOURCE seconds from a transcript.
 *  - silences: remove the middle of each long gap, leaving `padSec` of air on
 *    each side so cuts aren't jarring and word onsets/tails aren't clipped.
 *  - fillers: remove each filler token, padded by `padSec`.
 * Ranges are merged when they touch. Caller maps these to the timeline.
 */
export function computeCuts(words, opts = {}) {
  const {
    removeSilences = true,
    removeFillers = true,
    minSilenceSec = 0.4,
    padSec = 0.08,
    fillers = DEFAULT_FILLERS,
  } = opts;

  const cuts = [];

  if (removeSilences) {
    for (const g of detectSilences(words, minSilenceSec)) {
      const start = g.start + padSec;
      const end = g.end - padSec;
      if (end - start > 0.01) cuts.push({ start, end, reason: "silence" });
    }
  }

  if (removeFillers) {
    for (const f of detectFillers(words, { fillers })) {
      const start = Math.max(0, f.start - padSec);
      const end = f.end + padSec;
      if (end - start > 0.01) cuts.push({ start, end, reason: "filler", text: f.text });
    }
  }

  return mergeRanges(cuts);
}

/**
 * Compact, token-cheap segment summary for returning to the agent. Phrases get
 * source ranges here; the tool adds timeline timecodes per clip.
 */
export function buildSegmentSummary(words, opts = {}) {
  const phrases = groupIntoPhrases(words, opts.silenceThreshold ?? 0.5);
  const silences = detectSilences(words, opts.minSilenceSec ?? 0.4);
  const fillers = detectFillers(words, { fillers: opts.fillers ?? DEFAULT_FILLERS });
  return { phrases, silences, fillers };
}
