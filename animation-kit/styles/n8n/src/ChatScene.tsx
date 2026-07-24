import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Canvas, SketchLayer } from "../../../src/components";
import { SketchRect, SketchCircle, SketchText, SketchPath, SketchLine } from "../../../src/sketch";
import { SCENE, FPS } from "../../../src/theme/timing";
import { EASING } from "../../../src/theme/springs";
import { N8N_MARK_PATH } from "./n8nLogoPaths";
import { n8n } from "./theme";

const PLACEHOLDER = "Ask n8n to build a workflow…";

/**
 * Chat-scene timeline (frames), derived from the prompt length so the scene and
 * its surrounding choreography agree on the timing. Openers type FAST (~110
 * cps) and move on: the opener is setup, not the show.
 */
export const chatTiming = (prompt: string, fps: number = FPS, cps = 110) => {
  const typeStart = SCENE(0.9);
  const typeDur = Math.ceil((prompt.length / cps) * fps);
  const typeEnd = typeStart + typeDur;
  const submit = typeEnd + SCENE(0.35);
  const thinkStart = submit + SCENE(0.2);
  const end = thinkStart + SCENE(1.6);
  return { cps, typeStart, typeEnd, submit, thinkStart, end };
};

const INPUT = { x: 360, y: 410, w: 1200, h: 210, r: 28 };

/**
 * The n8n AI-builder chat, drawn in the HAND-DRAWN brand style so it skeletons
 * on like everything else: the input box and buttons self-draw, the prompt
 * types in Excalifont, then a hand-drawn "thinking" row. Authored in a
 * 1920x1080 design space and scaled to the composition width.
 */
export const ChatScene: React.FC<{ prompt: string; dotGrid?: boolean; bg?: boolean; cps?: number }> = ({
  prompt,
  dotGrid = true,
  bg = true,
  cps = 110,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const T = chatTiming(prompt, fps, cps);
  const k = width / 1920; // design space -> composition pixels

  // typewriter (string-slice) with a blinking cursor
  const chars = Math.floor((Math.max(0, frame - T.typeStart) / fps) * T.cps);
  const blink = frame % Math.round(fps * 0.5) < Math.round(fps * 0.25);
  const showCursor = frame >= T.typeStart && frame < T.submit;
  const typed = prompt.slice(0, chars) + (showCursor && blink ? "|" : "");

  // greeting mark: grows in (movement, not a fade)
  const markScale = interpolate(frame, [0, SCENE(0.5)], [0.4, 1], {
    easing: EASING.overshoot,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // send button press on submit
  const sendScale = interpolate(frame, [T.submit - 4, T.submit, T.submit + 10], [1, 1.22, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const cxSend = INPUT.x + INPUT.w - 62;
  const cySend = INPUT.y + INPUT.h - 52;
  const cxPlus = INPUT.x + 52;

  const content = (
    <SketchLayer>
      <g transform={`scale(${k})`}>
        {/* greeting */}
        <g transform={`translate(547 298) scale(${markScale}) translate(-547 -298)`}>
          <g transform="translate(500 272) scale(0.62)">
            <path d={N8N_MARK_PATH} fill={n8n.color.accent} fillRule="evenodd" clipRule="evenodd" />
          </g>
        </g>
        <SketchText x={1040} y={300} anchor="middle" size={52} color={n8n.color.chatGreeting} delay={4}>
          What should we automate?
        </SketchText>

        {/* input box */}
        <SketchRect
          x={INPUT.x}
          y={INPUT.y}
          width={INPUT.w}
          height={INPUT.h}
          radius={INPUT.r}
          seed={71}
          fill={n8n.color.surface}
          fillStyle="solid"
          stroke={n8n.color.ink}
          strokeWidth={n8n.stroke.thin}
          drawIn={{ delay: SCENE(0.2), duration: SCENE(0.7) }}
        />

        {/* typed prompt / placeholder */}
        <SketchText x={INPUT.x + 42} y={INPUT.y + 72} anchor="start" size={38} color={n8n.color.inkWhite} font={n8n.font.hand}>
          {frame < T.typeStart ? "" : typed}
        </SketchText>
        {frame < T.typeStart ? (
          <SketchText x={INPUT.x + 42} y={INPUT.y + 72} anchor="start" size={38} color={n8n.color.chatPlaceholder}>
            {PLACEHOLDER}
          </SketchText>
        ) : null}

        {/* "+" */}
        <SketchCircle cx={cxPlus} cy={cySend} r={24} seed={72} stroke={n8n.color.inkMuted} strokeWidth={n8n.stroke.thin} drawIn={{ delay: SCENE(0.5), duration: SCENE(0.5) }} />
        <SketchLine x1={cxPlus - 10} y1={cySend} x2={cxPlus + 10} y2={cySend} seed={73} stroke={n8n.color.inkMuted} strokeWidth={n8n.stroke.thin} drawIn={{ delay: SCENE(0.6), duration: SCENE(0.3) }} />
        <SketchLine x1={cxPlus} y1={cySend - 10} x2={cxPlus} y2={cySend + 10} seed={74} stroke={n8n.color.inkMuted} strokeWidth={n8n.stroke.thin} drawIn={{ delay: SCENE(0.6), duration: SCENE(0.3) }} />

        {/* send button */}
        <g transform={`translate(${cxSend} ${cySend}) scale(${sendScale}) translate(${-cxSend} ${-cySend})`}>
          <SketchCircle cx={cxSend} cy={cySend} r={30} seed={75} stroke={n8n.color.accent} fill={n8n.color.accent} fillStyle="solid" drawIn={{ delay: SCENE(0.5), duration: SCENE(0.5) }} />
          <SketchPath
            d={`M ${cxSend} ${cySend + 13} L ${cxSend} ${cySend - 13} M ${cxSend - 9} ${cySend - 4} L ${cxSend} ${cySend - 13} L ${cxSend + 9} ${cySend - 4}`}
            seed={76}
            stroke={n8n.color.inkWhite}
            strokeWidth={n8n.stroke.thin}
            drawIn={{ delay: SCENE(0.7), duration: SCENE(0.4) }}
          />
        </g>

        {/* thinking */}
        {frame >= T.thinkStart - 4 ? (
          <g>
            {[0, 1, 2].map((i) => {
              const o = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((frame / fps) * Math.PI * 2 * 1.1 - i * 0.9));
              return <SketchCircle key={i} cx={792 + i * 26} cy={712} r={7} seed={95 + i} stroke={n8n.color.accent} fill={n8n.color.accent} fillStyle="solid" opacity={o} drawIn={{ delay: T.thinkStart, duration: SCENE(0.3) }} />;
            })}
            <SketchText x={858} y={712} anchor="start" size={28} color={n8n.color.chatThinking} delay={T.thinkStart}>
              Building your workflow…
            </SketchText>
          </g>
        ) : null}
      </g>
    </SketchLayer>
  );

  return bg ? <Canvas bg={n8n.color.bg} dotGrid={dotGrid}>{content}</Canvas> : content;
};
