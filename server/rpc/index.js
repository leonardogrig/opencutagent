// Panel-initiated RPC handlers, shared with the MCP tools via ctx.review /
// ctx.silence. Two ways to drive the "AI":
//  - Interactive ("Sync with Claude Code" on): Claude in chat calls the MCP
//    tools and pushes marks/threshold here. These handlers just load + apply.
//  - Headless (default): aiThreshold / aiRetakes run the `claude` CLI here
//    (subscription, no chat) and apply the answer — see server/ai.js.
import { readdir, stat, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildReview, markDecisions, applyReview, reconcile, reinsertTarget, requireReview, planEditMarkers, EDIT_MARKER_SENTINEL, buildTranscriptCues, formatSrt } from "../review.js";
import { buildLevels, levelsForPanel, applySilenceRanges } from "../silences.js";
import { restoreUndo, hasUndo } from "../undo.js";
import { liveEnv, setEnvKey } from "../config.js";
import { askClaude, THRESHOLD_SCHEMA, thresholdSystem, thresholdPrompt, analyzeRetakes } from "../ai.js";
import { readUsage, recordUsage } from "../usage.js";
import { animHandlers } from "../animation/index.js";

// Model/effort come from the panel dropdowns; fall back to .env, then sane defaults.
function aiModel(params) { return params.model || liveEnv("EDITAGENT_AI_MODEL") || "latest"; }
function aiEffort(params) { return params.effort || liveEnv("EDITAGENT_AI_EFFORT") || "high"; }

// Register an abort token for a panel-initiated long op so the "cancel" RPC (a
// separate concurrent message over the same socket) can stop it between steps.
async function cancellable(ctx, fn) {
  const token = { aborted: false };
  ctx.panelOp = token;
  try {
    return await fn(token); // pass the token so an op cancels/kills ITS OWN work, not a concurrent one's
  } finally {
    if (ctx.panelOp === token) ctx.panelOp = null;
  }
}

/** Stop the in-flight scan/apply (sets the abort flag the loops check; kills a headless AI call). */
async function cancel(_params, _helpers, ctx) {
  if (ctx.panelOp) {
    ctx.panelOp.aborted = true;
    if (ctx.panelOp.child) { try { ctx.panelOp.child.kill("SIGTERM"); } catch { /* already exited */ } }
    // chunked retake analysis runs several headless calls at once — kill them all.
    if (ctx.panelOp.children) for (const c of ctx.panelOp.children) { try { c.kill("SIGTERM"); } catch { /* already exited */ } }
  }
  return { cancelled: true };
}

/** Analyze timeline loudness for the Remove Silences tab (ffmpeg, no transcription). */
async function analyzeLevels(params, helpers, ctx) {
  return cancellable(ctx, async () => {
    const silence = await buildLevels(ctx, { clipId: params.clip_id, refresh: !!params.refresh }, helpers.progress);
    helpers.progress(`Analyzed ${silence.clips.length} clip(s).`);
    return levelsForPanel(silence);
  });
}

/** Apply the panel's computed silence ranges (remove / keep-spaces / mute). */
async function applySilences(params, helpers, ctx) {
  return cancellable(ctx, () =>
    applySilenceRanges(
      ctx,
      { ranges: params.ranges || [], mode: params.mode || "remove", transition: params.transition || "none" },
      helpers.progress
    )
  );
}

function reviewResult(review) {
  return {
    sequence: review.sequence,
    frameRate: review.frameRate,
    dropFrame: review.dropFrame,
    segments: review.segments,
    skipped: review.skipped,
    fragments: review.fragments,
  };
}

/**
 * Transcribe the timeline into reviewable segments. Reload keeps the user's
 * Keep/Cut/Protected marks (carried onto the new tiling by source overlap);
 * Start Over sends fresh:true to really wipe them.
 */
async function loadSegments(params, helpers, ctx) {
  return cancellable(ctx, async () => {
    const review = await buildReview(ctx, { clipId: params.clip_id, refresh: !!params.refresh, transcribeModel: params.transcribe_model, carryMarks: params.fresh !== true }, helpers.progress);
    helpers.progress(`Found ${review.segments.length} segments.`);
    return reviewResult(review);
  });
}

/**
 * The panel's silent auto-load/resync: build segments from the CURRENT timeline
 * using only what's already cached — never bills ElevenLabs, never needs a key.
 * Anything not fully covered (or any other hiccup) returns {loaded:false} and
 * the explicit Load button stays the paid path. Marks always carry over.
 */
async function autoLoadSegments(params, helpers, ctx) {
  if (ctx.panelOp) return { loaded: false, reason: "busy" };
  try {
    return await cancellable(ctx, async () => {
      const review = await buildReview(ctx, { transcribeModel: params.transcribe_model, cacheOnly: true, carryMarks: true }, helpers.progress);
      return { loaded: true, ...reviewResult(review) };
    });
  } catch (e) {
    return { loaded: false, reason: e.message, code: e.code || null };
  }
}

/**
 * Apply the panel's current Keep/Cut decisions (ripple if removeGaps).
 * The panel is the source of truth for keep/cut, so we sync its decisions onto
 * ctx.review first; applyReview then reconciles LIVE frames before razoring
 * (stored frames go stale after the first ripple / any re-insert — see review.js).
 */
async function applyDecisions(params, helpers, ctx) {
  return cancellable(ctx, async () => {
    const review = requireReview(ctx);
    const segs = Array.isArray(params.segments) ? params.segments : [];
    const byIndex = new Map(review.segments.map((s) => [s.index, s]));
    for (const p of segs) {
      const s = byIndex.get(p.index);
      if (!s) continue;
      if (typeof p.protected === "boolean") s.protected = p.protected;
      if (p.decision === "keep" || p.decision === "cut") s.decision = s.protected ? "keep" : p.decision;
    }

    const ripple = params.removeGaps === true;
    const trimExcess = params.trimExcess === true;
    const res = await applyReview(ctx, { removeGaps: ripple, trimExcess }, helpers.progress);
    if (res.requested === 0) {
      // Distinguish "nothing is marked" from "your cuts are already gone" — the
      // latter happens after a successful apply left the list stale, and a bare
      // "nothing to cut" reads as if apply never works.
      const message =
        res.cutsMarked === 0
          ? "No segments are marked Cut" +
            (trimExcess ? " and no excess non-speech was found to trim." : ". Mark segments (or run Analyze w/ Claude), then Apply All.")
          : `All ${res.cutsMarked} Cut segment(s) are already removed from the timeline (~${res.alreadyGoneSec}s cut earlier). Nothing new to apply.`;
      return { applied: 0, ripple, cutsRequested: 0, cutsMarked: res.cutsMarked, alreadyGone: res.alreadyGone, revision: res.revision, message };
    }
    if (res.rebuild) {
      return {
        ...res,
        cutsRequested: res.requested,
        message: `Created tightened sequence "${res.sequenceName}" with ${res.applied} cut(s) removed. The original sequence is untouched; delete the new one to discard.`,
      };
    }
    return {
      ...res,
      cutsRequested: res.requested,
      message:
        (res.aborted
          ? `Stopped after ${res.applied} cut(s).`
          : `Applied ${res.applied}/${res.requested} cut(s) (~${res.appliedSec}s)${ripple ? " and closed the gaps" : " (gaps left in place)"}.`) +
        (res.excessSpans ? ` Includes ${res.excessSpans} excess non-speech trim(s) inside keeps.` : "") +
        (res.alreadyGone ? ` ${res.alreadyGone} other cut(s) had already been removed.` : "") +
        (res.errors && res.errors.length ? ` ${res.errors.length} error(s). First: ${res.errors[0].error}` : "") +
        (res.applied > 0 ? " Use Undo to revert." : ""),
    };
  });
}

/**
 * Soft Apply (non-destructive): instead of removing the Cut segments, annotate the LIVE
 * timeline with colored sequence markers so the user can eyeball each retake group and pick
 * the final take by hand. Premiere can't recolor clips (see planEditMarkers), so we lay
 * markers: one hue band per group's duplicates + a green keeper band, red for no-speech.
 * Syncs the panel's keep/cut/protected onto ctx.review first (like applyDecisions), then
 * reconciles LIVE positions before placing — stored frames go stale after any edit.
 */
async function softApply(params, helpers, ctx) {
  return cancellable(ctx, async () => {
    const review = requireReview(ctx);
    const segs = Array.isArray(params.segments) ? params.segments : [];
    const byIndex = new Map(review.segments.map((s) => [s.index, s]));
    for (const p of segs) {
      const s = byIndex.get(p.index);
      if (!s) continue;
      if (typeof p.protected === "boolean") s.protected = p.protected;
      if (p.decision === "keep" || p.decision === "cut") s.decision = s.protected ? "keep" : p.decision;
      if (Number.isInteger(p.group)) s.group = p.group; // keep the group ids the panel holds in sync
    }

    helpers.progress("Reading the timeline…");
    const { map } = await reconcile(ctx);
    const { markers, stats } = planEditMarkers(review.segments, map, { sentinel: EDIT_MARKER_SENTINEL });
    if (!markers.length) {
      return { created: 0, ...stats, message: "Nothing to mark. Run “Analyze w/ Claude” to find retake groups (or there are none)." };
    }

    helpers.progress(`Marking ${markers.length} span(s) on the timeline…`);
    const host = await ctx.bridge.callHost("applyEditMarkers", { markers, sentinel: EDIT_MARKER_SENTINEL }, { timeoutMs: 60000 });
    const created = host && host.created != null ? host.created : stats.created;
    return {
      ...stats,
      created,
      cleared: host ? host.cleared : 0,
      message:
        `Marked ${stats.groups} retake group(s)` +
        (stats.noSpeech ? ` and ${stats.noSpeech} no-speech span(s)` : "") +
        ". Green = suggested keeper. Open Window > Markers in Premiere to read the labels.",
    };
  });
}

/** Remove the markers Soft Apply created (sentinel-scoped; never touches the user's own). */
async function clearMarkers(_params, _helpers, ctx) {
  const host = await ctx.bridge.callHost("clearEditMarkers", { sentinel: EDIT_MARKER_SENTINEL }, { timeoutMs: 30000 });
  const removed = host ? host.removed : 0;
  return { removed, message: removed ? `Cleared ${removed} OpenCutAgent marker(s).` : "No OpenCutAgent markers to clear." };
}

/** Make a review's sequence name safe to use as a file name (kept ASCII-ish, no path chars). */
function transcriptFilename(name) {
  const base = String(name == null ? "" : name)
    .replace(/[\\/:*?"<>|]+/g, " ") // path/OS-reserved chars
    .replace(/\s+/g, " ")
    .trim();
  return (base || "transcript") + ".srt";
}

/**
 * Export the kept speech as a YouTube-ready SubRip (.srt) document — "only the keeps,
 * what's actually on the timeline". Reconciles live positions first so the caption times
 * match the current timeline exactly (post-apply this IS the final video); `compact`
 * (the panel's ripple checkbox) removes the time still-present cuts will ripple out so the
 * captions align with the tightened cut. Returns the .srt text for the panel to save.
 */
async function exportTranscript(params, _helpers, ctx) {
  const review = requireReview(ctx);
  let map = null;
  try { map = (await reconcile(ctx)).map; } catch { map = null; } // fall back to stored positions if the read fails
  const cues = buildTranscriptCues(review.segments, map, { compact: params.compact === true });
  const srt = formatSrt(cues);
  return {
    srt,
    filename: transcriptFilename(review.sequence),
    cues: cues.length,
    durationSec: cues.length ? cues[cues.length - 1].endSec : 0,
    compact: params.compact === true,
    message: cues.length
      ? `Exported ${cues.length} caption(s)${params.compact === true ? " (gaps closed)" : ""}.`
      : "No kept speech to export. Load and (optionally) analyze the timeline first.",
  };
}

/**
 * Reconcile segments against the LIVE timeline for the panel: per-segment
 * present/partial/absent + current timeline position. Drives playhead-sync
 * highlighting and decides which removed cuts can be re-inserted. Cheap-ish
 * (one host read); the panel calls it on show, after edits, and lazily.
 */
async function timelineMap(_params, _helpers, ctx) {
  const { map, revision, frameRate } = await reconcile(ctx);
  return { map, revision, frameRate };
}

/**
 * Re-insert a removed ("absent") Cut segment back onto the timeline, right before
 * the next surviving clip (or after the previous one / at 0 for the tail/head).
 * Pulls the segment's exact source range from its source project item via the
 * host insertClip (ripple) edit, restoring linked V/A. Cmd+Z is the undo (we do
 * NOT touch the shared apply-undo snapshot). Verifies via reconcile afterward.
 */
async function reinsertSegment(params, helpers, ctx) {
  return cancellable(ctx, async () => {
    const review = requireReview(ctx);
    const index = params.index;
    const seg = review.segments.find((s) => s.index === index);
    if (!seg) throw new Error(`No segment #${index} loaded.`);
    if (seg.mediaPath == null || seg.sourceInSec == null || seg.sourceOutSec == null) {
      throw new Error("This segment predates re-insert support. Click Reload, then try again.");
    }

    const { map } = await reconcile(ctx);
    const byIndex = new Map(map.map((m) => [m.index, m]));
    const me = byIndex.get(index);
    if (me && me.state === "present") {
      return { ok: false, index, message: "That segment is already on the timeline. Use “Mark as Keep”." };
    }

    // Insert right before the next still-present segment (exactly where it was).
    const target = reinsertTarget(review.segments, map, index);

    helpers.progress("Re-inserting the clip…");
    const host = await ctx.bridge.callHost(
      "reinsertSegment",
      {
        mediaPath: seg.mediaPath,
        sourceInSec: seg.sourceInSec,
        sourceOutSec: seg.sourceOutSec,
        targetSeconds: target,
        trackIndex: seg.trackType === "video" ? (seg.trackIndex || 0) : 0,
      },
      { timeoutMs: 30000 }
    );

    // Verify it actually landed (wrong-track / wrong-range inserts stay "absent").
    const after = await reconcile(ctx);
    const am = after.map.find((m) => m.index === index);
    const ok = !!(am && am.state !== "absent");
    if (ok) {
      seg.decision = "keep";
      seg.manual = true;
      ctx.state.revision += 1;
    }
    return {
      ok,
      index,
      segment: ok ? seg : null,
      targetSeconds: target,
      host,
      message: ok
        ? "Re-inserted. Press Cmd+Z in Premiere to undo."
        : "Re-insert didn't land cleanly. Check the timeline (Cmd+Z to revert any change).",
    };
  });
}

/**
 * Headless "Suggest threshold" for the Remove Silences tab: have Claude pick a
 * Noise Threshold from the measured loudness, clamp it, and return it. Sets
 * nothing destructive — the panel just moves the slider; the user still cuts.
 */
async function aiThreshold(params, helpers, ctx) {
  return cancellable(ctx, async (token) => {
    let silence = ctx.silence;
    if (!silence || !silence.clips || !silence.clips.length) {
      helpers.progress("Scanning audio levels…");
      silence = await buildLevels(ctx, { clipId: params.clip_id }, helpers.progress);
    }
    if (token.aborted) throw new Error("Cancelled");
    helpers.progress("Claude is choosing a threshold…");
    const startedAt = Date.now();
    const { data, raw } = await askClaude({
      prompt: thresholdPrompt(silence),
      system: thresholdSystem(),
      schema: THRESHOLD_SCHEMA,
      model: aiModel(params),
      effort: aiEffort(params),
      token,
    });
    recordUsage({
      type: "claude",
      purpose: "Threshold calculation",
      model: aiModel(params),
      effort: aiEffort(params),
      calls: 1,
      durationMs: Date.now() - startedAt,
      inputTokens: (raw.usage && raw.usage.input_tokens) || 0,
      outputTokens: (raw.usage && raw.usage.output_tokens) || 0,
      costUsd: 0, // runs on the user's Claude subscription
    });
    let thr = Math.round(Number(data.threshold_db));
    if (!Number.isFinite(thr)) throw new Error("Claude didn't return a numeric threshold. Try again.");
    thr = Math.max(-55, Math.min(-20, thr)); // estimateThreshold's bounds; -60 means "detect nothing" and the prompt forbids answering it
    return {
      thresholdDb: thr,
      suggestedThresholdDb: silence.stats ? silence.stats.suggestedThresholdDb : null,
    };
  });
}

/**
 * Headless "Analyze w/ Claude" for the Retakes tab: have Claude mark which
 * segments are duplicate takes/false starts/filler. Marks push live to the
 * panel for review — applying the cuts is still a separate, user-confirmed step.
 */
async function aiRetakes(params, helpers, ctx) {
  return cancellable(ctx, async (token) => {
    let review = ctx.review;
    if (!review || !review.segments || !review.segments.length) {
      helpers.progress("Transcribing the timeline…");
      review = await buildReview(ctx, { clipId: params.clip_id, transcribeModel: params.transcribe_model }, helpers.progress);
    }
    if (token.aborted) throw new Error("Cancelled");
    if (!review.segments.length) throw new Error("No segments to analyze. Load the timeline first.");

    // No-speech (word-empty) clips are removed deterministically — they're noise,
    // not a judgment call. Claude never sees them and can't un-cut them; its only
    // job is real speech (retakes / false starts / filler).
    const emptyIdx = new Set(review.segments.filter((s) => s.fragment === "empty").map((s) => s.index));
    const speechSegs = review.segments.filter((s) => !emptyIdx.has(s.index));
    // Chunked + concurrent: one call per whole long timeline is unreliable (lazy
    // mid-list / times out). analyzeRetakes windows it and merges the cuts.
    const decisions = await analyzeRetakes(speechSegs, {
      model: aiModel(params),
      effort: aiEffort(params),
      token,
      onProgress: helpers.progress,
    });
    if (token.aborted) throw new Error("Cancelled");
    // Fresh analysis: clear prior non-protected marks, then apply Claude's cuts —
    // but keep the deterministic no-speech cuts (not Claude's to revisit).
    for (const s of review.segments) {
      if (s.protected || emptyIdx.has(s.index)) continue;
      s.decision = "keep"; s.group = null; s.reason = null; s.manual = false;
    }
    const clean = decisions
      .filter((d) => Number.isInteger(d.index) && !emptyIdx.has(d.index) && (d.decision === "keep" || d.decision === "cut"))
      .map((d) => ({
        index: d.index,
        decision: d.decision,
        ...(Number.isInteger(d.group) ? { group: d.group } : {}),
        ...(typeof d.reason === "string" && d.reason ? { reason: d.reason } : {}),
      }));
    const summary = markDecisions(ctx, clean); // mutates ctx.review + pushes reviewUpdate to the panel
    return { ...summary, analyzed: speechSegs.length, decisions: clean.length };
  });
}

// The on-disk caches the panel may clear. NEVER widened to ctx.cacheDir itself —
// .cache also holds files that aren't regenerable (e.g. saved cut decisions).
const CACHE_SUBDIRS = ["transcripts", "levels", "rebuild"];

async function dirSize(dir) {
  let bytes = 0, files = 0, entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return { bytes: 0, files: 0 }; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const s = await dirSize(p); bytes += s.bytes; files += s.files; }
    else { try { const st = await stat(p); bytes += st.size; files += 1; } catch { /* raced a delete */ } }
  }
  return { bytes, files };
}

/** Size of the regenerable on-disk caches (transcripts / audio levels / rebuild XMLs). */
async function cacheInfo(_params, _helpers, ctx) {
  const dirs = {};
  let totalBytes = 0, totalFiles = 0;
  for (const name of CACHE_SUBDIRS) {
    const s = await dirSize(join(ctx.cacheDir, name));
    dirs[name] = s; totalBytes += s.bytes; totalFiles += s.files;
  }
  return { totalBytes, totalFiles, dirs };
}

/**
 * Delete the cached transcripts / audio levels / rebuild XMLs. Everything is
 * regenerable, but transcripts re-bill ElevenLabs credits on the next Load —
 * the panel double-confirms before calling this.
 */
async function clearCache(_params, helpers, ctx) {
  if (ctx.panelOp || ctx.animOp) throw new Error("Busy. Wait for the current operation to finish, then clear the cache.");
  const before = await cacheInfo(_params, helpers, ctx);
  for (const name of CACHE_SUBDIRS) {
    const dir = join(ctx.cacheDir, name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  }
  const mb = (before.totalBytes / (1024 * 1024)).toFixed(1);
  return {
    freedBytes: before.totalBytes,
    freedFiles: before.totalFiles,
    message: before.totalFiles
      ? `Cleared ${before.totalFiles} cached file(s), freed ${mb} MB. The next Load re-transcribes; the next Scan re-reads audio.`
      : "Cache was already empty.",
  };
}

// ---- ElevenLabs API key (panel modal for non-developers; no .env editing) ----
const ELEVENLABS_KEY = "ELEVENLABS_API_KEY";

/** Whether an ElevenLabs key is configured. Never returns the key itself, only the last 4 chars. */
async function keyStatus() {
  const k = liveEnv(ELEVENLABS_KEY);
  return { set: !!k, last4: k ? String(k).slice(-4) : null };
}

/**
 * Save the ElevenLabs API key from the panel into the project .env (liveEnv
 * reads it fresh on the next transcription, so no restart). Verifies the key
 * against the ElevenLabs API first when reachable; a network failure still
 * saves (the user may be offline) and says so.
 */
async function setApiKey(params, _helpers, ctx) {
  const key = String(params.key || "").trim();
  if (!key) throw new Error("Paste your ElevenLabs API key first.");
  if (/\s/.test(key)) throw new Error("That doesn't look like an API key (it contains spaces). Copy it exactly from elevenlabs.io.");
  let verified = false;
  try {
    // Verify against the SAME permission we actually use: speech_to_text.
    // (The old /v1/user probe needed the unrelated user_read scope, so a key
    // scoped to only speech_to_text — exactly what the modal tells users to
    // create — was falsely "rejected".) POST with no file: a valid key gets a
    // 400 "provide a file" validation error (auth passed); a bad or wrongly
    // scoped key gets 401/403.
    const form = new FormData();
    form.append("model_id", "scribe_v2");
    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(
        new Error("ElevenLabs rejected that key. Check you copied the whole key, and that it has the speech_to_text permission (elevenlabs.io > API Keys)."),
        { rejected: true }
      );
    }
    // Any non-auth response (400 missing-file, 200, etc.) means auth passed.
    // A 5xx is an ElevenLabs outage, not a key problem: leave unverified.
    verified = res.status < 500;
  } catch (err) {
    if (err.rejected) throw err;
    // Offline or ElevenLabs unreachable: save anyway, flag as unverified.
  }
  setEnvKey(ELEVENLABS_KEY, key, (ctx && ctx.envPath) || undefined); // ctx.envPath only set by tests
  return {
    ok: true,
    verified,
    last4: key.slice(-4),
    message: verified
      ? "API key verified and saved. You can transcribe now."
      : "API key saved. Could not reach ElevenLabs to verify it right now; it will be checked on the next Load.",
  };
}

// ---- Advanced settings (the panel's env-var accordion) ----
// Curated list of the tunables the server reads from .env, with plain-language
// descriptions. ELEVENLABS_API_KEY is deliberately absent (it has its own
// section + modal). `live: false` = read once at boot, needs a server restart.
const ENV_SPECS = [
  { key: "EDITAGENT_AI_MODEL", def: "latest", desc: "Fallback Claude model for the AI buttons when the panel doesn't send one. latest, opus, sonnet, haiku or fable." },
  { key: "EDITAGENT_AI_EFFORT", def: "high", desc: "Fallback reasoning effort for the AI buttons. low, medium, high, xhigh or max." },
  { key: "EDITAGENT_AI_TIMEOUT_MS", def: "600000", desc: "Hard timeout for one headless Claude call, in milliseconds. Raise it for very long analyses." },
  { key: "EDITAGENT_CLAUDE_BIN", def: "", desc: "Full path to the claude CLI if it isn't found automatically." },
  { key: "EDITAGENT_AI_CHUNK", def: "36", desc: "Segments per chunk when Analyze w/ Claude splits a long timeline into windows." },
  { key: "EDITAGENT_AI_CHUNK_CONTEXT", def: "14", desc: "Extra context segments each chunk sees on both sides of its window." },
  { key: "EDITAGENT_AI_CONCURRENCY", def: "4", desc: "How many analysis chunks run at the same time." },
  { key: "EDITAGENT_SCRIBE_MODEL", def: "scribe_v2", desc: "ElevenLabs speech-to-text model. The Transcription dropdown above overrides this." },
  { key: "EDITAGENT_SCRIBE_RATE", def: "0.22", desc: "ElevenLabs list price per audio hour, used only for the usage log's cost estimates." },
  { key: "EDITAGENT_TRANSCRIBE_MERGE_GAP", def: "5", desc: "Merge used clip ranges closer than this many seconds into one continuous transcription range." },
  { key: "EDITAGENT_TRANSCRIBE_BATCH_SEC", def: "360", desc: "Max seconds of audio bundled into one transcription upload. Smaller parts give finer progress; larger parts mean fewer calls." },
  { key: "EDITAGENT_TRANSCRIBE_CONCURRENCY", def: "3", desc: "How many transcription parts are extracted and uploaded at the same time." },
  { key: "EDITAGENT_TRANSCRIBE_PAD", def: "0.25", desc: "Seconds of audio context kept on each edge of a transcribed range so edge words aren't clipped." },
  { key: "EDITAGENT_REBUILD_MIN", def: "100", desc: "Ripple applies with at least this many cuts use the fast XML rebuild instead of razoring in place. 0 disables it." },
  { key: "EDITAGENT_ROUNDTRIP", def: "1", desc: "Fast applies round-trip Premiere's own XML so effects survive. Set 0 to use the bare rebuild (drops effects)." },
  { key: "EDITAGENT_TRIM_EXCESS_PAD", def: "0.15", desc: "Seconds of breathing room kept around words when Remove excess trims non-speech air." },
  { key: "EDITAGENT_TRIM_EXCESS_MIN", def: "0.2", desc: "Non-speech air shorter than this many seconds is left alone by Remove excess." },
  { key: "EDITAGENT_ANIM_TIMEOUT_MS", def: "1200000", desc: "Hard timeout for one animation chat turn, in milliseconds." },
  { key: "EDITAGENT_ANIM_RENDER_TIMEOUT_MS", def: "1800000", desc: "Hard timeout for one animation render, in milliseconds." },
  { key: "EDITAGENT_ANIM_TRACK", def: "1", desc: "0-based video track animation clips are placed on. 1 = V2." },
  { key: "EDITAGENT_ANIM_HOME", def: "", desc: "Where the animation workspace lives. Empty = ~/.opencutagent/animation-kit.", live: false },
  { key: "PREMIERE_BRIDGE_PORT", def: "3001", desc: "Port the panel and server talk over.", live: false },
  { key: "FFMPEG_BIN", def: "ffmpeg", desc: "Path to ffmpeg if it isn't on PATH.", live: false },
  { key: "EDITAGENT_CACHE_DIR", def: "", desc: "Where transcripts and audio scans are cached. Empty = the project's .cache folder.", live: false },
];

/** The advanced tunables with their current .env values, for the panel's accordion. */
async function envList() {
  return {
    vars: ENV_SPECS.map((s) => ({
      key: s.key,
      value: liveEnv(s.key) || "",
      def: s.def,
      desc: s.desc,
      restart: s.live === false,
    })),
  };
}

/** Write one advanced tunable to .env (empty value = back to the default). */
async function setEnv(params, _helpers, ctx) {
  const key = String(params.key || "");
  const spec = ENV_SPECS.find((s) => s.key === key);
  if (!spec) throw new Error(`"${key}" isn't a setting the panel can change.`);
  const value = String(params.value == null ? "" : params.value).trim();
  setEnvKey(key, value, (ctx && ctx.envPath) || undefined);
  // loadEnv copied .env into process.env at boot and liveEnv falls back to it —
  // sync it so a cleared value really reverts to the default without a restart.
  if (value) process.env[key] = value;
  else delete process.env[key];
  return {
    ok: true,
    key,
    value,
    message: (value ? `Saved ${key}.` : `Reset ${key} to its default.`) + (spec.live === false ? " Takes effect after the server restarts." : ""),
  };
}

/** One-click revert of the last apply (snapshot restore; Cmd+Z is the fallback). */
async function undoLastApply(_params, _helpers, ctx) {
  return restoreUndo(ctx);
}

/** Whether an undo point is currently available (panel asks on (re)connect). */
async function undoStatus(_params, _helpers, ctx) {
  return { undoable: hasUndo(ctx), kind: ctx.undo ? ctx.undo.kind : null };
}

/** The AI usage history for the panel's usage modal (Scribe spend + headless Claude runs). */
async function usageLog() {
  return readUsage();
}

async function ping() {
  return { ok: true };
}

const HANDLERS = { ping, cancel, loadSegments, autoLoadSegments, applyDecisions, softApply, clearMarkers, exportTranscript, timelineMap, reinsertSegment, analyzeLevels, applySilences, aiThreshold, aiRetakes, undoLastApply, undoStatus, cacheInfo, clearCache, usageLog, keyStatus, setApiKey, envList, setEnv, ...animHandlers };

export function createRpcDispatcher(ctx) {
  return async (method, params, helpers) => {
    const fn = HANDLERS[method];
    if (!fn) throw new Error(`Unknown RPC method: ${method}`);
    return fn(params || {}, helpers, ctx);
  };
}
