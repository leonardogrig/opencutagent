import "./theme/fonts"; // side-effect: load Excalifont + Inter
import React from "react";
import { Composition } from "remotion";
import { jobs } from "./jobs/manifest";

/**
 * Every registered composition is an animation job scaffolded by the
 * OpenCutAgent server (see src/jobs/manifest.ts). Dimensions, fps and duration
 * come from the Premiere sequence and the selected timeline range — they are
 * fixed per job and must not be changed by hand.
 */
export const RemotionRoot: React.FC = () => (
  <>
    {jobs.map((j) => (
      <Composition
        key={j.id}
        id={j.id}
        component={j.component}
        fps={j.fps}
        width={j.width}
        height={j.height}
        durationInFrames={j.durationInFrames}
      />
    ))}
  </>
);
