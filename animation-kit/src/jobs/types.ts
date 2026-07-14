import type React from "react";

/**
 * One entry per animation job, produced by the OpenCutAgent server into
 * `manifest.ts`. The scene component reads its dimensions/fps/duration via
 * Remotion's `useVideoConfig()` — it takes no props.
 */
export type JobEntry = {
  id: string;
  component: React.FC;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
};
