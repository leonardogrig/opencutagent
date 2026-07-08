import { getTimeline, findClip, ToolError, bumpRevision, resolveToSeconds } from "./util.js";
import { fpsFromTimebase } from "../transcription/timecode.js";

export default {
  name: "ppro_trim_clip",
  description:
    "Trim a single clip by setting ABSOLUTE new edges (idempotent — safe to retry). Set source_in/source_out to change which part of the source plays; set timeline_start/timeline_end to change where it sits on the timeline. Values may be seconds (12.5), timecode (00:01:23:10), or frames (370f). Provide at least one edge. Returns the clip before/after and the new revision.",
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      clip_id: { type: "string", description: 'Clip id, e.g. "V1.2".' },
      source_in: { type: "string", description: "New source in-point." },
      source_out: { type: "string", description: "New source out-point." },
      timeline_start: { type: "string", description: "New timeline start position." },
      timeline_end: { type: "string", description: "New timeline end position." },
    },
    required: ["clip_id"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const timeline = await getTimeline(ctx);
    // Exact fps from the timebase (frameRate is rounded for display); with the
    // sequence's drop-frame setting and start TC so ruler timecodes read back
    // from ppro_get_timeline_state resolve to the right timeline position.
    const fps = fpsFromTimebase(timeline.sequence.timebase);
    const tcOpts = {
      dropFrame: timeline.sequence.dropFrame,
      zeroPointFrames: timeline.sequence.zeroPointFrames,
    };
    const before = findClip(timeline, args.clip_id);

    const edges = {
      sourceInSec: resolveToSeconds(args.source_in, fps, tcOpts),
      sourceOutSec: resolveToSeconds(args.source_out, fps, tcOpts),
      timelineStartSec: resolveToSeconds(args.timeline_start, fps, tcOpts),
      timelineEndSec: resolveToSeconds(args.timeline_end, fps, tcOpts),
    };
    if (Object.values(edges).every((v) => v == null)) {
      throw new ToolError(
        "Provide at least one of source_in, source_out, timeline_start, timeline_end. (No state changed.)"
      );
    }
    if (!before.speedIsNormal) {
      throw new ToolError(
        `Clip "${before.id}" runs at ${before.speed}x. v1 trims only 100%-speed clips. (No state changed.)`
      );
    }

    const updatedRaw = await ctx.bridge.callHost("trimClip", {
      trackType: before.trackType,
      trackIndex: before.trackIndex,
      itemIndex: before.itemIndex,
      ...edges,
    });

    const revision = bumpRevision(ctx);
    // Re-read just this clip's new position for an accurate after-state.
    const after = (await getTimeline(ctx)).clips.find((c) => c.id === before.id) || null;

    return {
      revision,
      clip: before.id,
      before: { start: before.start.tc, end: before.end.tc, sourceIn: before.sourceIn.tc, sourceOut: before.sourceOut.tc },
      after: after
        ? { start: after.start.tc, end: after.end.tc, sourceIn: after.sourceIn.tc, sourceOut: after.sourceOut.tc }
        : { note: "clip not found after trim — it may have shifted index; call ppro_get_timeline_state" },
      hostResult: updatedRaw,
    };
  },
};
