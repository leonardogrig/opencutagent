// Canonical loudness-based silence detection — the single source of truth.
//
// Given a per-window dBFS loudness envelope (from audio/levels.js), classify
// each window as speech ("loud") or silence, then derive the ranges to remove
// from the user's controls. This is PURE (no I/O), fully unit-tested, and
// MIRRORED in the CEP panel (cep-panel/client/main.js → computeSilenceRanges)
// so the panel can recompute instantly as sliders move. Keep the two in sync;
// test/silence.js pins the behavior.
//
// Controls (mirrors the panel UI / the AutoCut-style reference):
//  - thresholdDb        Noise Threshold: windows below this are silence.
//  - minSilenceSec      "Remove Silences Longer Than": only cut silences >= this.
//  - keepTalkSec        "Keep speech longer than": speech islands shorter than this
//                       are treated as silence, unconditionally (so noise spikes
//                       and sub-keepTalk chatter bursts don't split — and thus
//                       preserve — a long silence).
//  - marginBeforeSec    "Margin before by": air kept BEFORE the next speech.
//  - marginAfterSec     "Margin after by": air kept AFTER the previous speech.
//
// Each kept silence run is shrunk by marginAfter at its head and marginBefore at
// its tail (those are the green "Margins" in the UI); whatever is left in the
// middle is the red "Silence" that gets removed. Leading/trailing silence (clip
// head/tail) has no neighbouring speech on one side, so that side keeps no margin.

export const SILENCE_FLOOR_DB = -100;

// The envelope (audio/levels.js) is peak-per-window CLAMPED to this floor —
// the same value as the panel's visible dB axis and the threshold slider
// minimum. Nothing in the envelope is ever below it, so threshold = −60
// means "detect nothing" (matching AutoCut/TimeBolt meter semantics).
export const ENVELOPE_FLOOR_DB = -60;

// Defaults mirror the reference panel; keepTalk 400ms sits in AutoCut's
// recommended 300–500ms band. Demotion is UNCONDITIONAL on length (exact
// AutoCut/TimeBolt semantics): every loud island shorter than keepTalk is
// treated as silence, no matter its surroundings. This is what merges a long
// stretch of low-level chatter (each burst < keepTalk) into ONE solid block —
// an isolation-guarded variant (only demote when flanked by clean silence) was
// tried on 2026-07-03 and REJECTED: in dense chatter the bursts protect each
// other and the block shreds into hundreds of slivers. The accepted trade-off
// (shared by AutoCut/TimeBolt) is that a genuinely meaningful sub-keepTalk
// word in the middle of dead air can be eaten — which is why values > ~750ms
// are not recommended.
export const DEFAULT_SETTINGS = Object.freeze({
  thresholdDb: -36,
  minSilenceMs: 120,
  keepTalkMs: 400,
  marginBeforeMs: 120,
  marginAfterMs: 120,
});

// Pacing presets tune aggressiveness (NOT the threshold — that's content-driven).
// Relaxed = leave generous pauses; Rapid = tighten almost everything. keepTalk
// scales with minSilence: long kept pauses are easily split (and thus
// preserved) by one stray blip, so gentler presets demote harder.
export const PRESETS = Object.freeze({
  Relaxed: { minSilenceMs: 1000, keepTalkMs: 700, marginBeforeMs: 200, marginAfterMs: 200 },
  Natural: { minSilenceMs: 700, keepTalkMs: 600, marginBeforeMs: 170, marginAfterMs: 170 },
  Balanced: { minSilenceMs: 500, keepTalkMs: 500, marginBeforeMs: 150, marginAfterMs: 150 },
  Brisk: { minSilenceMs: 300, keepTalkMs: 450, marginBeforeMs: 120, marginAfterMs: 120 },
  Rapid: { minSilenceMs: 120, keepTalkMs: 400, marginBeforeMs: 80, marginAfterMs: 80 },
});

function settingsToSec(s = {}) {
  const g = (key, def) => (s[key] != null ? s[key] : def);
  return {
    thresholdDb: g("thresholdDb", DEFAULT_SETTINGS.thresholdDb),
    minSilenceSec: g("minSilenceMs", DEFAULT_SETTINGS.minSilenceMs) / 1000,
    keepTalkSec: g("keepTalkMs", DEFAULT_SETTINGS.keepTalkMs) / 1000,
    marginBeforeSec: g("marginBeforeMs", DEFAULT_SETTINGS.marginBeforeMs) / 1000,
    marginAfterSec: g("marginAfterMs", DEFAULT_SETTINGS.marginAfterMs) / 1000,
  };
}

/**
 * Detect removable silence ranges in a dBFS envelope.
 * @param {number[]} db      per-window loudness (dBFS), evenly spaced by hopSec.
 * @param {number} hopSec    seconds between windows.
 * @param {object} opts      settings (ms) + offsetSec (source time of db[0]).
 * @returns {{start:number,end:number,silenceStart:number,silenceEnd:number}[]}
 *          ranges in source seconds (absolute, including offsetSec).
 */
export function detectSilences(db, hopSec, opts = {}) {
  const n = db ? db.length : 0;
  if (!n || !(hopSec > 0)) return [];
  const { thresholdDb, minSilenceSec, keepTalkSec, marginBeforeSec, marginAfterSec } = settingsToSec(opts);
  const offsetSec = opts.offsetSec || 0;

  // 1. Classify each window: loud (speech) vs silent.
  const loud = new Uint8Array(n);
  for (let i = 0; i < n; i++) loud[i] = db[i] >= thresholdDb ? 1 : 0;

  // 2. Demote speech islands shorter than keepTalk to silence, UNCONDITIONALLY
  //    (exact AutoCut/TimeBolt semantics — see DEFAULT_SETTINGS note). This
  //    merges a run of sub-keepTalk chatter bursts into one solid silence.
  //    keepTalk=0 disables this.
  const keepTalkWin = keepTalkSec > 0 ? Math.max(1, Math.round(keepTalkSec / hopSec)) : 0;
  if (keepTalkWin > 1) {
    let i = 0;
    while (i < n) {
      if (!loud[i]) { i++; continue; }
      let j = i;
      while (j < n && loud[j]) j++;
      if (j - i < keepTalkWin) for (let k = i; k < j; k++) loud[k] = 0;
      i = j;
    }
  }

  // 3. Walk silent runs; keep those >= minSilence; shrink by the margins.
  const ranges = [];
  let i = 0;
  while (i < n) {
    if (loud[i]) { i++; continue; }
    let j = i;
    while (j < n && !loud[j]) j++;
    const runStart = offsetSec + i * hopSec;
    const runEnd = offsetSec + j * hopSec;
    if (runEnd - runStart >= minSilenceSec) {
      const isLeading = i === 0;
      const isTrailing = j === n;
      const start = runStart + (isLeading ? 0 : marginAfterSec);
      const end = runEnd - (isTrailing ? 0 : marginBeforeSec);
      if (end - start > 0.001) {
        ranges.push({ start, end, silenceStart: runStart, silenceEnd: runEnd });
      }
    }
    i = j;
  }
  return ranges;
}

function percentileSorted(sorted, p) {
  if (!sorted.length) return SILENCE_FLOOR_DB;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Estimate a sensible noise threshold from the envelope's level distribution.
 * SPEECH-ANCHORED: place the threshold a fixed drop below the speech level
 * (p90 − 30 dB on the peak-normalized meter), never closer than 10 dB to
 * speech, never below noise + 6 dB. The 30 dB drop leaves room for QUIET
 * passages (a speaker leaning back sits 15–25 dB under their normal level and
 * must stay above the threshold) and reproduces AutoCut's AI pick (−43) on the
 * reference recording. The old noise-floor-anchored formula hugged the floor
 * and clamped at −60 — on a quiet mic it suggested the slider MINIMUM.
 * Windows on the envelope's −60 clamp are excluded so the pile doesn't skew
 * percentiles.
 */
export function estimateThreshold(db) {
  const vals = [];
  for (let i = 0; i < db.length; i++) {
    const v = db[i];
    if (isFinite(v) && v > ENVELOPE_FLOOR_DB + 0.5) vals.push(v);
  }
  if (!vals.length) return DEFAULT_SETTINGS.thresholdDb;
  vals.sort((a, b) => a - b);
  const noise = percentileSorted(vals, 0.15);
  const speech = percentileSorted(vals, 0.9);
  let th = Math.max(noise + 6, speech - 30);
  th = Math.min(th, speech - 10); // always leave headroom below speech
  th = Math.max(-55, Math.min(-20, th)); // stay off the slider ends (−60 = off)
  return Math.round(th);
}

/** Summary stats over a dBFS envelope, for the analyze tool and AI reasoning. */
export function levelStats(db) {
  const vals = [];
  for (let i = 0; i < db.length; i++) if (isFinite(db[i])) vals.push(db[i]);
  if (!vals.length) {
    return { windows: 0, minDb: null, maxDb: null, medianDb: null, noiseFloorDb: null, speechDb: null, suggestedThresholdDb: DEFAULT_SETTINGS.thresholdDb };
  }
  vals.sort((a, b) => a - b);
  const r1 = (x) => Math.round(x * 10) / 10;
  const nonFloor = vals.filter((v) => v > ENVELOPE_FLOOR_DB + 0.5);
  const noiseSrc = nonFloor.length ? nonFloor : vals;
  return {
    windows: db.length,
    minDb: r1(vals[0]),
    maxDb: r1(vals[vals.length - 1]),
    medianDb: r1(percentileSorted(vals, 0.5)),
    noiseFloorDb: r1(percentileSorted(noiseSrc, 0.15)),
    speechDb: r1(percentileSorted(vals, 0.9)),
    suggestedThresholdDb: estimateThreshold(db),
  };
}

/** Total seconds across a range list. */
export function totalRemovedSeconds(ranges) {
  let t = 0;
  for (const r of ranges) t += Math.max(0, r.end - r.start);
  return Math.round(t * 1000) / 1000;
}
