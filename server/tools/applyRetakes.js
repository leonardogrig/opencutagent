import { applyReview } from "../review.js";
import { fmtDur } from "./util.js";

export default {
  name: "ppro_apply_retakes",
  description:
    "Apply the current Keep/Cut marks to the timeline: ripple/lift-delete every Cut (non-protected) segment. Cut points are placed in the quiet between words (loudness-refined, with a margin of air kept around the kept speech), never on a raw word timestamp. remove_gaps:true closes the gaps (ripple); false leaves them (lift). Destructive — confirm with the user first. Undo with Cmd+Z in Premiere.",
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      remove_gaps: { type: "boolean", description: "Close the gaps left by cuts (ripple) vs leave them (lift). Default false." },
      trim_pauses: {
        type: "boolean",
        description:
          "Also shrink every pause (no speech) longer than max_pause_ms inside the KEPT speech, between words as well as between sentences and at clip edges, down to ~0.12s of air on each side. Default false.",
      },
      max_pause_ms: { type: "integer", description: "Pause length that trim_pauses starts cutting at, in milliseconds. Default 250 (or EDITAGENT_PAUSE_MS)." },
      remove_fillers: {
        type: "boolean",
        description: "Also cut filler words (um, uh, er, hmm...) out of KEPT segments, each cut placed in the quiet around the word. Default false.",
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const trimPauses = args.trim_pauses === true;
    const removeFillers = args.remove_fillers === true;
    const pauseMinSec = Number.isInteger(args.max_pause_ms) && args.max_pause_ms >= 0 ? args.max_pause_ms / 1000 : undefined;
    const res = await applyReview(ctx, { removeGaps: args.remove_gaps === true, trimPauses, pauseMinSec, removeFillers });
    let message;
    if (res.requested === 0) {
      const trims = [trimPauses ? "pauses" : null, removeFillers ? "filler words" : null].filter(Boolean);
      message =
        res.cutsMarked === 0
          ? "No segments are marked Cut" +
            (trims.length ? ` and no ${trims.join(" or ")} found to trim.` : "; nothing applied. Mark cuts with ppro_mark_retakes first.")
          : `All ${res.cutsMarked} Cut segment(s) are already removed from the live timeline (~${fmtDur(res.alreadyGoneSec)} cut earlier). Nothing new to apply; re-run ppro_get_retake_segments if the list looks stale.`;
    } else {
      message =
        `Applied ${res.applied}/${res.requested} cut(s) (~${fmtDur(res.appliedSec)})${res.ripple ? " and closed the gaps" : " (gaps left in place)"}.` +
        (res.pauseSpans ? ` Includes ${res.pauseSpans} pause trim(s).` : "") +
        (res.fillerSpans ? ` Includes ${res.fillerSpans} filler word cut(s).` : "") +
        (res.alreadyGone ? ` ${res.alreadyGone} other cut(s) had already been removed.` : "") +
        " Review in Premiere; verify by re-reading the timeline.";
    }
    return { ...res, message };
  },
};
