import { fileURLToPath } from "node:url";
import { formatTimecode, timecodeToFrames } from "../transcription/timecode.js";

// Thrown by tool handlers for expected, actionable failures. index.js turns
// these (and BridgeErrors) into MCP `isError` content the agent can recover from.
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
}

export function bumpRevision(ctx) {
  ctx.state.revision += 1;
  return ctx.state.revision;
}

// Cooperative cancellation: panel-initiated long ops register an abort token on
// ctx.panelOp; the "cancel" RPC flips it; loops check this between iterations.
export function isAborted(ctx) {
  return !!(ctx.panelOp && ctx.panelOp.aborted);
}

/**
 * Call a host op, self-healing a STALE HOST SCRIPT: if Premiere's ExtendScript
 * engine still has an old premiere.jsx loaded (reopening the panel does not
 * always re-eval ScriptPath), a new op fails with "Unknown action". Hot-patch
 * the live engine via the runScript op ($.evalFile of the repo jsx — the
 * documented reload path) and retry once.
 */
export async function callHostHealing(ctx, action, params, opts) {
  try {
    return await ctx.bridge.callHost(action, params, opts);
  } catch (e) {
    if (!/Unknown action/i.test(e.message || "")) throw e;
    const jsxPath = fileURLToPath(new URL("../../cep-panel/host/premiere.jsx", import.meta.url));
    await ctx.bridge.callHost("runScript", { jsx: `$.evalFile(${JSON.stringify(jsxPath)}); "reloaded"` });
    return await ctx.bridge.callHost(action, params, opts);
  }
}

function ticksToFrame(ticks, timebaseTicks) {
  const t = BigInt(ticks);
  const tb = BigInt(timebaseTicks);
  return Number((t + tb / 2n) / tb);
}

const SPEED_EPSILON = 0.005;

/**
 * Fetch + normalize the live timeline from the host. Returns
 * { sequence, clips, gaps } with derived timecodes, frames, and speed flags.
 */
export async function getTimeline(ctx, params = {}) {
  const raw = await ctx.bridge.callHost("getTimelineState", params);
  if (!raw || !raw.sequence) {
    throw new ToolError(
      "No active sequence. Open a project and a sequence in Premiere, then retry. (No state changed.)"
    );
  }
  const seq = raw.sequence;
  const fps = seq.frameRate;
  const df = !!seq.dropFrame;
  const tb = seq.timebase;
  // Displayed timecodes include the sequence start-TC (zero point) so they
  // match Premiere's ruler. NOTE: this offset is for DISPLAY only — the host's
  // DOM start/end/in/out Time values are timeline-0-relative (no zero point).
  const zpFrames = seq.zeroPointTicks ? ticksToFrame(seq.zeroPointTicks, tb) : 0;

  const addTC = (t) => {
    const frame = ticksToFrame(t.ticks, tb);
    return {
      seconds: t.seconds,
      ticks: t.ticks,
      frame,
      tc: formatTimecode(frame + zpFrames, fps, df),
    };
  };

  const clips = (raw.clips || []).map((c) => {
    const durationSeconds = c.end.seconds - c.start.seconds;
    const sourceSpan = c.outPoint.seconds - c.inPoint.seconds;
    const speed = c.speed != null ? c.speed : durationSeconds > 0 ? sourceSpan / durationSeconds : 1;
    return {
      id: c.id,
      name: c.name,
      track: c.trackType.toUpperCase().charAt(0) + (c.trackIndex + 1),
      trackType: c.trackType,
      trackIndex: c.trackIndex,
      itemIndex: c.itemIndex,
      mediaPath: c.mediaPath || null,
      hasMedia: !!c.mediaPath,
      start: addTC(c.start),
      end: addTC(c.end),
      sourceIn: addTC(c.inPoint),
      sourceOut: addTC(c.outPoint),
      durationSeconds: round3(durationSeconds),
      speed: round3(speed),
      speedIsNormal: Math.abs(speed - 1) < SPEED_EPSILON,
    };
  });

  const gaps = (raw.gaps || []).map((g) => ({
    track: g.trackType.toUpperCase().charAt(0) + (g.trackIndex + 1),
    trackType: g.trackType,
    trackIndex: g.trackIndex,
    start: addTC(g.start),
    end: addTC(g.end),
    durationSeconds: round3(g.end.seconds - g.start.seconds),
  }));

  return {
    sequence: {
      name: seq.name,
      frameRate: round3(fps),
      dropFrame: df,
      timebase: tb,
      zeroPointFrames: zpFrames,
      zeroPointTC: seq.zeroPointTicks ? formatTimecode(ticksToFrame(seq.zeroPointTicks, tb), fps, df) : "00:00:00:00",
      videoTrackCount: seq.videoTrackCount,
      audioTrackCount: seq.audioTrackCount,
      frameSize:
        seq.frameSizeHorizontal && seq.frameSizeVertical
          ? { width: seq.frameSizeHorizontal, height: seq.frameSizeVertical }
          : null,
    },
    clips,
    gaps,
  };
}

export function findClip(timeline, clipId) {
  const clip = timeline.clips.find((c) => c.id === clipId);
  if (!clip) {
    const ids = timeline.clips.map((c) => c.id).join(", ") || "(none)";
    throw new ToolError(
      `No clip "${clipId}" on the timeline. Valid clip ids: ${ids}. Call ppro_get_timeline_state for current state. (No state changed.)`
    );
  }
  return clip;
}

export function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** "m:ss" for compact per-segment listings (tool output + headless AI prompts). */
export function mmss(sec) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

// Resolve a "timecode | seconds | frame" user value to timeline seconds for
// the host. Accepts numbers (seconds), "HH:MM:SS:FF"/"HH:MM:SS;FF", or "123f"
// (frames). Timecodes are read as RULER timecodes, matching what the tools
// emit: the sequence start TC (zeroPointFrames) is subtracted, ";" (or the
// sequence's dropFrame setting) selects drop-frame counting, and the result is
// a frame count divided by the real fps, not wall-clock time (at 29.97 NDF a
// timecode runs 0.1% slower than the clock).
export function resolveToSeconds(value, fps, { dropFrame = false, zeroPointFrames = 0 } = {}) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const fMatch = s.match(/^(\d+)f$/i);
  if (fMatch) return parseInt(fMatch[1], 10) / fps;
  const tcMatch = s.match(/^(\d+):(\d+):(\d+)([:;])(\d+)$/);
  if (tcMatch) {
    const h = Number(tcMatch[1]);
    const m = Number(tcMatch[2]);
    const sec = Number(tcMatch[3]);
    const fr = Number(tcMatch[5]);
    const df = tcMatch[4] === ";" || dropFrame;
    const frames = timecodeToFrames(h, m, sec, fr, fps, df) - zeroPointFrames;
    if (frames < 0) {
      throw new ToolError(
        `Timecode "${value}" is before the sequence start TC. Use the ruler timecodes from ppro_get_timeline_state. (No state changed.)`
      );
    }
    return frames / fps;
  }
  throw new ToolError(`Could not parse time value "${value}". Use seconds (12.5), timecode (00:01:23:10), or frames (370f).`);
}
