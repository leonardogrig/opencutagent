import { buildLevels, computeRangesForSession, pushSilenceConfig } from "../silences.js";
import { levelStats, DEFAULT_SETTINGS } from "../audio/silence.js";
import { round3 } from "./util.js";

export default {
  name: "ppro_analyze_audio_levels",
  description:
    "Measure the loudness of the timeline's audio (ffmpeg, NO transcription/API) for the Remove Silences panel, and recommend a Noise Threshold. This powers the panel's \"Suggest threshold\": call it, reason about the level distribution (noise floor vs speech), then pass set_threshold_db with the dB you choose — it is pushed LIVE to the panel and the silence preview updates. Returns per-clip and overall stats (min/median/speech/noise-floor dB) plus how many silences the threshold would cut. Use ppro_remove_silences_by_level to preview/apply cuts.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      clip_id: { type: "string", description: 'Clip id (e.g. "V1.0") or "all" (default — every video clip with media).' },
      refresh: { type: "boolean", description: "Re-extract levels even if cached (use if the source file changed)." },
      set_threshold_db: {
        type: "number",
        description: "The Noise Threshold (dB, negative) YOU decide. Pushed live to the panel. Omit to push the auto-suggested value.",
      },
      min_silence_ms: { type: "integer", description: "Optional: also push 'Remove Silences Longer Than' (ms) to the panel." },
      keep_talk_ms: { type: "integer", description: "Optional: also push 'Keep speech longer than' (ms)." },
      margin_before_ms: { type: "integer", description: "Optional: also push 'Margin before' (ms)." },
      margin_after_ms: { type: "integer", description: "Optional: also push 'Margin after' (ms)." },
      push: { type: "boolean", description: "Push the chosen/suggested settings to the panel. Default true." },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const silence = await buildLevels(ctx, { clipId: args.clip_id, refresh: !!args.refresh });

    const perClip = silence.clips.map((c) => {
      const st = levelStats(c.db);
      return {
        clip: c.clipId,
        track: c.track,
        durationSec: round3(c.sourceOutSec - c.sourceInSec),
        medianDb: st.medianDb,
        speechDb: st.speechDb,
        noiseFloorDb: st.noiseFloorDb,
        suggestedThresholdDb: st.suggestedThresholdDb,
      };
    });

    // Settings to evaluate / push: explicit values override the auto-suggestion.
    const thresholdDb = args.set_threshold_db != null ? args.set_threshold_db : silence.stats.suggestedThresholdDb;
    const settings = {
      thresholdDb,
      ...(args.min_silence_ms != null ? { minSilenceMs: args.min_silence_ms } : {}),
      ...(args.keep_talk_ms != null ? { keepTalkMs: args.keep_talk_ms } : {}),
      ...(args.margin_before_ms != null ? { marginBeforeMs: args.margin_before_ms } : {}),
      ...(args.margin_after_ms != null ? { marginAfterMs: args.margin_after_ms } : {}),
    };

    const ranges = computeRangesForSession(silence, settings);
    const removedSeconds = round3(ranges.reduce((s, r) => s + (r.srcEnd - r.srcStart), 0));

    const pushed = args.push !== false;
    if (pushed) {
      pushSilenceConfig(ctx, {
        settings,
        note: args.set_threshold_db != null ? "Threshold set by Claude." : "Auto-suggested threshold.",
      });
    }

    return {
      sequence: silence.sequence,
      clipsAnalyzed: silence.clips.length,
      skipped: silence.skipped && silence.skipped.length ? silence.skipped : undefined,
      overall: silence.stats,
      perClip,
      chosenThresholdDb: thresholdDb,
      defaults: DEFAULT_SETTINGS,
      atChosenThreshold: { silences: ranges.length, estimatedRemovedSeconds: removedSeconds },
      pushedToPanel: pushed,
      how_to:
        "Look at noiseFloorDb vs speechDb. A good threshold sits a few dB above the noise floor and well below speech. " +
        "Re-call with set_threshold_db to refine the panel's value, or use ppro_remove_silences_by_level to preview/apply.",
    };
  },
};
