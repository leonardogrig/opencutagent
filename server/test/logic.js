// Unit checks for the correctness-critical pure logic: tick/timecode alignment
// and silence/filler cut computation. No Premiere needed.
import { TICKS_PER_SECOND, sourceSecToTimeline, sourceRangeToTimelineFrames, formatTimecode, timecodeToFrames } from "../transcription/timecode.js";
import { computeCuts, detectFillers, detectSilences } from "../transcription/segments.js";
import { resolveToSeconds } from "../tools/util.js";

const TPS = Number(TICKS_PER_SECOND);
let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// --- timecode alignment ---
// 30fps sequence; clip uses source [10s,40s], sits at timeline start 5s.
const timebase30 = String(TPS / 30);
// Shape matches the normalized clip from tools/util.js getTimeline().
const clip = {
  start: { ticks: String(5 * TPS), seconds: 5 },
  sourceIn: { ticks: String(10 * TPS), seconds: 10 },
  sourceOut: { ticks: String(40 * TPS), seconds: 40 },
};

const w = sourceSecToTimeline(12.5, clip, timebase30); // word at source 12.5s
check("word maps to timeline 7.5s", approx(w.seconds, 7.5), w.seconds);
check("word maps to frame 225", w.frame === 225, w.frame);
check("frame 225 @30 = 00:00:07:15", formatTimecode(225, 30, false) === "00:00:07:15", formatTimecode(225, 30, false));

const r = sourceRangeToTimelineFrames(5, 12.5, clip, timebase30); // clamps lo to in-point 10s
check("range clamps to clip in-point (150f)", r && r.startFrame === 150, r);
check("range end frame 225", r && r.endFrame === 225, r);
const off = sourceRangeToTimelineFrames(2, 8, clip, timebase30); // entirely before in-point
check("range fully trimmed off -> null", off === null, off);

// drop-frame formatting sanity (29.97). The minute boundary is frame 1800,
// where DF skips ;00/;01, so frame 1800 -> 00:01:00;02 (and 1798 -> 00:00:59;28).
check("DF 1798f @29.97 = 00:00:59;28", formatTimecode(1798, 29.97, true) === "00:00:59;28", formatTimecode(1798, 29.97, true));
check("DF 1800f @29.97 = 00:01:00;02", formatTimecode(1800, 29.97, true) === "00:01:00;02", formatTimecode(1800, 29.97, true));

// --- timecode -> frames inverse + resolveToSeconds ---
// round-trips with formatTimecode at NDF and DF (incl. the DF minute boundary)
check("inverse NDF 00:01:00:00 @30 = 1800f", timecodeToFrames(0, 1, 0, 0, 30, false) === 1800, timecodeToFrames(0, 1, 0, 0, 30, false));
check("inverse DF 00:01:00;02 @29.97 = 1800f", timecodeToFrames(0, 1, 0, 2, 29.97, true) === 1800, timecodeToFrames(0, 1, 0, 2, 29.97, true));
check("inverse DF 00:00:59;28 @29.97 = 1798f", timecodeToFrames(0, 0, 59, 28, 29.97, true) === 1798, timecodeToFrames(0, 0, 59, 28, 29.97, true));
check("inverse DF 00:10:00;00 @29.97 = 17982f", timecodeToFrames(0, 10, 0, 0, 29.97, true) === 17982, timecodeToFrames(0, 10, 0, 0, 29.97, true));

// resolveToSeconds: numbers and frames pass through; TC is frame-count math
check("resolve number stays seconds", resolveToSeconds(12.5, 30) === 12.5, resolveToSeconds(12.5, 30));
check("resolve '370f' = frames/fps", approx(resolveToSeconds("370f", 29.97), 370 / 29.97, 1e-9), resolveToSeconds("370f", 29.97));
check("resolve NDF TC @29.97 is frame-count (not wall-clock)", approx(resolveToSeconds("00:01:00:00", 29.97), 1800 / 29.97, 1e-9), resolveToSeconds("00:01:00:00", 29.97));
// ruler TC on a sequence with a 01:00:00:00 start TC resolves timeline-relative
check(
  "resolve subtracts the sequence zero point",
  approx(resolveToSeconds("01:00:05:00", 30, { zeroPointFrames: 108000 }), 5, 1e-9),
  resolveToSeconds("01:00:05:00", 30, { zeroPointFrames: 108000 })
);
{
  let threw = false;
  try { resolveToSeconds("00:00:01:00", 30, { zeroPointFrames: 108000 }); } catch { threw = true; }
  check("resolve rejects TC before the start TC", threw, "no throw");
}

// --- cut computation ---
const words = [
  { type: "word", text: "So", start: 0.0, end: 0.3 },
  { type: "word", text: "um", start: 0.3, end: 0.6 }, // filler
  { type: "word", text: "today", start: 1.5, end: 2.0 }, // 0.9s silent gap before this
  { type: "word", text: "we", start: 2.0, end: 2.2 },
  { type: "word", text: "ship", start: 2.2, end: 2.6 },
];
check("detects 1 filler (um)", detectFillers(words).length === 1, detectFillers(words));
check("detects 1 silence >=0.4s", detectSilences(words, 0.4).length === 1, detectSilences(words, 0.4));

const cuts = computeCuts(words, { minSilenceSec: 0.4, padSec: 0.08 });
check("filler+silence merge into one range", cuts.length === 1, cuts);
check("merged range start ~0.22", cuts[0] && approx(cuts[0].start, 0.22, 1e-9), cuts[0]);
check("merged range end ~1.42", cuts[0] && approx(cuts[0].end, 1.42, 1e-9), cuts[0]);

// fillers off -> only the silence remains, padded
const silenceOnly = computeCuts(words, { minSilenceSec: 0.4, padSec: 0.08, removeFillers: false });
check("silence-only cut start ~0.68", silenceOnly[0] && approx(silenceOnly[0].start, 0.68, 1e-9), silenceOnly[0]);

console.log(failures === 0 ? "\nAll logic checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
