// Checks for cancellation (abort mid-apply) and one-click undo (snapshot capture
// + restore), with a mock bridge — no ffmpeg/Premiere.
import { applySilenceRanges } from "../silences.js";
import { applyReview } from "../review.js";
import { restoreUndo, hasUndo, snapshotTimeline } from "../undo.js";
import { TICKS_PER_SECOND } from "../transcription/timecode.js";

const TPS = Number(TICKS_PER_SECOND);
let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

const t = (sec) => ({ ticks: String(Math.round(sec * TPS)), seconds: sec });
const RAW = {
  sequence: { name: "Seq", timebase: String(TPS / 30), frameRate: 30, zeroPointTicks: "0", dropFrame: false, videoTrackCount: 1, audioTrackCount: 1 },
  clips: [{ id: "V1.0", name: "clip", trackType: "video", trackIndex: 0, itemIndex: 0, mediaPath: "/x.mov", start: t(5), end: t(35), inPoint: t(10), outPoint: t(40) }],
  gaps: [],
};
function makeCtx(onCall) {
  const calls = [];
  const ctx = {
    calls,
    bridge: { callHost: async (a, p) => { if (a === "getTimelineState") return RAW; calls.push({ a, ...p }); return (onCall && onCall(a, p, ctx)) || { ok: true }; }, notifyPanel: () => {} },
    state: { revision: 0 }, cacheDir: "/tmp",
  };
  return ctx;
}
const ranges = [ { clipId: "V1.0", srcStart: 15, srcEnd: 16 }, { clipId: "V1.0", srcStart: 20, srcEnd: 21 } ];

// --- snapshotTimeline shape ---
const snap = snapshotTimeline({ sequence: RAW.sequence, clips: [{ trackType: "video", trackIndex: 0, mediaPath: "/x.mov", hasMedia: true, speedIsNormal: true, start: { seconds: 5 }, end: { seconds: 35 }, sourceIn: { seconds: 10 }, sourceOut: { seconds: 40 } }] });
check("snapshot keeps media clip", snap.clips.length === 1 && snap.clips[0].inSec === 10 && snap.clips[0].outSec === 40, snap);

// --- cancel mid-apply (silence): abort after the first chunk (chunkSize 1) ---
const ctxC = makeCtx((a, _p, ctx) => { if (a === "removeRangesBatch") { if (!ctx._n) ctx._n = 0; ctx._n++; if (ctx._n === 1) ctx.panelOp.aborted = true; } });
ctxC.panelOp = { aborted: false };
const rc = await applySilenceRanges(ctxC, { ranges, mode: "remove", chunkSize: 1 });
check("cancel: aborted flag set", rc.aborted === true, rc);
check("cancel: applied only 1 of 2", rc.applied === 1, rc);
check("cancel: only one batch call", ctxC.calls.filter((c) => c.a === "removeRangesBatch").length === 1, ctxC.calls);
check("cancel: still closes the applied chunk's gap", ctxC.calls.filter((c) => c.a === "closeRangeGaps").length === 1, ctxC.calls);
check("cancel: still undoable (1 applied)", rc.undoable === true && hasUndo(ctxC), rc);

// --- undo (silence): restore from snapshot, then it's gone ---
const ctxU = makeCtx((a) => (a === "restoreTimeline" ? { ok: true, restoredTracks: 1 } : { ok: true }));
ctxU.panelOp = null;
await applySilenceRanges(ctxU, { ranges, mode: "remove" });
check("undo: captured after apply", hasUndo(ctxU));
const u = await restoreUndo(ctxU);
check("undo: ok + verified", u.ok === true && u.verified === true, u);
check("undo: restoreTimeline got snapshot clips", ctxU.calls.some((c) => c.a === "restoreTimeline" && Array.isArray(c.clips) && c.clips.length === 1), ctxU.calls);
check("undo: one-shot (cleared)", !hasUndo(ctxU));

// --- undo failure path: host says ok:false → keep undo point, route to Cmd+Z ---
const ctxF = makeCtx((a) => (a === "restoreTimeline" ? { ok: false, reason: "timeline changed" } : { ok: true }));
await applySilenceRanges(ctxF, { ranges, mode: "remove" });
const uf = await restoreUndo(ctxF);
check("undo failure: ok=false", uf.ok === false, uf);
check("undo failure: message mentions Cmd+Z", /Cmd\+Z/.test(uf.message), uf);
check("undo failure: undo point retained", hasUndo(ctxF), "cleared");

// --- nothing to undo ---
const ctxN = makeCtx();
let threw = false;
try { await restoreUndo(ctxN); } catch (e) { threw = /Nothing to undo/.test(e.message); }
check("undo: nothing-to-undo rejects", threw);

// --- retake apply captures undo + can abort ---
const ctxR = makeCtx((a, _p, ctx) => { if (a === "removeRangesBatch") { ctx._n = (ctx._n || 0) + 1; if (ctx._n === 1) ctx.panelOp.aborted = true; } });
ctxR.panelOp = { aborted: false };
// source ranges map onto RAW's clip (tl 5s @ src 10s): src 15→frame 300, src 20→frame 450.
ctxR.review = { sequence: "Seq", frameRate: 30, dropFrame: false, segments: [
  { index: 0, startFrame: 300, endFrame: 330, mediaPath: "/x.mov", sourceInSec: 15, sourceOutSec: 16, trackType: "video", trackIndex: 0, decision: "cut", protected: false },
  { index: 1, startFrame: 450, endFrame: 480, mediaPath: "/x.mov", sourceInSec: 20, sourceOutSec: 21, trackType: "video", trackIndex: 0, decision: "cut", protected: false },
] };
const rr = await applyReview(ctxR, { removeGaps: true, chunkSize: 1 });
check("retake: aborted after 1", rr.aborted === true && rr.applied === 1, rr);
check("retake: undoable + captured", rr.undoable === true && hasUndo(ctxR), rr);

console.log(failures === 0 ? "\nAll cancel/undo checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
