import { buildReview } from "../review.js";
import { mmss } from "./util.js";

export default {
  name: "ppro_get_retake_segments",
  description:
    "Transcribe the timeline into indexed sentence segments for retake/duplicate analysis, and return them (index, timecode, text). YOU analyze these yourself: the #1 pattern is SERIAL RESTARTS (the speaker re-starts the same line, getting further each attempt) — keep only the most complete, fluent pass of each run and cut the rest, plus false starts and standalone filler. Segments with NEW content are all keepers, even in a row. Then call ppro_mark_retakes with your decisions. Cached per source file.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      clip_id: { type: "string", description: 'Clip id (e.g. "V1.0") or "all" (default — every video clip with media).' },
      refresh: { type: "boolean", description: "Re-transcribe even if cached (source changed)." },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const review = await buildReview(ctx, { clipId: args.clip_id, refresh: !!args.refresh });
    // Compact one-line-per-segment text keeps the response well under the MCP
    // output cap even for long recordings (a JSON array of objects blows past it).
    // Fragment tags tell you what was already pre-marked: ⟦cut⟧ word-empty
    // pops/breaths auto-marked Cut; ⟦flag⟧ very-short clips needing your call.
    const lines = review.segments
      .map((s) => {
        const tag = s.fragment === "empty" ? " ⟦cut: no speech⟧" : s.fragment === "short" ? " ⟦flag: very short⟧" : "";
        return `[${s.index}] ${mmss(s.startSec)} ${s.text}${tag}`;
      })
      .join("\n");
    return {
      sequence: review.sequence,
      count: review.segments.length,
      pre_marked_cut: review.fragments ? review.fragments.autoCut : 0,
      flagged_short: review.fragments ? review.fragments.flagged : 0,
      skipped: review.skipped && review.skipped.length ? review.skipped : undefined,
      how_to: "Word-empty pops/breaths are already marked Cut (⟦cut⟧). ⟦flag⟧ = very short, your call. For the rest: a RESTART re-attempts the SAME words (often ends mid-word/'-' or is a prefix of a later segment) — of each restart run keep ONLY the most complete, fluent pass and cut the others; a segment with NEW words is a new point and a keeper (several keepers in a row is normal). Cut standalone filler/throat-clears. Reserve keep-when-unsure for genuine content ambiguity, never for plain restarts. Then call ppro_mark_retakes([{index, decision, group, reason}]).",
      segments: lines,
    };
  },
};
