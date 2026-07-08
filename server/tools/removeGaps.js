import { getTimeline, bumpRevision, ToolError } from "./util.js";

export default {
  name: "ppro_remove_gaps",
  description:
    "Close empty gaps between clips (ripple): downstream clips slide left to fill the space. Optionally restrict to a track or to gaps at/above a minimum length. Returns the gaps closed and the new revision. Undo in Premiere with Cmd+Z if needed.",
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      track_filter: { type: "string", description: 'Optional: "video", "audio", or a track like "V1"/"A1". Omit for all.' },
      min_gap_frames: { type: "integer", description: "Only close gaps at least this many frames long. Default 1." },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const before = await getTimeline(ctx);
    const fps = before.sequence.frameRate;
    const minGapSec = ((args.min_gap_frames ?? 1) - 0.5) / fps; // inclusive of the requested frame count

    let trackType = null;
    let trackIndex = null;
    if (args.track_filter && args.track_filter !== "all") {
      const f = String(args.track_filter).toLowerCase();
      if (f === "video" || f === "audio") {
        trackType = f;
      } else {
        const m = f.match(/^([va])(\d+)$/);
        if (!m) {
          // A destructive op must not silently widen to "all tracks" on a typo.
          throw new ToolError(
            `Unrecognized track_filter "${args.track_filter}". Use "video", "audio", or a track like "V1"/"A2", or omit it for all tracks. (No state changed.)`
          );
        }
        trackType = m[1] === "v" ? "video" : "audio";
        trackIndex = parseInt(m[2], 10) - 1;
      }
    }

    const candidates = before.gaps.filter((g) => {
      if (trackType && g.trackType !== trackType) return false;
      if (trackIndex != null && g.trackIndex !== trackIndex) return false;
      return g.durationSeconds >= minGapSec;
    });

    if (candidates.length === 0) {
      return { revision: ctx.state.revision, closed: 0, message: "No gaps matched (nothing to close)." };
    }

    const result = await ctx.bridge.callHost("removeGaps", { trackType, trackIndex, minGapSec });
    const revision = bumpRevision(ctx);

    return {
      revision,
      closed: result && result.count != null ? result.count : candidates.length,
      gaps: (result && result.closed) || candidates.map((g) => ({ track: g.track, at: g.start.tc, durationSeconds: g.durationSeconds })),
    };
  },
};
