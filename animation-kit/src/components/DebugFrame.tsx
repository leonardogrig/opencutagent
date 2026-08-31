import React from "react";
import { AbsoluteFill, Img, getInputProps, staticFile } from "remotion";

/**
 * A real footage frame rendered UNDER a frame-aware overlay so stills show the
 * annotations composited over what is actually on screen. This is the
 * verification layer for "Use frames" jobs: point `src` at an extracted frame
 * (e.g. "frames/<jobId>/t0012.40.png"), render a still at the matching frame
 * number, and check the drawing lands on its target.
 *
 * It renders NOTHING on the server's final render (which passes the
 * { final: true } input prop), so it can safely stay in the scene: the
 * delivered clip keeps full transparency where the footage shows through.
 */
export const DebugFrame: React.FC<{ src: string; opacity?: number }> = ({ src, opacity = 1 }) => {
  const { final } = getInputProps() as { final?: boolean };
  if (final) return null;
  return (
    <AbsoluteFill style={{ opacity }}>
      <Img src={staticFile(src)} style={{ width: "100%", height: "100%" }} />
    </AbsoluteFill>
  );
};
