import { Config } from "@remotion/cli/config";

// Applies to Remotion Studio + the `remotion` CLI only (NOT the @remotion/renderer Node API).
// PNG (lossless) intermediate frames + a low CRF keep fine hand-drawn text crisp
// through camera motion (JPEG intermediates + high CRF mangle thin strokes on the
// zoom). Quality over file size — these clips land on a Premiere timeline.
Config.setVideoImageFormat("png");
Config.setCrf(14);
Config.setOverwriteOutput(true);
Config.setStillImageFormat("png");

// This project ships SILENT video (narration is added later in the editor).
// No composition contains audio; muting the render is the backstop that
// guarantees no audio track ever ends up in a deliverable.
Config.setMuted(true);

// Keyframe every 30 frames (1s). x264's default GOP is huge, and NLEs (Premiere)
// fail to seek deep into a long GOP: "Error retrieving frame N … substituting" ~30s in.
// Dense keyframes make renders editor-safe; slight size cost is fine for a deliverable.
Config.overrideFfmpegCommand(({ type, args }) => {
  if (type !== "stitcher") return args;
  return [...args.slice(0, -1), "-g", "30", args[args.length - 1]];
});

// Job compositions are created at the Premiere sequence's exact pixel size, so
// no scaling is needed (the server passes explicit flags on final renders anyway).
Config.setScale(1);
