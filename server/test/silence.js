// Unit checks for the loudness-based silence detector (no ffmpeg / Premiere).
// Pins the behavior the panel mirrors in computeSilenceRanges().
import { detectSilences, estimateThreshold, levelStats, totalRemovedSeconds, PRESETS, DEFAULT_SETTINGS, ENVELOPE_FLOOR_DB } from "../audio/silence.js";

let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const HOP = 0.02;
const LOUD = -20;
const SIL = -60; // the envelope floor — levels.js clamps here

// Build an envelope from [seconds, dB] segments at 20 ms hop.
function env(segments) {
  const db = [];
  for (const [sec, level] of segments) {
    const n = Math.round(sec / HOP);
    for (let i = 0; i < n; i++) db.push(level);
  }
  return db;
}

const OPTS = { thresholdDb: -36, minSilenceMs: 120, keepTalkMs: 100, marginBeforeMs: 120, marginAfterMs: 120 };

// --- 1. interior silence shrunk by both margins ---
let r = detectSilences(env([[1, LOUD], [1, SIL], [1, LOUD]]), HOP, OPTS);
check("interior: 1 range", r.length === 1, r);
check("interior: start = 1.12 (silence + marginAfter)", r[0] && approx(r[0].start, 1.12), r[0]);
check("interior: end = 1.88 (silence - marginBefore)", r[0] && approx(r[0].end, 1.88), r[0]);

// --- 2. leading silence keeps no margin at the head ---
r = detectSilences(env([[1, SIL], [1, LOUD]]), HOP, OPTS);
check("leading: starts at 0", r[0] && approx(r[0].start, 0), r[0]);
check("leading: ends at 0.88", r[0] && approx(r[0].end, 0.88), r[0]);

// --- 3. trailing silence keeps no margin at the tail ---
r = detectSilences(env([[1, LOUD], [1, SIL]]), HOP, OPTS);
check("trailing: start 1.12", r[0] && approx(r[0].start, 1.12), r[0]);
check("trailing: ends at 2.0", r[0] && approx(r[0].end, 2.0), r[0]);

// --- 4. keepTalk merges a silence split by a brief blip (unconditional demotion) ---
const split = env([[1, LOUD], [0.5, SIL], [0.04, LOUD], [0.46, SIL], [1, LOUD]]);
r = detectSilences(split, HOP, OPTS);
check("keepTalk on: blip demoted -> 1 merged range", r.length === 1, r);
check("merged range spans 1.12..1.88", r[0] && approx(r[0].start, 1.12) && approx(r[0].end, 1.88), r[0]);
const r2 = detectSilences(split, HOP, { ...OPTS, keepTalkMs: 0 });
check("keepTalk off: blip preserved -> 2 ranges", r2.length === 2, r2);

// --- 4b. AutoCut semantics: a stretch of sub-keepTalk chatter bursts merges
// into ONE solid silence (each burst demoted regardless of surroundings) ---
const chatter = env([
  [1, LOUD], [0.3, SIL], [0.2, LOUD], [0.25, SIL], [0.3, LOUD], [0.2, SIL],
  [0.15, LOUD], [0.3, SIL], [0.25, LOUD], [0.35, SIL], [1, LOUD],
]);
r = detectSilences(chatter, HOP, { ...OPTS, keepTalkMs: 400 });
check("chatter block: all sub-400ms bursts demoted -> 1 solid range", r.length === 1, r);
check("chatter block spans the whole stretch", r[0] && approx(r[0].start, 1.12) && r[0].silenceEnd > 3.25 && approx(r[0].end, r[0].silenceEnd - 0.12), r[0]);
// an island >= keepTalk in the middle survives and splits the block
const chatterWithWord = env([[1, LOUD], [0.5, SIL], [0.6, LOUD], [0.5, SIL], [1, LOUD]]);
r = detectSilences(chatterWithWord, HOP, { ...OPTS, keepTalkMs: 400 });
check("island >= keepTalk survives and splits the silence", r.length === 2, r);
// pop at the clip head is demoted too
const headPop = env([[0.3, SIL], [0.2, LOUD], [1, SIL], [1, LOUD]]);
r = detectSilences(headPop, HOP, { ...OPTS, keepTalkMs: 400 });
check("clip-head pop demoted -> merges into leading silence", r.length === 1 && approx(r[0].start, 0), r);

// --- 5. silences shorter than minSilence are kept ---
r = detectSilences(env([[1, LOUD], [0.08, SIL], [1, LOUD]]), HOP, OPTS);
check("short silence (<min) -> 0 ranges", r.length === 0, r);

// --- 6. offset shifts ranges into absolute source seconds ---
r = detectSilences(env([[1, LOUD], [1, SIL], [1, LOUD]]), HOP, { ...OPTS, offsetSec: 10 });
check("offset: range shifted by +10s", r[0] && approx(r[0].start, 11.12) && approx(r[0].end, 11.88), r[0]);

// --- 7. threshold estimate is SPEECH-anchored and never lands on the floor ---
const QUIET = -52; // room tone above the −60 clamp
const bimodal = env([[10, QUIET], [10, LOUD]]);
let th = estimateThreshold(bimodal);
check("estimateThreshold between noise and speech", th > QUIET && th < LOUD, th);
check("estimateThreshold = max(noise+6, speech−30) (−46)", Math.abs(th - (QUIET + 6)) <= 2, th);
// windows on the −60 clamp are excluded — the suggestion must NOT chase them to the slider minimum
th = estimateThreshold(env([[30, ENVELOPE_FLOOR_DB], [10, LOUD]]));
check("floor pile excluded: suggestion stays in −55…−20, not −60", th >= -55 && th <= -20, th);
// hot recording: keep 8dB headroom below speech, cap at −20
th = estimateThreshold(env([[10, -30], [10, -10]]));
check("hot audio: capped at −20 with headroom", th <= -20 && th <= -10 - 8, th);

// --- 8. stats summary ---
const st = levelStats(bimodal);
check("stats: speechDb near -20", Math.abs(st.speechDb - LOUD) <= 2, st);
check("stats: noiseFloorDb near -52", Math.abs(st.noiseFloorDb - QUIET) <= 2, st);
check("stats: suggestedThresholdDb present", Number.isFinite(st.suggestedThresholdDb), st);

// --- 9. totals ---
r = detectSilences(env([[1, LOUD], [1, SIL], [1, LOUD], [1, SIL], [1, LOUD]]), HOP, OPTS);
check("two interior silences -> 2 ranges", r.length === 2, r);
check("total removed = 2 * 0.76s", approx(totalRemovedSeconds(r), 1.52), totalRemovedSeconds(r));

// --- 10. presets + defaults are well-formed ---
check("DEFAULT_SETTINGS threshold -36", DEFAULT_SETTINGS.thresholdDb === -36);
check("DEFAULT keepTalk 400 (AutoCut's recommended band)", DEFAULT_SETTINGS.keepTalkMs === 400);
check("5 presets defined", Object.keys(PRESETS).length === 5, Object.keys(PRESETS));
check("Rapid more aggressive than Relaxed", PRESETS.Rapid.minSilenceMs < PRESETS.Relaxed.minSilenceMs);
check("all presets keep pops out (keepTalk >= 400)", Object.values(PRESETS).every((p) => p.keepTalkMs >= 400), PRESETS);
check("no minGap in defaults (feature removed)", !("minGapMs" in DEFAULT_SETTINGS), DEFAULT_SETTINGS);

// --- 11. empty / degenerate inputs ---
check("empty envelope -> []", detectSilences([], HOP, OPTS).length === 0);
check("all loud -> []", detectSilences(env([[2, LOUD]]), HOP, OPTS).length === 0);
check("hopSec<=0 -> []", detectSilences(env([[1, SIL]]), 0, OPTS).length === 0);
// slider minimum = detect nothing: envelope clamped at −60, threshold −60 → everything is "loud"
r = detectSilences(env([[2, ENVELOPE_FLOOR_DB], [1, LOUD]]), HOP, { ...OPTS, thresholdDb: ENVELOPE_FLOOR_DB });
check("threshold at −60 floor -> 0 ranges (slider min = off)", r.length === 0, r);

console.log(failures === 0 ? "\nAll silence checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
