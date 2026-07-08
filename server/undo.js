// One-shot "undo the last apply" — restore the timeline to exactly how it was
// before the most recent Cut-and-Delete-Silences or Apply-All.
//
// Premiere's ExtendScript has no programmatic undo, so we snapshot the timeline
// (every media clip's track, position, and source in/out) BEFORE an apply, and
// reconstruct it on demand: the host removes the leftover pieces and resizes the
// survivors back to the originals using the same proven in/out/start/end setters
// trimClip uses. The host PRE-VALIDATES and bails without touching anything if it
// can't restore cleanly (clips it can't match, or the timeline changed since the
// apply), and the result is verified here — with Cmd+Z always available as the
// guaranteed fallback.
import { getTimeline } from "./tools/util.js";

/** Capture the pre-apply timeline so it can be restored later. */
export function snapshotTimeline(timeline) {
  return {
    sequenceName: timeline.sequence.name,
    clips: timeline.clips
      .filter((c) => c.hasMedia)
      .map((c) => ({
        trackType: c.trackType,
        trackIndex: c.trackIndex,
        mediaPath: c.mediaPath,
        startSec: c.start.seconds,
        endSec: c.end.seconds,
        inSec: c.sourceIn.seconds,
        outSec: c.sourceOut.seconds,
        speedIsNormal: c.speedIsNormal,
      })),
  };
}

/** Store an undo point on ctx (overwrites any previous one — one level deep). */
export function captureUndo(ctx, kind, timeline, meta = {}) {
  ctx.undo = { kind, snapshot: snapshotTimeline(timeline), meta };
  return ctx.undo;
}

export function hasUndo(ctx) {
  return !!(ctx.undo && ctx.undo.snapshot && ctx.undo.snapshot.clips.length);
}

/**
 * Restore the timeline from the captured snapshot. Returns {ok, verified, ...}.
 * Leaves ctx.undo in place on failure (so the button stays and Cmd+Z is still an
 * option); clears it on success.
 */
export async function restoreUndo(ctx) {
  if (!hasUndo(ctx)) throw new Error("Nothing to undo.");
  const { snapshot: snap, kind } = ctx.undo;

  // The in/out/start/end setters can't faithfully rebuild speed-changed clips.
  if (snap.clips.some((c) => c.speedIsNormal === false)) {
    return { ok: false, kind, message: "Can't auto-undo a sequence with speed-changed clips. Press Cmd+Z in Premiere." };
  }

  let res;
  try {
    res = await ctx.bridge.callHost("restoreTimeline", { clips: snap.clips }, { timeoutMs: 60000 });
  } catch (e) {
    return { ok: false, kind, message: `Auto-undo failed: ${e.message}. Press Cmd+Z in Premiere to undo the cuts.` };
  }
  if (!res || !res.ok) {
    return { ok: false, kind, reason: res && res.reason, message: `Couldn't auto-undo (${(res && res.reason) || "the timeline changed since the apply"}). Press Cmd+Z in Premiere.` };
  }

  let verified = false;
  try {
    const after = await getTimeline(ctx);
    verified = after.clips.filter((c) => c.hasMedia).length === snap.clips.length;
  } catch {
    /* verification is best-effort */
  }

  ctx.undo = null; // one-shot
  ctx.state.revision += 1;
  return {
    ok: true,
    verified,
    kind,
    restoredTracks: res.restoredTracks,
    revision: ctx.state.revision,
    message: verified
      ? "Reverted the timeline to before the last apply."
      : "Restored the timeline. Quickly verify it looks right (Cmd+Z in Premiere if anything is off).",
  };
}
