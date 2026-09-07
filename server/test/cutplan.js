// Unit checks for the retake cut planner (server/cutplan.js): cut edges placed in
// the quiet between words on a synthetic loudness envelope, timestamp fallbacks,
// excess/filler trims, run splitting, span merging and live-timeline mapping.
// Pure logic, no Premiere / ffmpeg / transcript cache.
import {
  makeEnv, quietStretch, minLevelPoint, headCut, tailCut, planCutSpans, mapSpansToTimeline, fillerStats, findUnrecognizedSounds,
  DEFAULT_MARGIN_BEFORE_SEC, DEFAULT_MARGIN_AFTER_SEC, FALLBACK_LEAD_SEC, FALLBACK_TAIL_SEC,
} from "../cutplan.js";
import { TICKS_PER_SECOND } from "../transcription/timecode.js";

let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}
const approx = (a, b, eps = 0.011) => Math.abs(a - b) < eps; // half a 20 ms window

// Synthetic envelope: 20 ms windows, quiet (-50 dB) everywhere except the given
// loud spans (-20 dB). Threshold -36 (the Remove Silences default).
const HOP = 0.02;
function envelope(loudSpans, seconds = 10, opts = {}) {
  const db = new Array(Math.round(seconds / HOP)).fill(-50);
  for (const [a, b, level] of loudSpans) {
    for (let k = Math.floor(a / HOP); k < Math.ceil(b / HOP); k++) db[k] = level != null ? level : -20;
  }
  return makeEnv({ db, hopSec: HOP }, opts.thresholdDb != null ? opts.thresholdDb : -36);
}

// --- makeEnv ---
check("makeEnv: rejects a malformed envelope", makeEnv({ db: null, hopSec: HOP }, -36) === null);
check("makeEnv: default threshold is estimated from the envelope", Number.isFinite(makeEnv({ db: envelope([[1, 2]]).db, hopSec: HOP }).thresholdDb));

// --- quietStretch / minLevelPoint ---
{
  // Real voice 0.95..1.95 (Scribe says the word ends at 1.8) then silence, next real onset 2.35 (Scribe says 2.5).
  const env = envelope([[0.95, 1.95], [2.35, 3.2]]);
  const q = quietStretch(env, 1.8, 2.5);
  check("quiet: finds the real gap, extended past the transcript's early word end", q && approx(q.q0, 1.95) && approx(q.q1, 2.35), q);
  const blip = envelope([[0.95, 1.95], [2.1, 2.14], [2.35, 3.2]]); // a 40 ms click inside the gap
  const qb = quietStretch(blip, 1.8, 2.5);
  check("quiet: a short blip does not split the gap", qb && approx(qb.q0, 1.95) && approx(qb.q1, 2.35), qb);
  const none = envelope([[0.95, 3.2]]);
  check("quiet: continuous speech has no quiet stretch", quietStretch(none, 1.8, 2.5) === null);
  const dip = envelope([[0.95, 3.2], [2.1, 2.12, -30]]); // a -30 dB dip: not quiet, but the lowest energy
  check("minLevelPoint: the lowest-energy window between the words", approx(minLevelPoint(dip, 1.8, 2.5), 2.11), minLevelPoint(dip, 1.8, 2.5));
  check("minLevelPoint: no envelope -> midpoint", approx(minLevelPoint(null, 1.8, 2.5), 2.15));
}

// --- headCut / tailCut ---
{
  const env = envelope([[0.95, 1.95], [2.35, 3.2]]);
  const h = headCut(env, 1.8, 2.5);
  check("headCut: margin of air ahead of the REAL onset (2.35), not the raw timestamp (2.5)", approx(h, 2.35 - DEFAULT_MARGIN_BEFORE_SEC), h);
  const t = tailCut(env, 1.8, 2.5);
  check("tailCut: margin of air behind the REAL word end (1.95), not the raw timestamp (1.8)", approx(t, 1.95 + DEFAULT_MARGIN_AFTER_SEC), t);
  // A gap too short for the full margin gives the kept side all the quiet there is.
  const tight = envelope([[0.95, 2.0], [2.05, 3.2]]);
  check("headCut: a 50 ms gap gives all of it to the kept side", approx(headCut(tight, 1.8, 2.5), 2.0), headCut(tight, 1.8, 2.5));
  check("tailCut: a 50 ms gap gives all of it to the kept side", approx(tailCut(tight, 1.8, 2.5), 2.05), tailCut(tight, 1.8, 2.5));
  // Continuous speech: the quietest point between the words.
  const dip = envelope([[0.95, 3.2], [2.1, 2.12, -30]]);
  check("headCut: continuous speech -> quietest point", approx(headCut(dip, 1.8, 2.5), 2.11), headCut(dip, 1.8, 2.5));
  check("tailCut: continuous speech -> quietest point", approx(tailCut(dip, 1.8, 2.5), 2.11), tailCut(dip, 1.8, 2.5));
  // No envelope: conservative timestamp pads, clamped to the gap.
  check("headCut: no envelope -> timestamp lead pad", approx(headCut(null, 1.8, 2.5), 2.5 - FALLBACK_LEAD_SEC));
  check("tailCut: no envelope -> timestamp tail pad", approx(tailCut(null, 1.8, 2.5), 1.8 + FALLBACK_TAIL_SEC));
  check("headCut: no envelope, tiny gap -> never before the previous word", approx(headCut(null, 2.45, 2.5), 2.45));
  // Overlapping timestamps (Scribe glitch) still yield a point between them.
  const ov = headCut(env, 2.5, 2.4);
  check("headCut: overlapping timestamps -> a point near them", ov >= 2.37 && ov <= 2.53, ov);
}

// --- planCutSpans: the "cuts through the first letters" bug ---
const tile = (index, inS, outS, o = {}) => ({
  index, mediaPath: "/rec.MP4", trackType: "audio", trackIndex: 0,
  sourceInSec: inS, sourceOutSec: outS,
  sourceSpeechInSec: o.speechIn != null ? o.speechIn : null,
  sourceSpeechOutSec: o.speechOut != null ? o.speechOut : null,
  wordCount: o.wordCount != null ? o.wordCount : (o.speechIn != null ? 2 : 0),
  decision: o.decision || "keep", protected: !!o.protected,
});
{
  const env = envelope([[0.95, 1.95], [2.35, 3.2]]);
  const envelopes = { "/rec.mp4": env };
  // One clip [0,4]: L "one two" (Scribe 1.0..1.8) then R "three four" (Scribe 2.5..3.2); tiles split at R's first word.
  const L = () => tile(0, 0, 2.5, { speechIn: 1.0, speechOut: 1.8 });
  const R = () => tile(1, 2.5, 4.0, { speechIn: 2.5, speechOut: 3.2 });

  // Cut L, keep R: the cut must END 120 ms before R's real onset, not at R's tile edge (2.5).
  const a = planCutSpans([{ ...L(), decision: "cut" }, R()], { envelopes });
  check("plan: cut before a keep ends ahead of the real onset", a.length === 1 && approx(a[0].start, 0) && approx(a[0].end, 2.35 - DEFAULT_MARGIN_BEFORE_SEC) && a[0].kind === "cut", a);

  // Keep L, cut R: the cut must START 120 ms after L's real word end, not at R's tile edge.
  const b = planCutSpans([L(), { ...R(), decision: "cut" }], { envelopes });
  check("plan: cut after a keep starts behind the real word end", b.length === 1 && approx(b[0].start, 1.95 + DEFAULT_MARGIN_AFTER_SEC) && approx(b[0].end, 4.0), b);

  // Without an envelope the timestamp fallbacks apply.
  const c = planCutSpans([{ ...L(), decision: "cut" }, R()], {});
  check("plan: no envelope -> lead pad before the timestamp", c.length === 1 && approx(c[0].end, 2.5 - FALLBACK_LEAD_SEC), c);

  // A protected neighbour keeps its whole tile: the cut stays on the tile edge.
  const d = planCutSpans([{ ...L(), protected: true }, { ...R(), decision: "cut" }], { envelopes });
  check("plan: protected neighbour -> cut on the tile edge", d.length === 1 && approx(d[0].start, 2.5), d);

  // Both cut: one merged span over the whole clip.
  const e = planCutSpans([{ ...L(), decision: "cut" }, { ...R(), decision: "cut" }], { envelopes });
  check("plan: consecutive cuts become one span", e.length === 1 && approx(e[0].start, 0) && approx(e[0].end, 4.0), e);

  // Nothing marked: nothing planned.
  check("plan: no marks -> no spans", planCutSpans([L(), R()], { envelopes }).length === 0);

  // Segments on separate clips (source gap) never borrow air across the gap.
  const far = tile(2, 6.0, 8.0, { speechIn: 6.2, speechOut: 7.5, decision: "cut" });
  const f = planCutSpans([L(), R(), far], { envelopes });
  check("plan: a cut on another clip starts on its own tile edge", f.length === 1 && approx(f[0].start, 6.0) && approx(f[0].end, 8.0), f);
}

// --- planCutSpans: "Remove pauses" ---
{
  const env = envelope([[0.95, 1.95], [3.35, 4.2]]);
  const envelopes = { "/rec.mp4": env };
  const K1 = tile(0, 0, 3.5, { speechIn: 1.0, speechOut: 1.8 });
  const K2 = tile(1, 3.5, 5.0, { speechIn: 3.5, speechOut: 4.2 });
  const ex = planCutSpans([K1, K2], { envelopes, trimPauses: true });
  const head = ex.find((s) => approx(s.start, 0));
  const mid = ex.find((s) => approx(s.start, 1.95 + DEFAULT_MARGIN_AFTER_SEC));
  const tail = ex.find((s) => approx(s.end, 5.0));
  check("pauses: head air before the first sentence", head && approx(head.end, 0.95 - DEFAULT_MARGIN_BEFORE_SEC) && head.kind === "pause", ex);
  check("pauses: the pause between two sentences shrinks to the two margins", mid && approx(mid.end, 3.35 - DEFAULT_MARGIN_BEFORE_SEC), ex);
  check("pauses: trailing air after the last sentence", tail && approx(tail.start, 4.2 + DEFAULT_MARGIN_AFTER_SEC), ex);
  check("pauses: exactly three spans", ex.length === 3, ex.length);
  // The user's setting gates it: a 0.4 s pause is cut at the 250 ms default and left alone at 500 ms.
  const short = envelope([[0.95, 1.95], [2.35, 3.2]]);
  const two = [tile(0, 0, 2.5, { speechIn: 1.0, speechOut: 1.8 }), tile(1, 2.5, 3.3, { speechIn: 2.5, speechOut: 3.2 })];
  const cut04 = planCutSpans(two, { envelopes: { "/rec.mp4": short }, trimPauses: true }).find((s) => s.start > 1.5 && s.end < 3.0);
  check("pauses: a 0.4 s pause is trimmed to the margins at the default setting", cut04 && approx(cut04.start, 2.07) && approx(cut04.end, 2.23), cut04);
  check("pauses: raising the setting to 500 ms leaves it alone", !planCutSpans(two, { envelopes: { "/rec.mp4": short }, trimPauses: true, pauseMinSec: 0.5 }).some((s) => s.start > 1.5 && s.end < 3.0));
  // A pause INSIDE a sentence (between two words of one segment) counts too.
  const w = (text, start, end) => ({ type: "word", text, start, end });
  const inner = envelope([[0.95, 1.35], [2.45, 2.85]]);
  const one = tile(0, 0, 3.0, { speechIn: 1.0, speechOut: 2.8, wordCount: 2 });
  const ip = planCutSpans([one], { envelopes: { "/rec.mp4": inner }, wordsByMedia: { "/rec.mp4": [w("one", 1.0, 1.3), w("two", 2.5, 2.8)] }, trimPauses: true });
  const mids = ip.find((s) => s.start > 1.3 && s.end < 2.5);
  check("pauses: a pause between two words of one sentence is trimmed", mids && approx(mids.start, 1.35 + DEFAULT_MARGIN_AFTER_SEC) && approx(mids.end, 2.45 - DEFAULT_MARGIN_BEFORE_SEC) && mids.kind === "pause", ip);
  // Breathy gap with no quiet under the threshold: nothing is trimmed (no real pause found).
  const breathy = envelope([[0.95, 1.35], [1.35, 2.45, -30], [2.45, 2.85]]);
  check("pauses: a gap that never goes quiet is not a pause", !planCutSpans([one], { envelopes: { "/rec.mp4": breathy }, wordsByMedia: { "/rec.mp4": [w("one", 1.0, 1.3), w("two", 2.5, 2.8)] }, trimPauses: true }).some((s) => s.start > 1.3 && s.end < 2.5));
  // Protected keeps are hands-off; cut tiles are handled by the cut planner, not the pause trim.
  const ex3 = planCutSpans([{ ...K1, protected: true }], { envelopes, trimPauses: true });
  check("pauses: protected keep untouched", ex3.length === 0, ex3);
  check("pauses: off by default", planCutSpans([K1, K2], { envelopes }).length === 0);
}

// --- planCutSpans: "Remove fillers" ---
{
  const w = (text, start, end) => ({ type: "word", text, start, end });
  const words = [w("one", 1.0, 1.3), w("um", 1.5, 1.7), w("two", 2.0, 2.3), w("uh", 2.6, 2.7), w("hmm", 2.8, 2.95), w("three", 3.2, 3.5)];
  const env = envelope([[0.95, 1.35], [1.45, 1.75], [1.95, 2.35], [2.55, 2.75], [2.78, 3.0], [3.15, 3.55]]);
  const seg = tile(0, 0, 4.0, { speechIn: 1.0, speechOut: 3.5, wordCount: 6 });
  const spans = planCutSpans([seg], { envelopes: { "/rec.mp4": env }, wordsByMedia: { "/rec.mp4": words }, removeFillers: true });
  check("fillers: two spans (um; uh+hmm as one)", spans.length === 2 && spans.every((s) => s.kind === "filler"), spans);
  check("fillers: 'um' cut sits in the quiet around it, words untouched", spans[0] && approx(spans[0].start, 1.45) && approx(spans[0].end, 1.95 - DEFAULT_MARGIN_BEFORE_SEC), spans[0]);
  check("fillers: consecutive fillers merge into one span", spans[1] && approx(spans[1].start, 2.35 + DEFAULT_MARGIN_AFTER_SEC) && approx(spans[1].end, 3.15 - DEFAULT_MARGIN_BEFORE_SEC), spans[1]);
  const none = planCutSpans([{ ...seg, decision: "cut" }], { wordsByMedia: { "/rec.mp4": words }, removeFillers: true });
  check("fillers: a cut segment is cut wholesale, no filler spans", none.length === 1 && none[0].kind === "cut", none);
  const prot = planCutSpans([{ ...seg, protected: true }], { wordsByMedia: { "/rec.mp4": words }, removeFillers: true });
  check("fillers: protected segments untouched", prot.length === 0, prot);
  check("fillers: off by default", planCutSpans([seg], { wordsByMedia: { "/rec.mp4": words } }).length === 0);
  const fs = fillerStats(words, seg);
  check("fillerStats: counts + seconds", fs.count === 3 && approx(fs.sec, 0.45, 0.001), fs);
  // A filler at the head of a keep that follows a cut folds into the cut span.
  const words2 = [w("bad", 0.5, 0.9), w("um", 1.5, 1.7), w("good", 2.0, 2.3)];
  const env2 = envelope([[0.45, 0.95], [1.45, 1.75], [1.95, 2.35]]);
  const both = planCutSpans(
    [tile(0, 0, 1.5, { speechIn: 0.5, speechOut: 0.9, decision: "cut" }), tile(1, 1.5, 3.0, { speechIn: 1.5, speechOut: 2.3, wordCount: 2 })],
    { envelopes: { "/rec.mp4": env2 }, wordsByMedia: { "/rec.mp4": words2 }, removeFillers: true }
  );
  check("fillers: head filler merges with the preceding cut", both.length === 1 && both[0].kind === "cut" && approx(both[0].start, 0) && approx(both[0].end, 1.95 - DEFAULT_MARGIN_BEFORE_SEC), both);
}

// --- findUnrecognizedSounds ---
{
  const w = (text, start, end) => ({ type: "word", text, start, end });
  // Words at 1.0-1.8 and 4.0-4.6; a 0.4 s throat clear at 2.6; a 0.1 s click at 3.2; a dropped word at 1.9 (adjacent to speech).
  const env = envelope([[0.95, 1.85], [1.9, 2.2], [2.6, 3.0], [3.2, 3.3], [3.95, 4.65]]);
  const toks = [w("one", 1.0, 1.4), w("two", 1.45, 1.8), w("three", 4.0, 4.6)];
  const s = findUnrecognizedSounds(env, toks, 0, 6);
  check("sounds: the isolated 0.4 s throat clear is found", s.length === 1 && approx(s[0].start, 2.6) && approx(s[0].end, 3.0), s);
  check("sounds: nothing without an envelope", findUnrecognizedSounds(null, toks, 0, 6).length === 0);
  const ev = [...toks, { type: "audio_event", text: "[clears throat]", start: 2.55, end: 3.05 }];
  check("sounds: a sound Scribe already marked as an event is not doubled", findUnrecognizedSounds(env, ev, 0, 6).length === 0);
  check("sounds: window bounds respected", findUnrecognizedSounds(env, toks, 0, 2.5).length === 0);
  // Two bursts 60 ms apart join into one sound.
  const cough = envelope([[0.95, 1.85], [2.6, 2.75], [2.81, 3.0], [3.95, 4.65]]);
  const c = findUnrecognizedSounds(cough, toks, 0, 6);
  check("sounds: close bursts join", c.length === 1 && approx(c[0].start, 2.6) && approx(c[0].end, 3.0), c);
}

// --- mapSpansToTimeline ---
{
  const TPS = Number(TICKS_PER_SECOND);
  const tk = (sec) => String(Math.round(sec * TPS));
  const clip = (id, trackType, trackIndex, inS, outS, tlStart, media = "/rec.MP4") => ({
    id, trackType, trackIndex, mediaPath: media, hasMedia: true,
    start: { seconds: tlStart, ticks: tk(tlStart) }, end: { seconds: tlStart + (outS - inS), ticks: tk(tlStart + (outS - inS)) },
    sourceIn: { seconds: inS, ticks: tk(inS) }, sourceOut: { seconds: outS, ticks: tk(outS) },
  });
  const timeline = {
    sequence: { timebase: String(TPS / 30), frameRate: 30 },
    clips: [clip("A1.0", "audio", 0, 0, 2, 0), clip("A1.1", "audio", 0, 5, 7, 2), clip("A2.0", "audio", 1, 0, 10, 0, "/music.wav")],
  };
  const span = (start, end, o = {}) => ({ mediaPath: "/rec.mp4", trackType: "audio", trackIndex: 0, start, end, kind: "cut", index: 0, ...o });
  const fr = mapSpansToTimeline(timeline, [span(1.5, 5.5)]);
  check("map: a span across a razor lands on both pieces", fr.length === 2 && fr[0].startFrame === 45 && fr[0].endFrame === 60 && fr[1].startFrame === 60 && fr[1].endFrame === 75, fr);
  check("map: footage no longer on the timeline maps to nothing", mapSpansToTimeline(timeline, [span(3, 4)]).length === 0);
  check("map: another track's media is ignored", mapSpansToTimeline(timeline, [span(0, 1, { mediaPath: "/music.wav" })]).length === 0);
  check("map: path comparison is case/slash-insensitive", mapSpansToTimeline(timeline, [span(0, 1, { mediaPath: "\\REC.mp4" })]).length === 1);
  check("map: sub-frame spans drop", mapSpansToTimeline(timeline, [span(1.0, 1.01)]).length === 0);
}

console.log(failures === 0 ? "\nAll cut-plan checks passed." : `\n${failures} cut-plan check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
