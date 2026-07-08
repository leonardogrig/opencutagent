import { markDecisions } from "../review.js";

export default {
  name: "ppro_mark_retakes",
  description:
    "Record YOUR keep/cut decisions for the segments from ppro_get_retake_segments. This updates the panel live (the user sees the Keep/Cut marks and retake groups) but does NOT edit the timeline. After the user reviews, apply with ppro_apply_retakes or have them click “Apply All” in the panel. Protected segments are never changed.",
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      decisions: {
        type: "array",
        description: "One entry per segment you want to set.",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "Segment index from ppro_get_retake_segments." },
            decision: { type: "string", enum: ["keep", "cut"] },
            group: { type: "integer", description: "Optional retake-group id shared by takes of the same line (colors the panel dots)." },
            reason: { type: "string", description: "Optional short reason (e.g. 'retake of #4', 'false start')." },
          },
          required: ["index", "decision"],
          additionalProperties: false,
        },
      },
    },
    required: ["decisions"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const summary = markDecisions(ctx, args.decisions || []);
    return {
      ...summary,
      message: `Marked ${summary.cut} cut / ${summary.keep} keep (shown in the panel). Apply with ppro_apply_retakes or the panel's Apply All.`,
    };
  },
};
