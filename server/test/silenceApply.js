// Checks for the silence apply path (no ffmpeg/Premiere): source-second ranges
// map to the right timeline frames, apply right-to-left, and mode → ripple/mute.
import { resolveRangesToFrames, applySilenceRanges, computeRangesForSession, framesToCutList, mergeFrameRanges } from "../silences.js";
import { TICKS_PER_SECOND } from "../transcription/timecode.js";

const TPS = Number(TICKS_PER_SECOND);
let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

// One 30fps video clip: source [10s,40s] sits at timeline 5s (so src t → tl t-5).
const tb = String(TPS / 30);
const t = (sec) => ({ ticks: String(Math.round(sec * TPS)), seconds: sec });
const RAW_TIMELINE = {
  sequence: { name: "Seq", timebase: tb, frameRate: 30, zeroPointTicks: "0", dropFrame: false, videoTrackCount: 1, audioTrackCount: 1 },
  clips: [
    { id: "V1.0", name: "clip", trackType: "video", trackIndex: 0, itemIndex: 0, mediaPath: "/x.mov",
      start: t(5), end: t(35), inPoint: t(10), outPoint: t(40) },
  ],
  gaps: [],
};

function makeCtx() {
  const calls = [];
  return {
    calls,
    bridge: {
      callHost: async (action, params) => {
        if (action === "getTimelineState") return RAW_TIMELINE;
        calls.push({ action, ...params });
        return { ok: true };
      },
      notifyPanel: () => {},
    },
    state: { revision: 0 },
    cacheDir: "/tmp",
  };
}

// src 15→tl 10s→frame 300 ; src 16→tl 11s→frame 330 ; src 20→450 ; src 21→480
const ranges = [
  { clipId: "V1.0", srcStart: 15, srcEnd: 16 },
  { clipId: "V1.0", srcStart: 20, srcEnd: 21 },
  { clipId: "NOPE", srcStart: 1, srcEnd: 2 }, // unknown clip → dropped
];

// --- frame resolution ---
const ctx0 = makeCtx();
const { frames } = await resolveRangesToFrames(ctx0, ranges);
check("resolves 2 of 3 ranges (unknown dropped)", frames.length === 2, frames);
check("range 15-16s → frames 300-330", frames.some((f) => f.startFrame === 300 && f.endFrame === 330), frames);
check("range 20-21s → frames 450-480", frames.some((f) => f.startFrame === 450 && f.endFrame === 480), frames);

// --- cut list (sorted ascending, with timecodes) ---
const cl = framesToCutList(frames, RAW_TIMELINE.sequence);
check("cut list count 2", cl.count === 2, cl);
check("cut list ascending by frame", cl.cutList[0].from === "00:00:10:00", cl.cutList);
check("cut list total ~2s", Math.abs(cl.totalRemovedSeconds - 2) < 1e-6, cl);

// --- apply: remove → batched lift-delete + ONE close-gaps pass ---
const ctx1 = makeCtx();
const r1 = await applySilenceRanges(ctx1, { ranges, mode: "remove" });
check("remove applies 2", r1.applied === 2, r1);
check("remove batches into one removeRangesBatch", ctx1.calls.filter((c) => c.action === "removeRangesBatch").length === 1, ctx1.calls);
check("batch ranges ascending", ctx1.calls[0].ranges[0].startFrame === 300 && ctx1.calls[0].ranges[1].startFrame === 450, ctx1.calls[0].ranges);
check("remove closes gaps once", ctx1.calls.filter((c) => c.action === "closeRangeGaps").length === 1 && ctx1.calls[1].action === "closeRangeGaps" && ctx1.calls[1].ranges.length === 2, ctx1.calls);
check("remove reports ~2s removed", Math.abs(r1.removedSeconds - 2) < 1e-6, r1);

// --- keepSpaces (lift): batch only, NO close pass ---
const ctx2 = makeCtx();
await applySilenceRanges(ctx2, { ranges, mode: "keepSpaces" });
check("keepSpaces lift-deletes without closing", ctx2.calls.length === 1 && ctx2.calls[0].action === "removeRangesBatch", ctx2.calls);

// --- chunking: chunkSize 1 → one batch call per range, still one close ---
const ctx2b = makeCtx();
await applySilenceRanges(ctx2b, { ranges, mode: "remove", chunkSize: 1 });
check("chunkSize 1 → 2 batch calls + 1 close", ctx2b.calls.filter((c) => c.action === "removeRangesBatch").length === 2 && ctx2b.calls.filter((c) => c.action === "closeRangeGaps").length === 1, ctx2b.calls);
check("close pass covers all processed ranges", ctx2b.calls[2].ranges.length === 2, ctx2b.calls[2]);

// --- stale host self-heal: "Unknown action" → runScript $.evalFile → retry ---
const healCalls = [];
const ctxH = {
  calls: healCalls,
  bridge: {
    callHost: async (action, params) => {
      if (action === "getTimelineState") return RAW_TIMELINE;
      healCalls.push({ action, ...params });
      if (action === "removeRangesBatch" && !healCalls.some((c) => c.action === "runScript")) {
        throw new Error("Unknown action: removeRangesBatch");
      }
      return { ok: true };
    },
    notifyPanel: () => {},
  },
  state: { revision: 0 },
  cacheDir: "/tmp",
};
const rH = await applySilenceRanges(ctxH, { ranges, mode: "remove" });
check("stale host: hot-patches via runScript $.evalFile", healCalls.some((c) => c.action === "runScript" && /evalFile/.test(c.jsx) && /premiere\.jsx/.test(c.jsx)), healCalls);
check("stale host: retries and applies 2", rH.applied === 2, rH);
check("stale host: no errors surfaced after heal", !rH.errors, rH);

// --- mergeFrameRanges: overlaps/adjacent merge, ascending ---
const mm = mergeFrameRanges([{ startFrame: 100, endFrame: 200 }, { startFrame: 50, endFrame: 120 }, { startFrame: 300, endFrame: 310 }, { startFrame: 310, endFrame: 300 }]);
check("mergeFrameRanges merges overlaps + drops invalid", mm.length === 2 && mm[0].startFrame === 50 && mm[0].endFrame === 200 && mm[1].startFrame === 300, mm);

// --- mute → muteRange ---
const ctx3 = makeCtx();
await applySilenceRanges(ctx3, { ranges, mode: "mute" });
check("mute uses muteRange", ctx3.calls.length === 2 && ctx3.calls.every((c) => c.action === "muteRange"), ctx3.calls);

// --- keep → no host calls ---
const ctx4 = makeCtx();
const r4 = await applySilenceRanges(ctx4, { ranges, mode: "keep" });
check("keep mode does nothing", r4.applied === 0 && ctx4.calls.length === 0, r4);

// --- computeRangesForSession tags ranges by clip ---
const silence = {
  settings: { thresholdDb: -36, minSilenceMs: 120, keepTalkMs: 100, marginBeforeMs: 120, marginAfterMs: 120 },
  clips: [{ clipId: "V1.0", hopSec: 0.02, firstWindowSrcSec: 0, db: [...Array(50).fill(-20), ...Array(50).fill(-60), ...Array(50).fill(-20)] }],
};
const sessRanges = computeRangesForSession(silence);
check("session ranges tagged with clipId", sessRanges.length === 1 && sessRanges[0].clipId === "V1.0", sessRanges);
check("session range ~1.12..1.88s", Math.abs(sessRanges[0].srcStart - 1.12) < 1e-9 && Math.abs(sessRanges[0].srcEnd - 1.88) < 1e-9, sessRanges[0]);

console.log(failures === 0 ? "\nAll silence-apply checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
