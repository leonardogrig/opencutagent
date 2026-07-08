// Unit checks for timeline-scoped transcription's interval math: we transcribe ONLY the
// source audio on the timeline (merged into islands), and a union cache means a reload
// after cutting never re-bills already-transcribed audio. Pure logic — no ffmpeg/Scribe.
import { mergeIntervals, subtractIntervals, mergeWords } from "../transcription/transcribe.js";

let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const pairs = (iv) => iv.map((r) => [r.start, r.end]);

// --- mergeIntervals: pad, sort, coalesce overlapping / near ranges ---
{
  // no pad, no gap: two disjoint ranges stay separate
  const m = mergeIntervals([{ start: 10, end: 20 }, { start: 0, end: 5 }], { mergeGapSec: 0, padSec: 0 });
  check("mergeIntervals: disjoint ranges stay separate + sorted", JSON.stringify(pairs(m)) === JSON.stringify([[0, 5], [10, 20]]), pairs(m));
}
{
  // overlapping ranges merge
  const m = mergeIntervals([{ start: 0, end: 6 }, { start: 5, end: 10 }], { mergeGapSec: 0, padSec: 0 });
  check("mergeIntervals: overlapping ranges merge to one", pairs(m).length === 1 && approx(m[0].start, 0) && approx(m[0].end, 10), pairs(m));
}
{
  // ranges within mergeGap coalesce (silence-pass fragments -> one island)
  const m = mergeIntervals([{ start: 0, end: 3 }, { start: 4, end: 7 }], { mergeGapSec: 2, padSec: 0 });
  check("mergeIntervals: 1s gap <= 2s mergeGap coalesces", pairs(m).length === 1 && approx(m[0].end, 7), pairs(m));
  const m2 = mergeIntervals([{ start: 0, end: 3 }, { start: 10, end: 12 }], { mergeGapSec: 2, padSec: 0 });
  check("mergeIntervals: 7s gap > 2s mergeGap stays split", pairs(m2).length === 2, pairs(m2));
}
{
  // padding widens edges but never below 0
  const m = mergeIntervals([{ start: 0.1, end: 5 }], { mergeGapSec: 0, padSec: 0.25 });
  check("mergeIntervals: pad clamps low edge to 0, extends high", approx(m[0].start, 0) && approx(m[0].end, 5.25), m[0]);
}
{
  // invalid ranges dropped; empty -> empty
  const m = mergeIntervals([{ start: 5, end: 5 }, { start: 3, end: 1 }, null, { start: 1, end: 2 }], { mergeGapSec: 0, padSec: 0 });
  check("mergeIntervals: drops zero/negative/null ranges", pairs(m).length === 1 && approx(m[0].start, 1), pairs(m));
  check("mergeIntervals: empty input -> empty", mergeIntervals([]).length === 0, mergeIntervals([]));
}

// --- subtractIntervals: what still needs transcribing given what's cached ---
{
  // fully covered -> nothing to do (the reload-after-cut = free case)
  const need = [{ start: 2, end: 5 }];
  const cov = [{ start: 0, end: 10 }];
  check("subtractIntervals: need fully inside cache -> empty (free reload)", subtractIntervals(need, cov).length === 0, subtractIntervals(need, cov));
}
{
  // partial overlap -> only the uncovered remainder
  const out = subtractIntervals([{ start: 0, end: 10 }], [{ start: 3, end: 6 }]);
  check("subtractIntervals: middle-covered -> two remainders", JSON.stringify(pairs(out)) === JSON.stringify([[0, 3], [6, 10]]), pairs(out));
}
{
  // left-covered -> right remainder only
  const out = subtractIntervals([{ start: 0, end: 10 }], [{ start: 0, end: 4 }]);
  check("subtractIntervals: left-covered -> right remainder", pairs(out).length === 1 && approx(out[0].start, 4) && approx(out[0].end, 10), pairs(out));
}
{
  // disjoint cache -> unchanged; empty cache -> whole need
  check("subtractIntervals: disjoint cache leaves need intact", pairs(subtractIntervals([{ start: 0, end: 5 }], [{ start: 8, end: 9 }])).length === 1, subtractIntervals([{ start: 0, end: 5 }], [{ start: 8, end: 9 }]));
  check("subtractIntervals: no cache -> whole need", pairs(subtractIntervals([{ start: 0, end: 5 }], [])).length === 1, subtractIntervals([{ start: 0, end: 5 }], []));
}
{
  // sub-eps remainders are discarded (no pointless 10ms Scribe calls)
  const out = subtractIntervals([{ start: 0, end: 5 }], [{ start: 0, end: 4.98 }]);
  check("subtractIntervals: sub-eps remainder discarded", out.length === 0, out);
}

// --- union-cache scenario: cut a retake, reload -> subset already covered -> 0 new audio ---
{
  const firstLoad = mergeIntervals([{ start: 0, end: 60 }], { mergeGapSec: 2, padSec: 0.25 }); // island ~[0,60.25]
  // after cutting [20,30] the timeline now uses [0,20] and [30,60] — both already inside the island
  const afterCut = mergeIntervals([{ start: 0, end: 20 }, { start: 30, end: 60 }], { mergeGapSec: 2, padSec: 0.25 });
  const still = subtractIntervals(afterCut, firstLoad);
  check("union cache: reload after a cut needs NO new transcription", still.length === 0, still);
}

// --- mergeWords: dedup boundary duplicates from island padding, keep order ---
{
  const a = [{ type: "word", text: "hello", start: 1.0, end: 1.3 }, { type: "word", text: "world", start: 1.3, end: 1.7 }];
  const b = [{ type: "word", text: "world", start: 1.31, end: 1.71 }, { type: "word", text: "again", start: 2.0, end: 2.4 }]; // 'world' re-transcribed at a join
  const m = mergeWords(a, b);
  check("mergeWords: sorted by start", m.map((w) => w.text).join(",") === "hello,world,again", m.map((w) => w.text));
  check("mergeWords: near-duplicate boundary word deduped", m.filter((w) => w.text === "world").length === 1, m.map((w) => [w.text, w.start]));
}

console.log(failures === 0 ? "\nAll transcribe-range checks passed." : `\n${failures} transcribe-range check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
