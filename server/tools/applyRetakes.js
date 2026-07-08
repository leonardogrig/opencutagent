import { applyReview } from "../review.js";

export default {
  name: "ppro_apply_retakes",
  description:
    "Apply the current Keep/Cut marks to the timeline: ripple/lift-delete every Cut (non-protected) segment, right-to-left. remove_gaps:true closes the gaps (ripple); false leaves them (lift). Destructive — confirm with the user first. Undo with Cmd+Z in Premiere.",
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      remove_gaps: { type: "boolean", description: "Close the gaps left by cuts (ripple) vs leave them (lift). Default false." },
      trim_excess: {
        type: "boolean",
        description:
          "Also cut the non-speech air inside KEPT speech segments (leading/trailing dead air around the words, ~0.15s pad kept), leaving only the spoken spans. Default false.",
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const res = await applyReview(ctx, { removeGaps: args.remove_gaps === true, trimExcess: args.trim_excess === true });
    let message;
    if (res.requested === 0) {
      message =
        res.cutsMarked === 0
          ? "No segments are marked Cut" +
            (args.trim_excess === true ? " and no excess non-speech was found to trim." : "; nothing applied. Mark cuts with ppro_mark_retakes first.")
          : `All ${res.cutsMarked} Cut segment(s) are already removed from the live timeline (~${res.alreadyGoneSec}s cut earlier). Nothing new to apply; re-run ppro_get_retake_segments if the list looks stale.`;
    } else {
      message =
        `Applied ${res.applied}/${res.requested} cut(s) (~${res.appliedSec}s)${res.ripple ? " and closed the gaps" : " (gaps left in place)"}.` +
        (res.excessSpans ? ` Includes ${res.excessSpans} excess non-speech trim(s) inside keeps.` : "") +
        (res.alreadyGone ? ` ${res.alreadyGone} other cut(s) had already been removed.` : "") +
        " Review in Premiere; verify by re-reading the timeline.";
    }
    return { ...res, message };
  },
};
