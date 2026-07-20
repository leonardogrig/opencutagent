// Unit checks for clip-bounded retake segmentation + fragment classification.
// Pure logic, synthetic words — no Premiere, no transcript cache needed.
import { TICKS_PER_SECOND, sourceRangeToTimelineFrames } from "../transcription/timecode.js";
import { groupIntoPhrases, sliceWordsToWindow } from "../transcription/segments.js";
import { partitionClip, classifyFragments, reconcile, reinsertTarget, planEditMarkers, MARKER_COLORS, srtTimestamp, wrapCaption, buildTranscriptCues, formatSrt, dedupeStackedSegments, carryOverMarks } from "../review.js";
import { planRetakeChunks } from "../ai.js";
import { stderrListsAudio } from "../audio/probe.js";

const TPS = Number(TICKS_PER_SECOND);
const TB = String(TPS / 30); // 30fps timebase
let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const word = (text, start, end) => ({ type: "word", text, start, end, speaker_id: "speaker_0" });
const clip = (id, inS, outS, tlStart) => ({
  id,
  sourceIn: { seconds: inS, ticks: String(Math.round(inS * TPS)) },
  sourceOut: { seconds: outS, ticks: String(Math.round(outS * TPS)) },
  start: { seconds: tlStart, ticks: String(Math.round(tlStart * TPS)) },
});

// A small source transcript: a false start, then the full take, then a pop event.
const WORDS = [
  word("NAN", 1.0, 1.3),
  word("now", 1.3, 1.5),
  word("has", 1.5, 1.7), // false start ends ~1.7
  // 0.9s pause (silence pass would cut here -> separate clips)
  word("NAN", 2.6, 2.9),
  word("now", 2.9, 3.1),
  word("has", 3.1, 3.3),
  word("a", 3.3, 3.4),
  word("set", 3.4, 3.7),
  { type: "audio_event", text: "lips smacking", start: 5.0, end: 5.4 }, // non-word
];

// --- sliceWordsToWindow assigns each word to exactly one window (midpoint rule) ---
const s1 = sliceWordsToWindow(WORDS, 0.8, 2.0).filter((w) => w.type === "word").map((w) => w.text).join(" ");
check("slice [0.8,2.0] = the false start only", s1 === "NAN now has", s1);
const s2 = sliceWordsToWindow(WORDS, 2.4, 3.9).filter((w) => w.type === "word").map((w) => w.text).join(" ");
check("slice [2.4,3.9] = the fuller take only", s2 === "NAN now has a set", s2);

// --- groupIntoPhrases reports wordCount (audio events don't count) ---
const ph = groupIntoPhrases(sliceWordsToWindow(WORDS, 4.5, 6.0), 0.5);
check("audio-event-only window -> 1 phrase", ph.length === 1, ph.length);
check("audio event contributes 0 words", ph[0].wordCount === 0, ph[0].wordCount);

// --- partitionClip tiles [sourceIn,sourceOut] with no gaps ---
const c = clip("V1.0", 0.5, 4.0, 0);
const parts = partitionClip(c, groupIntoPhrases(sliceWordsToWindow(WORDS, 0.5, 4.0), 0.5));
check("clip with internal pause -> 2 segments", parts.length === 2, parts.length);
check("first segment snaps to sourceIn", approx(parts[0].start, 0.5), parts[0].start);
check("last segment snaps to sourceOut", approx(parts[parts.length - 1].end, 4.0), parts[parts.length - 1].end);
let contiguous = true;
for (let i = 1; i < parts.length; i++) if (!approx(parts[i].start, parts[i - 1].end)) contiguous = false;
check("segments are contiguous (no slivers)", contiguous, parts.map((p) => [p.start, p.end]));

// --- word-empty clip -> single '(no speech)' segment ---
const emptyParts = partitionClip(clip("V1.9", 7.0, 8.0, 0), groupIntoPhrases(sliceWordsToWindow(WORDS, 7.0, 8.0), 0.5));
check("silent clip -> 1 segment", emptyParts.length === 1, emptyParts.length);
check("silent clip text = '(no speech)'", emptyParts[0].text === "(no speech)", emptyParts[0].text);
check("silent clip wordCount = 0", emptyParts[0].wordCount === 0, emptyParts[0].wordCount);

// --- classifyFragments: empty auto-cut, short flagged, normal untouched ---
const segs = [
  { wordCount: 0, durationSec: 0.6, decision: "keep", fragment: null, reason: null }, // pop -> cut
  { wordCount: 1, durationSec: 0.3, decision: "keep", fragment: null, reason: null }, // short -> flag
  { wordCount: 6, durationSec: 2.0, decision: "keep", fragment: null, reason: null }, // normal -> keep
];
const frag = classifyFragments(segs);
check("empty segment auto-marked cut", segs[0].decision === "cut" && segs[0].fragment === "empty", segs[0]);
check("short spoken segment flagged, still keep", segs[1].decision === "keep" && segs[1].fragment === "short", segs[1]);
check("normal segment untouched", segs[2].decision === "keep" && segs[2].fragment === null, segs[2]);
check("fragments tally: 1 auto-cut, 1 flagged", frag.autoCut === 1 && frag.flagged === 1, frag);

// --- classifyFragments respects opts (autoCutEmpty off) ---
const segs2 = [{ wordCount: 0, durationSec: 0.6, decision: "keep", fragment: null, reason: null }];
classifyFragments(segs2, { autoCutEmpty: false });
check("autoCutEmpty:false tags but does not cut", segs2[0].fragment === "empty" && segs2[0].decision === "keep", segs2[0]);

// --- end-to-end frame mapping for a real segment ---
const fr = sourceRangeToTimelineFrames(parts[0].start, parts[0].end, c, TB);
check("segment maps to a valid timeline frame range", fr && fr.endFrame > fr.startFrame, fr);

// ============================================================
//  reconcile() + reinsertTarget() — live source<->timeline mapping
//  (fake bridge returns a synthetic raw timeline; no Premiere)
// ============================================================
function rawClip(mediaPath, tlStart, tlEnd, srcIn, srcOut, id) {
  return {
    id: id || "V1.x", name: "c", trackType: "video", trackIndex: 0, itemIndex: 0, mediaPath,
    start: { seconds: tlStart, ticks: String(Math.round(tlStart * TPS)) },
    end: { seconds: tlEnd, ticks: String(Math.round(tlEnd * TPS)) },
    inPoint: { seconds: srcIn, ticks: String(Math.round(srcIn * TPS)) },
    outPoint: { seconds: srcOut, ticks: String(Math.round(srcOut * TPS)) },
  };
}
function rawTimeline(clips) {
  return { sequence: { name: "S", timebase: TB, frameRate: 30, zeroPointTicks: "0", dropFrame: false, videoTrackCount: 1, audioTrackCount: 1 }, clips, gaps: [] };
}
function seg(index, inS, outS) {
  return { index, mediaPath: "m.mp4", sourceInSec: inS, sourceOutSec: outS, trackType: "video", trackIndex: 0, durationSec: outS - inS, decision: "keep", protected: false };
}
function fakeCtx(raw, segments) {
  return {
    state: { revision: 0 },
    review: { sequence: "S", frameRate: 30, dropFrame: false, segments },
    bridge: { callHost: async (action) => { if (action === "getTimelineState") return raw; throw new Error("unexpected host call " + action); } },
  };
}
const SEGS = [seg(0, 0, 3), seg(1, 3, 6), seg(2, 6, 10)];
const byIdx = (map) => Object.fromEntries(map.map((m) => [m.index, m]));

// before any edit: one clip [src 0..10] @ tl [0..10] -> all present
{
  const ctx = fakeCtx(rawTimeline([rawClip("m.mp4", 0, 10, 0, 10)]), SEGS.map((s) => ({ ...s })));
  const { map } = await reconcile(ctx);
  check("reconcile: all present before edits", map.every((m) => m.state === "present"), map);
  check("reconcile: liveStart matches original", approx(byIdx(map)[1].liveStartSec, 3), byIdx(map)[1]);
}

// after ripple-cutting seg 1 [3,6]: left [src0..3]@tl[0..3], right [src6..10]@tl[3..7]
{
  const raw = rawTimeline([rawClip("m.mp4", 0, 3, 0, 3, "V1.0"), rawClip("m.mp4", 3, 7, 6, 10, "V1.1")]);
  const { map } = await reconcile(fakeCtx(raw, SEGS.map((s) => ({ ...s }))));
  const m = byIdx(map);
  check("reconcile: cut+removed seg is absent", m[1].state === "absent", m[1]);
  check("reconcile: survivors present", m[0].state === "present" && m[2].state === "present", map);
  check("reconcile: downstream survivor shifted left", approx(m[2].liveStartSec, 3), m[2]);
  check("reinsertTarget: lands before next survivor", approx(reinsertTarget(SEGS, map, 1), 3), reinsertTarget(SEGS, map, 1));
}

// partial: only a clip covering src [0,4]; seg [2,6] overlaps but isn't contained
{
  const { map } = await reconcile(fakeCtx(rawTimeline([rawClip("m.mp4", 0, 4, 0, 4)]), [seg(0, 2, 6)]));
  check("reconcile: partially-covered seg is 'partial' (not absent)", map[0].state === "partial", map[0]);
  check("reconcile: tail-trimmed partial spans only surviving footage", approx(map[0].liveStartSec, 2) && approx(map[0].liveEndSec, 4), map[0]);
}

// HEAD-trimmed partial: clip carries src [4,8] @ tl [0,4]; seg [2,6] lost its head.
// The live span must be only the surviving [src 4..6] -> tl [0,2]; stretching the
// full original duration to [0,4] would razor the next keeper on apply.
{
  const raw = rawTimeline([rawClip("m.mp4", 0, 4, 4, 8)]);
  const { map } = await reconcile(fakeCtx(raw, [seg(0, 2, 6), seg(1, 6, 8)]));
  const m = byIdx(map);
  check("reconcile: head-trimmed partial is 'partial'", m[0].state === "partial", m[0]);
  check("reconcile: head-trimmed partial spans only surviving footage", approx(m[0].liveStartSec, 0) && approx(m[0].liveEndSec, 2), m[0]);
  check("reconcile: keeper after head-trimmed partial keeps its own span", approx(m[1].liveStartSec, 2) && approx(m[1].liveEndSec, 4), m[1]);
}

// reinsertTarget edges: head (no prev present) -> next start; tail (no next) -> prev end
{
  const head = [{ index: 0, state: "absent", liveStartSec: null, liveEndSec: null }, { index: 1, state: "present", liveStartSec: 0, liveEndSec: 4 }, { index: 2, state: "present", liveStartSec: 4, liveEndSec: 8 }];
  check("reinsertTarget head (no prev) = next start", approx(reinsertTarget(SEGS, head, 0), 0), reinsertTarget(SEGS, head, 0));
  const tail = [{ index: 0, state: "present", liveStartSec: 0, liveEndSec: 3 }, { index: 1, state: "present", liveStartSec: 3, liveEndSec: 7 }, { index: 2, state: "absent", liveStartSec: null, liveEndSec: null }];
  check("reinsertTarget tail (no next) = prev end", approx(reinsertTarget(SEGS, tail, 2), 7), reinsertTarget(SEGS, tail, 2));
}

// ============================================================
//  planRetakeChunks() — windowing for chunked retake analysis
// ============================================================
{
  const n = 100, block = 36, ctx = 14;
  const chunks = planRetakeChunks(n, block, ctx);
  let tile = chunks[0].ownStart === 0 && chunks[chunks.length - 1].ownEnd === n;
  for (let i = 1; i < chunks.length; i++) if (chunks[i].ownStart !== chunks[i - 1].ownEnd) tile = false;
  check("planRetakeChunks: owners tile [0,n) with no gaps/overlap", tile, chunks.map((c) => [c.ownStart, c.ownEnd]));
  const owned = new Array(n).fill(0);
  for (const c of chunks) for (let i = c.ownStart; i < c.ownEnd; i++) owned[i]++;
  check("planRetakeChunks: every index owned exactly once", owned.every((x) => x === 1), owned);
  check(
    "planRetakeChunks: context contains owner & stays in bounds",
    chunks.every((c) => c.ctxStart >= 0 && c.ctxEnd <= n && c.ctxStart <= c.ownStart && c.ctxEnd >= c.ownEnd),
    chunks
  );
  check("planRetakeChunks: non-edge chunks actually get context margin", chunks[1].ctxStart < chunks[1].ownStart, chunks[1]);
}
{
  check("planRetakeChunks: small n -> 1 single-shot chunk", (() => { const c = planRetakeChunks(20, 36, 14); return c.length === 1 && c[0].single && c[0].ownEnd === 20; })(), planRetakeChunks(20, 36, 14));
  check("planRetakeChunks: n==block+context -> still single", (() => { const c = planRetakeChunks(50, 36, 14); return c.length === 1 && c[0].single; })(), planRetakeChunks(50, 36, 14));
  check("planRetakeChunks: n>threshold -> chunked (not single)", (() => { const c = planRetakeChunks(51, 36, 14); return c.length >= 2 && !c[0].single; })(), planRetakeChunks(51, 36, 14).length);
  check("planRetakeChunks: n==0 -> empty plan", planRetakeChunks(0, 36, 14).length === 0, planRetakeChunks(0, 36, 14));
}

// ============================================================
//  planEditMarkers() — Soft Apply timeline-marker planning
//  (pure: segments + reconcile map -> colored marker spans)
// ============================================================
function mseg(index, decision, o = {}) {
  return { index, decision, protected: !!o.protected, fragment: o.fragment || null, group: o.group == null ? null : o.group, text: o.text || ("seg" + index) };
}
const mmap = (rows) => rows.map(([index, state, s, e]) => ({ index, state, liveStartSec: s, liveEndSec: e }));

// staircase: 3 cuts of one beat (group 7) then the keeper -> hue dup span + green keeper
{
  const segs = [mseg(0, "cut", { group: 7 }), mseg(1, "cut", { group: 7 }), mseg(2, "cut", { group: 7 }), mseg(3, "keep")];
  const map = mmap([[0, "present", 0, 1], [1, "present", 1, 2], [2, "present", 2, 3], [3, "present", 3, 5]]);
  const { markers, stats } = planEditMarkers(segs, map);
  check("planEditMarkers: staircase -> 1 group, 1 keeper, 2 markers", stats.groups === 1 && stats.keepers === 1 && markers.length === 2, stats);
  const dup = markers.find((m) => m.colorIndex === MARKER_COLORS.PURPLE);
  const keep = markers.find((m) => m.colorIndex === MARKER_COLORS.GREEN);
  check("planEditMarkers: dup span covers all 3 cuts [0..3]", dup && approx(dup.startSec, 0) && approx(dup.endSec, 3), dup);
  check("planEditMarkers: keeper span is green over seg3 [3..5]", keep && approx(keep.startSec, 3) && approx(keep.endSec, 5), keep);
  check("planEditMarkers: every marker carries the sentinel comment", markers.every((m) => m.comment.indexOf("OpenCutAgent") === 0), markers.map((m) => m.comment));
}

// consecutive no-speech empties merge into ONE red span; no group emitted
{
  const segs = [mseg(0, "cut", { fragment: "empty" }), mseg(1, "cut", { fragment: "empty" }), mseg(2, "keep")];
  const map = mmap([[0, "present", 0, 0.5], [1, "present", 0.5, 1], [2, "present", 1, 4]]);
  const { markers, stats } = planEditMarkers(segs, map);
  check("planEditMarkers: consecutive empties -> 1 merged red span", markers.length === 1 && markers[0].colorIndex === MARKER_COLORS.RED, markers);
  check("planEditMarkers: red span spans both empties [0..1]", approx(markers[0].startSec, 0) && approx(markers[0].endSec, 1), markers[0]);
  check("planEditMarkers: no group for pure no-speech", stats.groups === 0 && stats.noSpeech === 1, stats);
}

// two groups get distinct cycled hues (purple, then orange); each its own green keeper
{
  const segs = [mseg(0, "cut", { group: 1 }), mseg(1, "keep"), mseg(2, "cut", { group: 2 }), mseg(3, "keep")];
  const map = mmap([[0, "present", 0, 1], [1, "present", 1, 2], [2, "present", 2, 3], [3, "present", 3, 4]]);
  const { markers, stats } = planEditMarkers(segs, map);
  const hues = markers.filter((m) => m.colorIndex !== MARKER_COLORS.GREEN).map((m) => m.colorIndex);
  check("planEditMarkers: 2 groups -> cycled hues purple,orange", stats.groups === 2 && hues[0] === MARKER_COLORS.PURPLE && hues[1] === MARKER_COLORS.ORANGE, hues);
}

// absent (already-removed) cuts are skipped: dup span starts at the surviving cut
{
  const segs = [mseg(0, "cut", { group: 5 }), mseg(1, "cut", { group: 5 }), mseg(2, "keep")];
  const map = mmap([[0, "absent", null, null], [1, "present", 1, 2], [2, "present", 2, 4]]);
  const { markers } = planEditMarkers(segs, map);
  const dup = markers.find((m) => m.colorIndex === MARKER_COLORS.PURPLE);
  check("planEditMarkers: absent cut excluded from dup span (starts at survivor)", dup && approx(dup.startSec, 1), dup);
}

// clean kept takes (no group, no cut) produce no markers
{
  const segs = [mseg(0, "keep"), mseg(1, "keep")];
  const map = mmap([[0, "present", 0, 2], [1, "present", 2, 4]]);
  const { markers } = planEditMarkers(segs, map);
  check("planEditMarkers: clean kept takes -> no markers", markers.length === 0, markers);
}

// fallback grouping (no `group` ids): a contiguous run of cuts is one group, a later run another
{
  const segs = [mseg(0, "cut"), mseg(1, "cut"), mseg(2, "keep"), mseg(3, "cut")];
  const map = mmap([[0, "present", 0, 1], [1, "present", 1, 2], [2, "present", 2, 3], [3, "present", 3, 4]]);
  const { stats } = planEditMarkers(segs, map);
  check("planEditMarkers: ungrouped contiguous cuts -> fallback groups (2 runs)", stats.groups === 2, stats);
}

// ============================================================
//  Transcript export — YouTube-ready SubRip (.srt)
//  (pure: segments + reconcile map -> ordered caption cues -> .srt text)
// ============================================================
function tseg(index, startSec, endSec, o = {}) {
  return {
    index, startSec, endSec, durationSec: endSec - startSec,
    text: o.text == null ? "seg" + index : o.text,
    wordCount: o.wordCount == null ? 3 : o.wordCount,
    fragment: o.fragment || null,
    decision: o.decision || "keep",
    protected: !!o.protected,
  };
}

// srtTimestamp: HH:MM:SS,mmm with comma before the milliseconds
check("srtTimestamp: 0 -> 00:00:00,000", srtTimestamp(0) === "00:00:00,000", srtTimestamp(0));
check("srtTimestamp: 3661.5 -> 01:01:01,500", srtTimestamp(3661.5) === "01:01:01,500", srtTimestamp(3661.5));
check("srtTimestamp: rounds ms, clamps negative", srtTimestamp(-5) === "00:00:00,000" && srtTimestamp(1.2345) === "00:00:01,235", [srtTimestamp(-5), srtTimestamp(1.2345)]);

// wrapCaption: greedy word wrap into <=maxLen lines
check("wrapCaption: short line stays one line", wrapCaption("hello there", 42) === "hello there", wrapCaption("hello there", 42));
check("wrapCaption: wraps past maxLen on word boundary", wrapCaption("aaaa bbbb cccc", 9) === "aaaa bbbb\ncccc", JSON.stringify(wrapCaption("aaaa bbbb cccc", 9)));

// keeps only, no-speech dropped, ordered by time
{
  const segs = [
    tseg(0, 0, 2, { text: "first take" }),
    tseg(1, 2, 3, { decision: "cut", text: "duplicate" }),        // cut -> dropped
    tseg(2, 3, 4, { fragment: "empty", wordCount: 0, text: "(no speech)" }), // no speech -> dropped
    tseg(3, 4, 6, { text: "final take" }),
  ];
  const cues = buildTranscriptCues(segs, null, { compact: false });
  check("export: only kept speech becomes cues (2 of 4)", cues.length === 2, cues.map((c) => c.index));
  check("export: absolute positions when not compacting", approx(cues[1].startSec, 4) && approx(cues[1].endSec, 6), cues[1]);
  check("export: cue carries trimmed text", cues[0].text === "first take", cues[0].text);
}

// compact (ripple): still-present cut time is subtracted from later cues
{
  const segs = [
    tseg(0, 0, 2, { text: "keep A" }),
    tseg(1, 2, 5, { decision: "cut", text: "cut 3s" }), // present cut, 3s -> shifts later keeps left by 3
    tseg(2, 5, 7, { text: "keep B" }),
  ];
  const cues = buildTranscriptCues(segs, null, { compact: true });
  check("export compact: keep A unchanged at [0,2]", approx(cues[0].startSec, 0) && approx(cues[0].endSec, 2), cues[0]);
  check("export compact: keep B shifted left by the 3s cut -> [2,4]", approx(cues[1].startSec, 2) && approx(cues[1].endSec, 4), cues[1]);
}

// compact: an ALREADY-removed (absent) cut is NOT double-counted; live keep positions win
{
  const segs = [
    tseg(0, 0, 2, { text: "keep A" }),
    tseg(1, 2, 5, { decision: "cut", text: "already gone" }),
    tseg(2, 5, 7, { text: "keep B" }),
  ];
  // reconcile-style map: cut absent, keep B already tightened to [2,4] on the live timeline
  const map = mmap([[0, "present", 0, 2], [1, "absent", null, null], [2, "present", 2, 4]]);
  const cues = buildTranscriptCues(segs, map, { compact: true });
  check("export compact+applied: no double subtraction (keep B at live [2,4])", approx(cues[1].startSec, 2) && approx(cues[1].endSec, 4), cues[1]);
}

// formatSrt: 1-based index, arrow line, blank separators, single trailing newline
{
  const srt = formatSrt([{ startSec: 0, endSec: 1.5, text: "hi" }, { startSec: 1.5, endSec: 3, text: "there" }]);
  const expected = "1\n00:00:00,000 --> 00:00:01,500\nhi\n\n2\n00:00:01,500 --> 00:00:03,000\nthere\n";
  check("formatSrt: canonical SubRip block layout", srt === expected, JSON.stringify(srt));
  check("formatSrt: empty cue list -> empty string", formatSrt([]) === "", JSON.stringify(formatSrt([])));
}

// dedupeStackedSegments: the same footage stacked on two video tracks (scaled
// punch-in copy on V2) must not list every line twice; only EXACT duplicates
// collapse, keeping the lowest track (input pre-sorted by startFrame, trackIndex).
{
  const dseg = (track, startFrame, endFrame, inSec, outSec, media = "/v/a.mp4") => ({
    mediaPath: media, trackIndex: track, startFrame, endFrame,
    sourceInSec: inSec, sourceOutSec: outSec, text: "x",
  });
  const stacked = [
    dseg(0, 0, 60, 0, 2),
    dseg(1, 0, 60, 0, 2),      // V2 copy of the same tile -> dropped
    dseg(0, 60, 120, 2, 4),
    dseg(1, 60, 120, 2.5, 4),  // same frames, DIFFERENT source range -> kept
    dseg(0, 120, 180, 4, 6, "/v/b.mp4"), // other media at same frames as next -> kept
    dseg(1, 120, 180, 4, 6),
  ];
  const out = dedupeStackedSegments(stacked);
  check("dedupe: exact stacked duplicate collapses to the lowest track", out.length === 5 && out.filter((s) => s.startFrame === 0).length === 1 && out.find((s) => s.startFrame === 0).trackIndex === 0, out.map((s) => `${s.trackIndex}@${s.startFrame}`));
  check("dedupe: same frames but different source range both survive", out.filter((s) => s.startFrame === 60).length === 2, null);
  check("dedupe: different media at the same position both survive", out.filter((s) => s.startFrame === 120).length === 2, null);
  const noMedia = [{ mediaPath: null, startFrame: 0, endFrame: 10 }, { mediaPath: null, startFrame: 0, endFrame: 10 }];
  check("dedupe: segments without media identity are never deduped", dedupeStackedSegments(noMedia).length === 2, null);
  check("dedupe: case/slash-insensitive media match", dedupeStackedSegments([
    dseg(0, 0, 60, 0, 2, "C:\\Media\\A.MP4"), dseg(1, 0, 60, 0, 2, "c:/media/a.mp4"),
  ]).length === 1, null);
}

// stderrListsAudio: the ffmpeg -i probe that lets silent clips (graphics, muted
// animation renders on V2) be SKIPPED instead of crashing the audio passes.
{
  const withAudio = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mp4':",
    "  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(progressive), 1920x1080, 30 fps",
    "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a), 48000 Hz, stereo, fltp, 192 kb/s",
    "At least one output file must be specified",
  ].join("\n");
  const videoOnly = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'anim.mp4':",
    "  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(progressive), 1000x1000, 1034 kb/s, 30 fps",
    "At least one output file must be specified",
  ].join("\n");
  check("probe: audio stream detected", stderrListsAudio(withAudio) === true, null);
  check("probe: video-only file has no audio", stderrListsAudio(videoOnly) === false, null);
  check("probe: empty/garbage stderr means no audio", stderrListsAudio("") === false && stderrListsAudio("Audio: mention outside a stream line") === false, null);
}

// carryOverMarks: rebuilding after a timeline edit keeps the user's review.
// Marks travel by media + track + source overlap; default segments carry nothing.
{
  const cseg = (inSec, outSec, extra = {}) => ({
    mediaPath: "/v/a.mp4", trackType: "video", trackIndex: 0,
    sourceInSec: inSec, sourceOutSec: outSec,
    decision: "keep", protected: false, manual: false, group: null, reason: null,
    ...extra,
  });
  const oldSegs = [
    cseg(0, 4, { decision: "cut", group: 7, reason: "restart" }),
    cseg(4, 8),                                   // default keep: carries nothing
    cseg(8, 12, { protected: true, manual: true }),
  ];
  // New tiling after an edit: first tile trimmed, one tile split in two.
  const newSegs = [
    cseg(1, 4),        // 75% inside the old cut -> becomes cut
    cseg(4, 8),        // matches the unmarked keep -> untouched
    cseg(8, 10),       // first half of the protected tile
    cseg(10, 12),      // second half of the protected tile
    cseg(20, 24),      // brand new footage -> untouched
    cseg(0, 4, { mediaPath: "/v/b.mp4" }), // other media at same range -> untouched
  ];
  const n = carryOverMarks(oldSegs, newSegs);
  check("carry: trimmed cut segment stays cut with its group + reason", newSegs[0].decision === "cut" && newSegs[0].group === 7 && newSegs[0].reason === "restart", newSegs[0]);
  check("carry: default old segment doesn't stamp the new one", newSegs[1].decision === "keep" && newSegs[1].group == null, newSegs[1]);
  check("carry: a split tile inherits protection on both halves", newSegs[2].protected === true && newSegs[3].protected === true && newSegs[2].decision === "keep", [newSegs[2], newSegs[3]]);
  check("carry: new footage and other media stay untouched", newSegs[4].manual === false && newSegs[5].decision === "keep", null);
  check("carry: reports how many segments got marks", n === 3, n);

  // Overlap under 50% of the new span must NOT carry (a sliver of an old cut).
  const barely = [cseg(3.5, 8)];
  carryOverMarks(oldSegs, barely);
  check("carry: sub-50% overlap carries nothing", barely[0].decision === "keep", barely[0]);
}

console.log(failures === 0 ? "\nAll retake-segment checks passed." : `\n${failures} retake-segment check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
