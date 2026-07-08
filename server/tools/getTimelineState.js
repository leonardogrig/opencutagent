import { getTimeline } from "./util.js";

function matchTrack(clipOrGap, filter) {
  if (!filter || filter === "all") return true;
  const f = String(filter).toLowerCase();
  if (f === "video" || f === "audio") return clipOrGap.trackType === f;
  return clipOrGap.track.toLowerCase() === f; // e.g. "v1", "a2"
}

export default {
  name: "ppro_get_timeline_state",
  description:
    "Read the active Premiere sequence: tracks, every clip (with a stable semantic id like \"V1.3\" = 3rd item on video track 1), source media paths, source in/out and timeline positions as timecodes, and any gaps between clips. Call this first; every other tool addresses clips by these ids. Returns a `revision` that increments on each edit.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      response_format: {
        type: "string",
        enum: ["concise", "detailed"],
        description: "concise (default) = ids, names, timeline positions. detailed = also source in/out, media paths, raw ticks.",
      },
      track_filter: {
        type: "string",
        description: 'Optional. "video", "audio", or a track like "V1"/"A2". Omit for all tracks.',
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const detailed = args.response_format === "detailed";
    const timeline = await getTimeline(ctx);

    const clips = timeline.clips
      .filter((c) => matchTrack(c, args.track_filter))
      .map((c) => {
        const base = {
          id: c.id,
          track: c.track,
          name: c.name,
          start: c.start.tc,
          end: c.end.tc,
          durationSeconds: c.durationSeconds,
        };
        if (!c.speedIsNormal) base.speed = `${c.speed}x (non-100% — not editable by transcript tools in v1)`;
        if (!c.hasMedia) base.note = "no source media file (synthetic/offline)";
        if (detailed) {
          base.sourceIn = c.sourceIn.tc;
          base.sourceOut = c.sourceOut.tc;
          base.mediaPath = c.mediaPath;
          base.startTicks = c.start.ticks;
          base.startFrame = c.start.frame;
        }
        return base;
      });

    const gaps = timeline.gaps
      .filter((g) => matchTrack(g, args.track_filter))
      .map((g) => ({ track: g.track, start: g.start.tc, end: g.end.tc, durationSeconds: g.durationSeconds }));

    return {
      sequence: timeline.sequence,
      revision: ctx.state.revision,
      clipCount: clips.length,
      gapCount: gaps.length,
      clips,
      gaps,
    };
  },
};
