/**
 * Word-timed lip sync. We have no phoneme data, only the transcript's word
 * timings, so this does what 16-bit games did: pick ONE mouth shape per
 * syllable from the vowel it contains, and land each word exactly on its
 * onset. The rhythm is what sells it; the vowel is a bonus.
 *
 * Pure. `planSpeech` precomputes a sorted list of viseme segments once; the
 * per-frame lookups are a binary search.
 */
import type { Viseme } from "./sprite";

export type Word = { text: string; start: number; end?: number | null };

export type Segment = { from: number; to: number; viseme: Viseme };

export type SpeechPlan = {
  segments: Segment[];
  /** Word onsets in seconds (for head bobs). */
  onsets: number[];
  /** Onsets of words that end a question ("?"), for a brow raise. */
  questionOnsets: number[];
  /** [start, end] of every word, for `isSpeaking`. */
  spans: Array<[number, number]>;
};

/** Seconds per syllable when a word has no `end` (a comfortable speaking rate). */
const SYLLABLE_SEC = 0.17;
const WORD_MIN_SEC = 0.09;
/** A gap this long or longer between words closes the mouth. */
const REST_GAP_SEC = 0.1;
/** Lead-in consonant closure (m/b/p -> mm, f/v -> fv) at a syllable start. */
const CONSONANT_SEC = 0.055;

const VOWEL_GROUP = /[aeiouy]+/g;

/**
 * Split a word into syllable chunks (consonants attach to the vowel group that
 * follows them, trailing consonants to the last group). English heuristics:
 * silent final "e", "-ed" after a non-t/d consonant, "y" as a vowel only after
 * a consonant. Digits are one syllable each. Never returns an empty list.
 */
export function syllables(text: string): string[] {
  const raw = String(text || "").toLowerCase();
  const digits = raw.replace(/[^0-9]/g, "");
  let w = raw.replace(/[^a-z]/g, "");
  if (!w) return digits ? digits.split("") : ["a"];
  // leading y is a consonant ("yes"): protect it from the vowel scan
  const leadY = w.startsWith("y");
  const scan = leadY ? "q" + w.slice(1) : w;
  const groups: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  VOWEL_GROUP.lastIndex = 0;
  while ((m = VOWEL_GROUP.exec(scan))) groups.push({ start: m.index, end: m.index + m[0].length });
  if (!groups.length) return [w];
  // silent final e: "make", "time", but not "the", "be", and not "-le" ("table")
  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    const tail = w.slice(last.start);
    if (tail === "e" && !w.endsWith("le")) groups.pop();
    else if (/^ed$/.test(tail) && !/[td]ed$/.test(w)) groups.pop();
    else if (/^es$/.test(tail) && !/[sxz]es$|[cs]hes$/.test(w)) groups.pop();
  }
  const out: string[] = [];
  let cursor = 0;
  groups.forEach((g, i) => {
    const end = i === groups.length - 1 ? w.length : groups[i + 1].start;
    out.push(w.slice(cursor, end));
    cursor = end;
  });
  return out;
}

/** The vowel viseme for one syllable chunk. */
export function visemeForSyllable(syl: string): Viseme {
  const s = syl.toLowerCase();
  const v = (s.match(/[aeiouy]+/) || [""])[0];
  if (!v) return /[0-9]/.test(s) ? "ah" : "mm";
  if (/oo|ou|ew|u/.test(v)) return "oo";
  if (/ow|au|aw|oi|oy|o/.test(v)) return "oh";
  if (/^a(?![iy])/.test(v) || /a$/.test(v)) return "ah";
  return "ee";
}

/** The lead-in closure a syllable's first consonant asks for, if any. */
function leadConsonant(syl: string): Viseme | null {
  const c = syl[0];
  if (c === "m" || c === "b" || c === "p") return "mm";
  if (c === "f" || c === "v") return "fv";
  if (c === "w") return "oo";
  return null;
}

/** Whether a word ends on a lip closure (the mouth shuts on the last frames). */
function endsClosed(text: string): boolean {
  return /[mbp]$/.test(text.toLowerCase().replace(/[^a-z]/g, ""));
}

/** Build the segment plan for a word list (relative seconds, sorted or not). */
export function planSpeech(words: Word[]): SpeechPlan {
  const list = (words || [])
    .filter((w) => w && typeof w.start === "number" && String(w.text || "").trim())
    .slice()
    .sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  const onsets: number[] = [];
  const questionOnsets: number[] = [];
  const spans: Array<[number, number]> = [];

  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    const next = list[i + 1];
    const syls = syllables(w.text);
    const est = Math.max(WORD_MIN_SEC, SYLLABLE_SEC * syls.length);
    let end = typeof w.end === "number" && w.end! > w.start ? w.end! : w.start + est;
    if (next) end = Math.min(end, next.start);
    if (end - w.start < 0.03) continue;

    onsets.push(w.start);
    if (/\?$/.test(String(w.text).trim())) questionOnsets.push(w.start);
    spans.push([w.start, end]);

    const per = (end - w.start) / syls.length;
    let t = w.start;
    syls.forEach((syl, si) => {
      const sylEnd = si === syls.length - 1 ? end : t + per;
      const lead = leadConsonant(syl);
      let vStart = t;
      if (lead && per >= CONSONANT_SEC * 2.2) {
        segments.push({ from: t, to: t + CONSONANT_SEC, viseme: lead });
        vStart = t + CONSONANT_SEC;
      }
      let vEnd = sylEnd;
      if (si === syls.length - 1 && endsClosed(w.text) && sylEnd - vStart >= CONSONANT_SEC * 2.2) {
        vEnd = sylEnd - CONSONANT_SEC;
        segments.push({ from: vStart, to: vEnd, viseme: visemeForSyllable(syl) });
        segments.push({ from: vEnd, to: sylEnd, viseme: "mm" });
      } else {
        segments.push({ from: vStart, to: vEnd, viseme: visemeForSyllable(syl) });
      }
      t = sylEnd;
    });

    // Back-to-back words flow into each other; a real pause closes the mouth.
    if (next && next.start - end > 0 && next.start - end < REST_GAP_SEC) {
      const last = segments[segments.length - 1];
      last.to = next.start;
    }
  }
  return { segments, onsets, questionOnsets, spans };
}

function findSegment(segments: Segment[], t: number): Segment | null {
  let lo = 0, hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (t < s.from) hi = mid - 1;
    else if (t >= s.to) lo = mid + 1;
    else return s;
  }
  return null;
}

/** The mouth shape at time t (seconds, relative to the animation start). */
export function visemeAt(plan: SpeechPlan, t: number): Viseme {
  return findSegment(plan.segments, t)?.viseme ?? "rest";
}

/** True while a word is being spoken. */
export function isSpeaking(plan: SpeechPlan, t: number): boolean {
  return findSegment(plan.segments, t) != null;
}

/** How open the mouth is for a viseme, 0..1 (drives the talking head-bob). */
export function openness(v: Viseme): number {
  switch (v) {
    case "ah": case "laugh": return 1;
    case "oh": case "grin": return 0.7;
    case "ee": case "oo": return 0.5;
    case "fv": return 0.3;
    case "smile": return 0.2;
    case "mm": return 0.1;
    default: return 0;
  }
}

/** Seconds since the most recent word onset (Infinity before the first). */
export function sinceOnset(plan: SpeechPlan, t: number): number {
  const o = plan.onsets;
  let lo = 0, hi = o.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (o[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best < 0 ? Infinity : t - o[best];
}

/** True while the word that ends a question is being spoken (plus a short hold). */
export function inQuestion(plan: SpeechPlan, t: number, holdSec = 0.6): boolean {
  return plan.questionOnsets.some((q) => t >= q - 0.3 && t <= q + holdSec);
}
