// Unit checks for timeline-scoped transcription's interval math: we transcribe ONLY the
// source audio on the timeline (merged into islands), and a union cache means a reload
// after cutting never re-bills already-transcribed audio. Pure logic — no ffmpeg/Scribe.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  mergeIntervals, subtractIntervals, mergeWords,
  planConcatBatches, buildConcatLayout, remapConcatWords, parseFfmpegOutTime,
  transcribeSourceRanges,
} from "../transcription/transcribe.js";

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

// --- planConcatBatches: pack islands into duration-capped Scribe uploads ---
{
  const isl = [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 55 }];
  const b = planConcatBatches(isl, 25);
  check("planConcatBatches: splits when a batch would exceed maxSec", b.length === 2 && b[0].length === 2 && b[1].length === 1, b);
  const one = planConcatBatches(isl, 1800);
  check("planConcatBatches: everything fits -> one batch", one.length === 1 && one[0].length === 3, one);
}
{
  // an island longer than maxSec still becomes ONE batch (never split)
  const b = planConcatBatches([{ start: 0, end: 100 }, { start: 200, end: 205 }], 30);
  check("planConcatBatches: oversized island gets its own batch, not split", b.length === 2 && b[0].length === 1 && approx(b[0][0].end, 100), b);
  check("planConcatBatches: empty input -> no batches", planConcatBatches([], 30).length === 0, planConcatBatches([], 30));
}

// --- buildConcatLayout: island positions in the concatenated wav (with spacers) ---
{
  const { layout, totalSec } = buildConcatLayout([{ start: 100, end: 110 }, { start: 300, end: 305 }], 1.0);
  check("buildConcatLayout: first island starts at 0", approx(layout[0].concatStart, 0) && approx(layout[0].concatEnd, 10), layout[0]);
  check("buildConcatLayout: second island after a 1s spacer", approx(layout[1].concatStart, 11) && approx(layout[1].concatEnd, 16), layout[1]);
  check("buildConcatLayout: total = islands + inner spacers only", approx(totalSec, 16), totalSec);
  check("buildConcatLayout: empty -> 0 total", buildConcatLayout([], 1).totalSec === 0, buildConcatLayout([], 1));
}

// --- remapConcatWords: concat-time words back to SOURCE seconds ---
{
  const { layout } = buildConcatLayout([{ start: 100, end: 110 }, { start: 300, end: 305 }], 1.0);
  const words = [
    { type: "word", text: "alpha", start: 2.0, end: 2.5 },    // island 1 -> source 102-102.5
    { type: "word", text: "spacer", start: 10.4, end: 10.7 }, // inside the 10-11 spacer -> dropped
    { type: "word", text: "beta", start: 12.0, end: 12.5 },   // island 2 -> source 301-301.5
  ];
  const m = remapConcatWords(words, layout);
  check("remapConcatWords: island-1 word offset to source time", m[0].text === "alpha" && approx(m[0].start, 102) && approx(m[0].end, 102.5), m[0]);
  check("remapConcatWords: spacer hallucination dropped", m.length === 2 && !m.some((w) => w.text === "spacer"), m.map((w) => w.text));
  check("remapConcatWords: island-2 word offset to source time", m[1].text === "beta" && approx(m[1].start, 301) && approx(m[1].end, 301.5), m[1]);
}
{
  // a word overhanging an island edge is clamped into its island (end > start kept)
  const { layout } = buildConcatLayout([{ start: 100, end: 110 }], 1.0);
  const m = remapConcatWords([{ type: "word", text: "edge", start: 9.8, end: 10.6 }], layout);
  check("remapConcatWords: overhanging word clamped to island end", m.length === 1 && approx(m[0].end, 110) && m[0].end > m[0].start, m);
  check("remapConcatWords: word without numeric start dropped", remapConcatWords([{ text: "x" }], layout).length === 0, remapConcatWords([{ text: "x" }], layout));
}
{
  // unsorted input still remaps correctly (cursor advance relies on sorting internally)
  const { layout } = buildConcatLayout([{ start: 0, end: 5 }, { start: 50, end: 55 }], 1.0);
  const m = remapConcatWords([
    { type: "word", text: "late", start: 7.0, end: 7.4 },
    { type: "word", text: "early", start: 1.0, end: 1.4 },
  ], layout);
  check("remapConcatWords: handles unsorted words", m.length === 2 && approx(m[0].start, 1) && approx(m[1].start, 51), m);
}

// --- parseFfmpegOutTime: extraction progress from ffmpeg -progress stderr chunks ---
{
  // out_time_ms is MICROseconds (ffmpeg quirk); the LAST value in a chunk wins
  const sec = parseFfmpegOutTime("frame=0\nout_time_ms=1500000\nprogress=continue\nout_time_ms=2500000\n");
  check("parseFfmpegOutTime: microsecond field, last value wins", approx(sec, 2.5), sec);
  const hms = parseFfmpegOutTime("out_time=00:01:30.500000\nprogress=continue\n");
  check("parseFfmpegOutTime: falls back to HH:MM:SS form", approx(hms, 90.5), hms);
  check("parseFfmpegOutTime: chunk without progress -> null", parseFfmpegOutTime("size=  128kB bitrate=...") === null, parseFfmpegOutTime("size=..."));
  check("parseFfmpegOutTime: garbage -> null, never NaN", parseFfmpegOutTime("") === null, parseFfmpegOutTime(""));
}

// cacheOnly (the panel's silent auto-load): a fully covered timeline loads from
// the ranged cache with NO key and NO billing; anything uncovered aborts with a
// typed cache_incomplete error before any key check or Scribe call.
await (async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ocatr-"));
  const savedKey = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY; // prove covered loads need no key at all
  try {
    const media = join(tmp, "talk.mp4");
    writeFileSync(media, "fake media bytes");
    // Mirror transcribe.js cacheKey (stem + hash of path|size|mtime).
    const st = statSync(media);
    const h = createHash("sha1").update(`${media}|${st.size}|${Math.round(st.mtimeMs)}`).digest("hex").slice(0, 10);
    const stem = basename(media, extname(media)).replace(/[^\w.-]/g, "_");
    mkdirSync(join(tmp, "transcripts"), { recursive: true });
    writeFileSync(
      join(tmp, "transcripts", `${stem}.${h}.ranged.json`),
      JSON.stringify({ islands: [{ start: 5, end: 30 }], words: [{ type: "word", text: "hello", start: 12, end: 12.4 }] })
    );

    const covered = await transcribeSourceRanges(media, [{ start: 10, end: 20 }], { cacheDir: tmp, cacheOnly: true });
    check("cacheOnly: fully covered range loads from cache, no key needed", covered.cached === true && covered.payload.words.length === 1, covered);

    let err = null;
    try { await transcribeSourceRanges(media, [{ start: 10, end: 60 }], { cacheDir: tmp, cacheOnly: true }); }
    catch (e) { err = e; }
    check("cacheOnly: uncovered range aborts with cache_incomplete (never bills)", !!err && err.code === "cache_incomplete", err && err.message);
    // (The billing path's key requirement isn't asserted here: liveEnv reads the
    // real project .env, so the check would depend on the developer's machine.)
  } finally {
    if (savedKey != null) process.env.ELEVENLABS_API_KEY = savedKey;
    rmSync(tmp, { recursive: true, force: true });
  }
})();

console.log(failures === 0 ? "\nAll transcribe-range checks passed." : `\n${failures} transcribe-range check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
