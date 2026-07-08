import { getTimeline, ToolError, bumpRevision, round3 } from "./util.js";
import { transcribeSourceRanges } from "../transcription/transcribe.js";
import { computeCuts } from "../transcription/segments.js";
import { sourceRangeToTimelineFrames, formatTimecode } from "../transcription/timecode.js";
import { applyRangesBatched } from "../silences.js";

export default {
  name: "ppro_remove_silences",
  description:
    "Transcribe the timeline, find silent gaps and/or filler words, and ripple-delete them so clips tighten up (audio + video stay in sync). ALWAYS preview with dry_run:true first to review the proposed cut list, confirm with the user, then apply with dry_run:false. Cuts are padded and snapped to word boundaries so speech isn't clipped. Undo in Premiere with Cmd+Z.",
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      clip_id: { type: "string", description: 'Clip id, or "all" (default) for every media clip.' },
      dry_run: { type: "boolean", description: "If true, return the cut list WITHOUT editing. Default false. Always do this first." },
      remove_silences: { type: "boolean", description: "Remove long silent gaps. Default true." },
      min_silence_ms: { type: "integer", description: "Minimum gap length to cut, in ms. Default 400." },
      remove_fillers: { type: "boolean", description: "Remove filler words (um, uh, ...). Default true." },
      filler_list: { type: "array", items: { type: "string" }, description: "Override the filler word list." },
      pad_ms: { type: "integer", description: "Air left around each kept word, in ms. Default 80." },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const dryRun = args.dry_run === true; // default false; the skill always previews first
    const timeline = await getTimeline(ctx);
    const seq = timeline.sequence;

    let targets;
    if (!args.clip_id || args.clip_id === "all") {
      targets = timeline.clips.filter((c) => c.hasMedia && c.trackType === "video");
      if (targets.length === 0) targets = timeline.clips.filter((c) => c.hasMedia);
    } else {
      const c = timeline.clips.find((x) => x.id === args.clip_id);
      if (!c) throw new ToolError(`No clip "${args.clip_id}". Call ppro_get_timeline_state for valid ids.`);
      targets = [c];
    }
    if (targets.length === 0) throw new ToolError("No media clips to process.");

    const cutOpts = {
      removeSilences: args.remove_silences !== false,
      removeFillers: args.remove_fillers !== false,
      minSilenceSec: (args.min_silence_ms ?? 400) / 1000,
      padSec: (args.pad_ms ?? 80) / 1000,
      ...(args.filler_list ? { fillers: args.filler_list } : {}),
    };

    const ranges = [];
    const skipped = [];
    for (const clip of targets) {
      if (!clip.speedIsNormal) {
        skipped.push({ clip: clip.id, reason: `non-100% speed (${clip.speed}x)` });
        continue;
      }
      const { payload } = await transcribeSourceRanges(
        clip.mediaPath,
        [{ start: clip.sourceIn.seconds, end: clip.sourceOut.seconds }], // only this clip's on-timeline window
        { cacheDir: ctx.cacheDir, refresh: false }
      );
      const cuts = computeCuts(payload.words || [], cutOpts);
      for (const cut of cuts) {
        const r = sourceRangeToTimelineFrames(cut.start, cut.end, clip, seq.timebase);
        if (!r || r.endFrame - r.startFrame < 1) continue;
        ranges.push({
          clip: clip.id,
          startFrame: r.startFrame,
          endFrame: r.endFrame,
          startSec: r.startSeconds,
          endSec: r.endSeconds,
          startTC: formatTimecode(r.startFrame, seq.frameRate, seq.dropFrame),
          endTC: formatTimecode(r.endFrame, seq.frameRate, seq.dropFrame),
          reason: cut.reason,
          ...(cut.text ? { text: cut.text } : {}),
        });
      }
    }

    const totalRemoved = round3(ranges.reduce((s, r) => s + (r.endSec - r.startSec), 0));

    const cutList = ranges
      .slice()
      .sort((a, b) => a.startFrame - b.startFrame)
      .map((r) => ({ clip: r.clip, from: r.startTC, to: r.endTC, seconds: round3(r.endSec - r.startSec), reason: r.reason, ...(r.text ? { text: r.text } : {}) }));

    if (ranges.length === 0) {
      return { revision: ctx.state.revision, applied: false, cuts: 0, message: "No silences or fillers matched the thresholds." };
    }

    if (dryRun) {
      return {
        revision: ctx.state.revision,
        applied: false,
        dryRun: true,
        cuts: cutList.length,
        totalRemovedSeconds: totalRemoved,
        skipped,
        cutList,
        note: "Preview only — nothing changed. Confirm with the user, then call again with dry_run:false.",
      };
    }

    // Batched razor→lift→close (see applyRangesBatched) — one ripple per range
    // was O(ranges × clips) and took ~30 min on a 2h timeline.
    const res = await applyRangesBatched(ctx, ranges, { ripple: true, fps: seq.frameRate, timeline });
    const appliedCount = res.applied;
    const errors = res.errors;
    const revision = bumpRevision(ctx);
    if (res.rebuild) {
      return {
        revision,
        applied: true,
        rebuild: true,
        sequenceName: res.sequenceName,
        cuts: appliedCount,
        totalRemovedSeconds: totalRemoved,
        skipped,
        note: `Created tightened sequence "${res.sequenceName}" with ${appliedCount} cuts removed. Original sequence untouched — delete the new one to discard.`,
      };
    }

    return {
      revision,
      applied: true,
      cuts: appliedCount,
      totalRemovedSeconds: totalRemoved,
      skipped,
      errors: errors.length ? errors : undefined,
      note: errors.length
        ? `Applied ${appliedCount}/${ranges.length} cuts; ${errors.length} failed (see errors). Cmd+Z to undo.`
        : `Applied ${appliedCount} cuts. Review in Premiere; Cmd+Z to undo.`,
    };
  },
};
