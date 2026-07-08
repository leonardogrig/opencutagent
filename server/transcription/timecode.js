// Timecode / tick math — the single source of truth for mapping transcript
// word times (seconds, relative to the SOURCE media start) onto the Premiere
// timeline. Premiere counts time in exactly 254016000000 ticks per second
// (an integer multiple of every common frame rate and 44.1/48kHz), so we do
// the alignment in integer ticks via BigInt to avoid floating-point drift.

export const TICKS_PER_SECOND = 254016000000n;
const TPS_NUM = 254016000000;

export function secondsToTicks(sec) {
  return BigInt(Math.round(sec * TPS_NUM));
}

export function ticksToSeconds(ticks) {
  return Number(BigInt(ticks)) / TPS_NUM;
}

// Round-half-up BigInt division that tolerates negative numerators.
function bigRoundDiv(n, d) {
  if (d <= 0n) throw new Error("timebase must be positive");
  if (n >= 0n) return Number((n + d / 2n) / d);
  return -Number((-n + d / 2n) / d);
}

/**
 * fps from a timebase (ticks per frame). e.g. 23.976, 29.97, 25, 30, 60.
 */
export function fpsFromTimebase(timebaseTicks) {
  return TPS_NUM / Number(BigInt(timebaseTicks));
}

// NOTE: `clip` here is the normalized clip from tools/util.js getTimeline(),
// which exposes start / sourceIn / sourceOut (each { ticks, seconds }).

/**
 * Map a source-media time (seconds) to a timeline position for a clip.
 * timeline_ticks = clip.start.ticks + (word_ticks - clip.sourceIn.ticks)
 * Returns { ticks (string), seconds, frame }.
 */
export function sourceSecToTimeline(wordSec, clip, timebaseTicks) {
  const startTicks = BigInt(clip.start.ticks);
  const inTicks = BigInt(clip.sourceIn.ticks);
  const wordTicks = secondsToTicks(wordSec);
  const timelineTicks = startTicks + (wordTicks - inTicks);
  const tb = BigInt(timebaseTicks);
  return {
    ticks: timelineTicks.toString(),
    seconds: ticksToSeconds(timelineTicks),
    frame: bigRoundDiv(timelineTicks, tb),
  };
}

/**
 * Map a source-seconds range [a,b] on a clip to a timeline FRAME range,
 * clamped to the clip's visible extent. Returns null if it doesn't overlap.
 */
export function sourceRangeToTimelineFrames(aSec, bSec, clip, timebaseTicks) {
  const lo = Math.max(aSec, clip.sourceIn.seconds);
  const hi = Math.min(bSec, clip.sourceOut.seconds);
  if (hi <= lo) return null;
  const start = sourceSecToTimeline(lo, clip, timebaseTicks);
  const end = sourceSecToTimeline(hi, clip, timebaseTicks);
  if (end.frame <= start.frame) return null;
  return { startFrame: start.frame, endFrame: end.frame, startSeconds: start.seconds, endSeconds: end.seconds };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Non-drop timecode "HH:MM:SS:FF" from a frame number. fps is rounded for the
 * frame field (e.g. 29.97 -> 30 frame slots). Drop-frame display is a v1
 * limitation — see framesToTimecodeDF for the drop variant.
 */
export function framesToTimecode(frame, fps) {
  const nominal = Math.round(fps);
  const f = ((frame % nominal) + nominal) % nominal;
  const totalSec = Math.floor(frame / nominal);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(f)}`;
}

/**
 * Drop-frame timecode "HH:MM:SS;FF" for 29.97 / 59.94 sequences.
 * Standard SMPTE drop-frame algorithm (drops 2 frame-numbers per minute,
 * except every 10th minute).
 */
export function framesToTimecodeDF(frame, fps) {
  const nominal = Math.round(fps); // 30 or 60
  const dropPerMin = nominal === 60 ? 4 : 2;
  const framesPer10Min = nominal * 60 * 10 - 9 * dropPerMin;
  const framesPerMin = nominal * 60 - dropPerMin;
  const d = Math.floor(frame / framesPer10Min);
  const m = frame % framesPer10Min;
  let f = frame;
  if (m > dropPerMin) {
    f += dropPerMin * 9 * d + dropPerMin * Math.floor((m - dropPerMin) / framesPerMin);
  } else {
    f += dropPerMin * 9 * d;
  }
  const fr = f % nominal;
  const s = Math.floor(f / nominal) % 60;
  const mm = Math.floor(f / (nominal * 60)) % 60;
  const hh = Math.floor(f / (nominal * 3600)) % 24;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(s)};${pad2(fr)}`;
}

export function formatTimecode(frame, fps, dropFrame) {
  return dropFrame ? framesToTimecodeDF(frame, fps) : framesToTimecode(frame, fps);
}

/**
 * Inverse of formatTimecode: timecode fields -> frame number. Non-drop counts
 * frames directly; drop-frame applies the standard SMPTE inverse (2 frame
 * numbers skipped per minute, 4 at 59.94, except every 10th minute).
 */
export function timecodeToFrames(h, m, s, fr, fps, dropFrame) {
  const nominal = Math.round(fps);
  let frames = (h * 3600 + m * 60 + s) * nominal + fr;
  if (dropFrame) {
    const dropPerMin = nominal === 60 ? 4 : 2;
    const totalMinutes = h * 60 + m;
    frames -= dropPerMin * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}
