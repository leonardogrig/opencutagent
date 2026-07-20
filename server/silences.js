// Shared "silence session" state + ops for the Remove Silences tab, used by BOTH
// the panel RPC (analyzeLevels / applySilences) and the MCP tools
// (ppro_analyze_audio_levels / ppro_remove_silences_by_level) — the same way
// review.js is shared by the retake panel and tools.
//
// Loudness is measured from the source media (ffmpeg, no transcription). The
// panel computes the red "Silence" ranges live in JS as the user drags the
// controls; the server maps the final ranges to exact timeline frames (BigInt)
// and applies them via the fast-apply ladder in applyRangesBatched (XML
// round-trip / generated rebuild for big ripple applies, else the batched
// razor-lift-close host ops).
import { getTimeline, round3, ToolError, isAborted, callHostHealing } from "./tools/util.js";
import { hasAudioStream } from "./audio/probe.js";
import { rebuildViaXml } from "./rebuild.js";
import { roundtripViaXml } from "./roundtrip.js";
import { liveEnv } from "./config.js";
import { getLevels, sliceEnvelope } from "./audio/levels.js";
import { detectSilences, levelStats, DEFAULT_SETTINGS, PRESETS } from "./audio/silence.js";
import { sourceRangeToTimelineFrames, formatTimecode } from "./transcription/timecode.js";
import { captureUndo } from "./undo.js";
import { log } from "./log.js";

class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

/** Pick the clips the silence tab operates on (video clips with media, 100% speed). */
function selectClips(timeline, clipId) {
  if (clipId && clipId !== "all") {
    const c = timeline.clips.find((x) => x.id === clipId);
    if (!c) throw new ToolError(`No clip "${clipId}". Call ppro_get_timeline_state for valid ids.`);
    return [c];
  }
  let clips = timeline.clips.filter((c) => c.hasMedia && c.trackType === "video");
  if (clips.length === 0) clips = timeline.clips.filter((c) => c.hasMedia);
  return clips;
}

/**
 * Extract loudness envelopes for the timeline's clips and store the session on
 * ctx.silence. Each entry carries the visible dBFS slice plus the mapping a
 * caller needs to place it on the timeline. Shared by the panel + the tools.
 */
export async function buildLevels(ctx, opts = {}, onProgress = () => {}) {
  onProgress("Reading the timeline…");
  const timeline = await getTimeline(ctx);
  const seq = timeline.sequence;
  const targets = selectClips(timeline, opts.clipId);
  if (targets.length === 0) throw new ToolError("No clips with source media on the timeline.");

  const clips = [];
  const skipped = [];
  const allDb = [];
  let hopSec = 0.02;

  for (const clip of targets) {
    if (isAborted(ctx)) throw new CancelledError();
    if (!clip.speedIsNormal) {
      skipped.push({ clip: clip.id, reason: `non-100% speed (${clip.speed}x)` });
      continue;
    }
    // Silent video (graphics, placed animation renders) has no audio stream:
    // scanning it would kill ffmpeg with "Output file does not contain any stream".
    if (!(await hasAudioStream(clip.mediaPath))) {
      skipped.push({ clip: clip.id, reason: "no audio stream (silent clip)" });
      continue;
    }
    onProgress(`Analyzing loudness: ${clip.mediaPath.split(/[\\\/]/).pop()}…`);
    const { envelope } = await getLevels(clip.mediaPath, { cacheDir: ctx.cacheDir, refresh: !!opts.refresh });
    hopSec = envelope.hopSec;
    const slice = sliceEnvelope(envelope, clip.sourceIn.seconds, clip.sourceOut.seconds);
    for (const d of slice.db) allDb.push(d);
    clips.push({
      clipId: clip.id,
      track: clip.track,
      name: clip.name,
      timelineStartSec: round3(clip.start.seconds),
      timelineEndSec: round3(clip.end.seconds),
      sourceInSec: round3(clip.sourceIn.seconds),
      sourceOutSec: round3(clip.sourceOut.seconds),
      firstWindowSrcSec: round3(slice.firstWindowSrcSec),
      hopSec,
      db: slice.db,
    });
  }
  if (clips.length === 0) {
    throw new ToolError(
      `Nothing to scan: all ${skipped.length} clip(s) were skipped (${[...new Set(skipped.map((s) => s.reason))].join("; ")}).`
    );
  }

  const stats = levelStats(allDb);
  ctx.silence = {
    sequence: seq.name,
    frameRate: seq.frameRate,
    dropFrame: seq.dropFrame,
    hopSec,
    clips,
    stats,
    settings: { ...DEFAULT_SETTINGS, thresholdDb: stats.suggestedThresholdDb },
    skipped,
  };
  return ctx.silence;
}

/** A panel/transport-friendly view (keeps the db arrays — the panel needs them). */
export function levelsForPanel(silence) {
  return {
    sequence: silence.sequence,
    frameRate: silence.frameRate,
    dropFrame: silence.dropFrame,
    hopSec: silence.hopSec,
    clips: silence.clips,
    stats: silence.stats,
    defaults: DEFAULT_SETTINGS,
    presets: PRESETS,
    skipped: silence.skipped && silence.skipped.length ? silence.skipped : undefined,
  };
}

/**
 * Server-side silence detection across all clips in the session (used by the
 * headless tool and for reporting counts). Returns source-second ranges tagged
 * with their clip — the same shape the panel sends back to applySilences.
 */
export function computeRangesForSession(silence, settings = {}) {
  const merged = { ...silence.settings, ...settings };
  const out = [];
  for (const clip of silence.clips) {
    const ranges = detectSilences(clip.db, clip.hopSec, { ...merged, offsetSec: clip.firstWindowSrcSec });
    for (const r of ranges) out.push({ clipId: clip.clipId, srcStart: r.start, srcEnd: r.end });
  }
  return out;
}

/**
 * Map source-second ranges to exact timeline frames against a fetched timeline
 * (BigInt-precise). Pure — invalid/zero-length ranges drop.
 */
export function mapRangesToFrames(timeline, ranges = []) {
  const seq = timeline.sequence;
  const byId = new Map(timeline.clips.map((c) => [c.id, c]));
  const frames = [];
  for (const r of ranges) {
    const clip = byId.get(r.clipId);
    if (!clip) continue;
    const fr = sourceRangeToTimelineFrames(r.srcStart, r.srcEnd, clip, seq.timebase);
    if (!fr || fr.endFrame - fr.startFrame < 1) continue;
    frames.push({
      clipId: r.clipId,
      startFrame: fr.startFrame,
      endFrame: fr.endFrame,
      startSec: round3(fr.startSeconds),
      endSec: round3(fr.endSeconds),
      sec: round3(fr.endSeconds - fr.startSeconds),
    });
  }
  return { seq, frames };
}

/** Fetch the live timeline and map ranges to frames. */
export async function resolveRangesToFrames(ctx, ranges = []) {
  const timeline = await getTimeline(ctx);
  return mapRangesToFrames(timeline, ranges);
}

/** A human-readable cut list (timecodes) for dry-run previews. */
export function framesToCutList(frames, seq) {
  const list = frames
    .slice()
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((f) => ({
      clip: f.clipId,
      from: formatTimecode(f.startFrame, seq.frameRate, seq.dropFrame),
      to: formatTimecode(f.endFrame, seq.frameRate, seq.dropFrame),
      seconds: f.sec,
    }));
  return { count: list.length, totalRemovedSeconds: round3(list.reduce((s, r) => s + r.seconds, 0)), cutList: list };
}

const MODE_RIPPLE = { remove: true, keepSpaces: false };

/** Merge frame ranges into an ascending, non-overlapping list (host requires it). */
export function mergeFrameRanges(frames) {
  const sorted = frames
    .filter((f) => f && f.endFrame > f.startFrame)
    .slice()
    .sort((a, b) => a.startFrame - b.startFrame);
  const merged = [];
  for (const f of sorted) {
    const last = merged[merged.length - 1];
    if (last && f.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, f.endFrame);
    else merged.push({ startFrame: f.startFrame, endFrame: f.endFrame });
  }
  return merged;
}

const APPLY_CHUNK = 50;

// How many ripple cuts justify the XML-rebuild path (import a tightened copy —
// seconds) over in-place razoring (minutes at scale). Override: EDITAGENT_REBUILD_MIN
// in .env; 0 disables the rebuild path entirely.
const REBUILD_MIN_DEFAULT = 100;
function rebuildMinRanges() {
  const v = Number(liveEnv("EDITAGENT_REBUILD_MIN"));
  if (Number.isFinite(v) && v >= 0) return v === 0 ? Infinity : v;
  return REBUILD_MIN_DEFAULT;
}

/**
 * Fast batched delete, shared by the silence AND retake apply paths. The old
 * loop called removeRange once per range — one evalScript round-trip + a QE
 * razor pass + a RIPPLE delete each; the ripple shifts every downstream clip,
 * so N ranges cost O(N × clips) DOM work (~30 min on a 2h talking timeline).
 * Batched: chunked removeRangesBatch host calls (razor all edges + lift-delete,
 * nothing shifts, so chunk order is free and cancel works between chunks), then
 * ONE closeRangeGaps pass when rippling (each surviving clip moves once).
 */
export async function applyRangesBatched(ctx, frames, { ripple = true, fps = 30, chunkSize, timeline = null, rebuildMin, onProgress = () => {} } = {}) {
  const merged = mergeFrameRanges(frames);

  // Big ripple jobs: skip in-place razoring entirely — build the finished
  // sequence as FCP7 XML and import it (TimeBolt-style; one native op).
  // Preferred builder is the ROUND-TRIP (export the real sequence, edit timing
  // only → effects/transforms/levels survive); fallback is the generated
  // rebuild (bare clips, effects dropped); any failure falls through to razor.
  // EDITAGENT_ROUNDTRIP=0 in .env skips the round-trip builder.
  const min = rebuildMin != null ? rebuildMin : rebuildMinRanges();
  if (ripple && timeline && merged.length >= min) {
    const rt = String(liveEnv("EDITAGENT_ROUNDTRIP") || "").toLowerCase();
    const roundtripOff = rt === "0" || rt === "false" || rt === "off";
    const builders = roundtripOff
      ? [["generated", rebuildViaXml]]
      : [["round-trip", roundtripViaXml], ["generated", rebuildViaXml]];
    for (const [label, build] of builders) {
      try {
        const r = await build(ctx, timeline, merged, { onProgress });
        return {
          applied: merged.length,
          appliedSec: r.removedSec,
          requested: merged.length,
          aborted: false,
          errors: [],
          rebuild: true,
          roundtrip: !!r.roundtrip,
          sequenceName: r.sequenceName,
          opened: r.opened,
        };
      } catch (e) {
        log(`XML ${label} rebuild failed:`, e.message);
      }
    }
    onProgress("Fast rebuild unavailable. Cutting in place…");
  }

  const size = Math.max(1, Number(chunkSize) || APPLY_CHUNK);
  let applied = 0;
  let appliedSec = 0;
  let aborted = false;
  const errors = [];
  const processed = [];
  for (let i = 0; i < merged.length; i += size) {
    if (isAborted(ctx)) { aborted = true; break; }
    const chunk = merged.slice(i, i + size);
    onProgress(`Cutting ${Math.min(i + chunk.length, merged.length)}/${merged.length}…`);
    try {
      const res = await callHostHealing(ctx, "removeRangesBatch", { ranges: chunk }, { timeoutMs: 180000 });
      const idxs = (res && Array.isArray(res.removedIndexes) ? res.removedIndexes : chunk.map((_, k) => k))
        .filter((k) => Number.isInteger(k) && k >= 0 && k < chunk.length); // a malformed host reply must not corrupt the accounting
      applied += idxs.length;
      for (const k of idxs) appliedSec += (chunk[k].endFrame - chunk[k].startFrame) / fps;
      processed.push(...chunk);
    } catch (e) {
      errors.push({ at: chunk[0].startFrame, error: e.message });
      processed.push(...chunk); // unknown state — closeRangeGaps only ever closes EMPTY ranges, so including is safe
    }
  }
  // Close even after an abort/error so the timeline is left consistent (no stray gaps).
  if (ripple && applied > 0) {
    onProgress("Closing the gaps…");
    try {
      await callHostHealing(ctx, "closeRangeGaps", { ranges: processed }, { timeoutMs: 600000 });
    } catch (e) {
      errors.push({ at: -1, error: `close gaps: ${e.message}` });
    }
  }
  if (errors.length) log(`applyRangesBatched: ${errors.length} error(s), first:`, errors[0].error);
  return { applied, appliedSec: round3(appliedSec), requested: merged.length, aborted, errors };
}

/**
 * Map source-second ranges to timeline frames and apply them. mode:
 *  - "remove"     ripple-delete (close the gap)         [default]
 *  - "keepSpaces" lift-delete   (leave the gap)
 *  - "mute"       silence the span, keep the picture
 *  - "keep"       no-op (preview only)
 * remove/keepSpaces go through the batched razor→lift→close path (applyRangesBatched);
 * mute stays a per-range loop (razors + disables, no shifting, rarely hundreds).
 */
export async function applySilenceRanges(ctx, { ranges = [], mode = "remove", transition = "none", chunkSize } = {}, onProgress = () => {}) {
  if (mode === "keep") {
    return { applied: 0, requested: 0, removedSeconds: 0, mode, message: "Keep mode. Nothing was removed." };
  }
  const timeline = await getTimeline(ctx); // snapshot source (before any edit) + range mapping
  const { seq, frames } = mapRangesToFrames(timeline, ranges);

  if (frames.length === 0) {
    return { applied: 0, requested: 0, removedSeconds: 0, mode, message: "No silence ranges resolved to the timeline." };
  }

  const ripple = MODE_RIPPLE[mode];
  let applied = 0;
  let appliedSec = 0;
  let aborted = false;
  let requested = frames.length;
  let errors = [];
  if (mode === "mute") {
    frames.sort((a, b) => b.startFrame - a.startFrame);
    for (let i = 0; i < frames.length; i++) {
      if (isAborted(ctx)) { aborted = true; break; }
      onProgress(`Muting ${i + 1}/${frames.length}…`);
      try {
        await ctx.bridge.callHost("muteRange", { startFrame: frames[i].startFrame, endFrame: frames[i].endFrame });
        applied += 1;
        appliedSec += frames[i].sec;
      } catch (e) {
        errors.push({ at: frames[i].startFrame, error: e.message });
      }
    }
  } else {
    const res = await applyRangesBatched(ctx, frames, { ripple, fps: seq.frameRate, chunkSize, timeline, onProgress });
    applied = res.applied;
    appliedSec = res.appliedSec;
    aborted = res.aborted;
    requested = res.requested;
    errors = res.errors;
    if (res.rebuild) {
      // Original sequence untouched — no undo snapshot; the new sequence IS the result.
      ctx.state.revision += 1;
      return {
        applied,
        requested,
        removedSeconds: round3(appliedSec),
        mode,
        ripple,
        transition,
        aborted: false,
        rebuild: true,
        sequenceName: res.sequenceName,
        undoable: false,
        revision: ctx.state.revision,
        message:
          `Created tightened sequence "${res.sequenceName}"${res.opened ? " (now open)" : ""}. Removed ${applied} silence range(s), ~${round3(appliedSec)}s. ` +
          `The original sequence is untouched; delete the new one to discard.`,
      };
    }
  }
  const removedSeconds = round3(appliedSec);
  if (applied > 0) {
    ctx.state.revision += 1;
    captureUndo(ctx, "silence", timeline, { mode, applied });
  }

  // Transition styles (J/L-cut, crossfades) are recorded but v1 applies clean
  // cuts — adding sync-correct split edits/crossfades over many ripple points is
  // not yet verified, so we never risk a desynced edit. None is the tested path.
  const transitionNote =
    transition && transition !== "none"
      ? ` Transition "${transition}" was recorded; v1 applies clean cuts (add crossfades in Premiere if wanted).`
      : "";

  return {
    applied,
    requested,
    removedSeconds,
    mode,
    ripple,
    transition,
    aborted,
    undoable: applied > 0,
    errors: errors.length ? errors : undefined,
    revision: ctx.state.revision,
    message:
      (aborted ? "Stopped after " : `${mode === "mute" ? "Muted" : "Removed"} `) +
      `${applied}${aborted ? "" : "/" + requested} silence range(s)` +
      (mode === "remove" ? (aborted ? "" : " and closed the gaps") : mode === "keepSpaces" ? " (gaps left in place)" : "") +
      `. ~${removedSeconds}s.` +
      (errors.length ? ` ${errors.length} error(s). First: ${errors[0].error}` : "") +
      transitionNote +
      (applied > 0 ? " Use Undo to revert." : ""),
  };
}

/** Push silence settings (e.g. an AI-suggested threshold) to the panel, live. */
export function pushSilenceConfig(ctx, config) {
  try {
    ctx.bridge.notifyPanel({ type: "silenceConfig", ...config });
  } catch {
    /* panel may be closed; ignore */
  }
}
