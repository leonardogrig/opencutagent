import { buildLevels, computeRangesForSession, resolveRangesToFrames, framesToCutList, applySilenceRanges, pushSilenceConfig } from "../silences.js";
import { round3 } from "./util.js";

const MODE_MAP = { remove: "remove", keep_spaces: "keepSpaces", mute: "mute" };

export default {
  name: "ppro_remove_silences_by_level",
  description:
    "Loudness-based silence removal (the Remove Silences panel, driven from chat): measure audio levels with ffmpeg (NO transcription), find spans below the Noise Threshold, and ripple-delete them. Controls mirror the panel — threshold_db, min_silence_ms, keep_talk_ms, margin_before_ms, margin_after_ms. ALWAYS preview with dry_run:true first (returns the cut list), confirm, then dry_run:false. mode: 'remove' (close gaps), 'keep_spaces' (leave gaps), 'mute' (silence, keep picture). Undo with Cmd+Z.",
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      clip_id: { type: "string", description: 'Clip id, or "all" (default) for every video clip with media.' },
      dry_run: { type: "boolean", description: "If true, return the cut list WITHOUT editing. Default true — always preview first." },
      threshold_db: { type: "number", description: "Noise Threshold in dB (negative). Default: auto-estimated from the audio." },
      min_silence_ms: { type: "integer", description: "Remove Silences Longer Than (ms). Default 120." },
      keep_talk_ms: { type: "integer", description: "Keep speech longer than (ms) — speech islands shorter than this merge into silence (unconditional, AutoCut semantics). Default 400." },
      margin_before_ms: { type: "integer", description: "Air kept before the next speech (ms). Default 120." },
      margin_after_ms: { type: "integer", description: "Air kept after the previous speech (ms). Default 120." },
      mode: { type: "string", enum: ["remove", "keep_spaces", "mute"], description: "remove (ripple, default), keep_spaces (lift), or mute." },
      refresh: { type: "boolean", description: "Re-extract levels even if cached." },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const dryRun = args.dry_run !== false; // default true; preview before cutting
    const silence = await buildLevels(ctx, { clipId: args.clip_id, refresh: !!args.refresh });

    const settings = {
      ...(args.threshold_db != null ? { thresholdDb: args.threshold_db } : { thresholdDb: silence.stats.suggestedThresholdDb }),
      ...(args.min_silence_ms != null ? { minSilenceMs: args.min_silence_ms } : {}),
      ...(args.keep_talk_ms != null ? { keepTalkMs: args.keep_talk_ms } : {}),
      ...(args.margin_before_ms != null ? { marginBeforeMs: args.margin_before_ms } : {}),
      ...(args.margin_after_ms != null ? { marginAfterMs: args.margin_after_ms } : {}),
    };
    const mode = MODE_MAP[args.mode] || "remove";

    const ranges = computeRangesForSession(silence, settings);
    pushSilenceConfig(ctx, { settings }); // keep the panel in sync with this run

    if (ranges.length === 0) {
      return { revision: ctx.state.revision, applied: false, cuts: 0, thresholdDb: settings.thresholdDb, message: "No silences matched the threshold/duration settings." };
    }

    const { seq, frames } = await resolveRangesToFrames(ctx, ranges);
    const preview = framesToCutList(frames, seq);

    if (dryRun) {
      return {
        revision: ctx.state.revision,
        applied: false,
        dryRun: true,
        mode,
        thresholdDb: settings.thresholdDb,
        settings,
        skipped: silence.skipped && silence.skipped.length ? silence.skipped : undefined,
        cuts: preview.count,
        totalRemovedSeconds: preview.totalRemovedSeconds,
        cutList: preview.cutList.length > 200 ? preview.cutList.slice(0, 200) : preview.cutList,
        note:
          (preview.cutList.length > 200 ? `Showing first 200 of ${preview.cutList.length} cuts. ` : "") +
          "Preview only — nothing changed. Confirm with the user, then call again with dry_run:false.",
      };
    }

    const res = await applySilenceRanges(ctx, { ranges, mode }, () => {});
    return {
      revision: res.revision,
      applied: true,
      mode,
      thresholdDb: settings.thresholdDb,
      cuts: res.applied,
      totalRemovedSeconds: round3(res.removedSeconds),
      errors: res.errors,
      note: res.message,
    };
  },
};
