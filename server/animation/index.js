// Animation tab orchestration: the RPC handlers the panel calls, glued from
// kit (workspace) + jobs (lifecycle) + chat (agent) + render (deliverable).
// Chat turns stream to the panel as unsolicited {type:"animEvent"} pushes so a
// reopened panel can re-attach mid-turn; the RPC itself resolves when the whole
// turn (including any auto render + placement) is done.
//
// Busy model: animation work runs on its OWN lane (ctx.animOp, cancelled by the
// animCancel RPC) so a long chat/render never blocks Rescan/Apply — the agent
// doesn't touch Premiere until the final placement host calls, which serialize
// on the bridge like everything else.
import { basename } from "node:path";
import { ensureKit, kitDir, listStyles, readStyleSkill, readFramesSkill } from "./kit.js";
import {
  createJob, createRawJob, discardJob, loadJobsFrom, readChat, appendChat, saveJob, snapshotScene,
  readRenderSignal, saveRefImage, animTrackIndex, fmtTokens, fmtElapsed, sequenceFrameSize,
  setRawLength,
} from "./jobs.js";
import { runChatTurn } from "./chat.js";
import { renderJob, renderScale } from "./render.js";
import { verifyJobAnchors, verifyRounds } from "./frames.js";
import { reconcile, requireReview } from "../review.js";
import { callHostHealing, getTimeline, mmss, round3, fmtDur } from "../tools/util.js";
import { recordUsage } from "../usage.js";

function anim(ctx) {
  if (!ctx.anim) ctx.anim = { jobs: new Map(), projectDir: null };
  return ctx.anim;
}

function pushEvent(ctx, jobId, event) {
  try { ctx.bridge.notifyPanel({ type: "animEvent", jobId, event }); } catch { /* panel closed */ }
}

async function projectDirOf(ctx) {
  const res = await callHostHealing(ctx, "getProjectDir", {}, { timeoutMs: 15000 });
  return res.dir;
}

async function cancellableAnim(ctx, fn) {
  if (ctx.animOp) throw new Error("The animation agent is still working. Wait for it to finish or press Stop.");
  const token = { aborted: false, children: new Set() };
  ctx.animOp = token;
  try {
    return await fn(token);
  } finally {
    if (ctx.animOp === token) ctx.animOp = null;
  }
}

function getJob(ctx, jobId) {
  const a = anim(ctx);
  let job = a.jobs.get(jobId);
  if (!job && a.projectDir) {
    job = loadJobsFrom(a.projectDir).find((j) => j.id === jobId) || null;
    if (job) a.jobs.set(job.id, job);
  }
  if (!job) throw new Error("That animation isn't loaded. Switch to the Animation tab again to refresh, then retry.");
  return job;
}

/**
 * True when the job's chat ends on the user's message: the turn never produced
 * a reply, a placement, or even an error. Only a process that DIED without
 * unwinding leaves this (a killed or restarted server, a machine that slept) -
 * every in-process failure now writes its own notice. Derived, not bookkept, so
 * it is correct across restarts.
 */
export function turnInterrupted(chat, busy) {
  if (busy) return false;
  const last = chat && chat.length ? chat[chat.length - 1] : null;
  return !!(last && last.role === "user");
}

/** The version written to render.json that has not been rendered yet (0 = none). */
function pendingRenderVersion(job) {
  try {
    const signal = readRenderSignal(job, kitDir());
    return signal && signal.version > (job.lastRenderedVersion || 0) ? signal.version : 0;
  } catch { return 0; }
}

function jobSummary(job, ctx = null) {
  const chat = readChat(job);
  return {
    id: job.id,
    title: job.title || job.id,
    createdAt: job.createdAt,
    raw: !!job.raw,
    style: job.style,
    background: job.background,
    seeFrames: !!job.seeFrames,
    trackIndex: job.trackIndex != null ? job.trackIndex : animTrackIndex(),
    fps: job.fps,
    width: job.width,
    height: job.height,
    sizeSource: job.sizeSource || "sequence",
    durationInFrames: job.durationInFrames,
    durationSec: round3(job.durationInFrames / job.fps),
    range: job.range,
    segmentIndexes: job.segmentIndexes,
    sequence: job.sequence,
    lastRenderedVersion: job.lastRenderedVersion || 0,
    // A version the agent signalled but that never reached the timeline (the
    // render failed, or the panel was closed mid-render): the panel turns this
    // into a "Render again" button so a flaky render costs no new agent turn.
    pendingRender: pendingRenderVersion(job),
    renders: job.renders || [],
    placed: job.placed || null,
    outDir: job.outDir, // so the panel's folder button can reveal it in Finder/Explorer
    chat,
    interrupted: turnInterrupted(chat, !!(ctx && ctx.animOp)),
  };
}

/**
 * Recompute where the clip belongs from the LIVE timeline (the stored range
 * goes stale after any ripple — same lesson as applyReview), then import +
 * overwrite it onto the animation track.
 */
async function placeRender(ctx, job, renderInfo, onStatus) {
  onStatus("Placing the clip on the timeline…");
  let target = job.range.startSec;
  let warning = null;
  // A raw animation isn't tied to any segment: it goes where the playhead was
  // when it was created, so there is nothing to reconcile.
  if (!job.segmentIndexes || !job.segmentIndexes.length) {
    const trackIdx = job.trackIndex != null ? job.trackIndex : animTrackIndex();
    await callHostHealing(ctx, "importFootage", { path: renderInfo.path }, { timeoutMs: 60000 });
    const r = await callHostHealing(ctx, "placeFootage", { path: renderInfo.path, targetSeconds: target, trackIndex: trackIdx }, { timeoutMs: 60000 });
    return {
      ok: !!(r && r.ok),
      targetSeconds: r ? r.targetSeconds : target,
      trackIndex: trackIdx,
      warning: r && r.ok ? null : "Premiere didn't confirm the clip landed; check the timeline (Cmd+Z reverts).",
    };
  }
  try {
    requireReview(ctx);
    const { map } = await reconcile(ctx);
    const byIndex = new Map(map.map((m) => [m.index, m]));
    const first = byIndex.get(job.segmentIndexes[0]);
    const last = byIndex.get(job.segmentIndexes[job.segmentIndexes.length - 1]);
    if (first && first.state !== "absent" && first.liveStartSec != null) {
      target = first.liveStartSec;
      const expected = job.durationInFrames / job.fps;
      const liveDur = last && last.liveEndSec != null ? last.liveEndSec - first.liveStartSec : null;
      if (liveDur != null && Math.abs(liveDur - expected) > 0.25) {
        warning = `Heads up: the selected segments now span ${fmtDur(liveDur)} on the timeline but the animation is ${fmtDur(expected)} (the timeline changed after this animation was created).`;
      }
    } else {
      warning = "The first selected segment is no longer on the timeline, so the clip was placed at its original position.";
    }
  } catch { /* segments not loaded (fresh server): fall back to the stored position */ }

  const trackIndex = job.trackIndex != null ? job.trackIndex : animTrackIndex();
  await callHostHealing(ctx, "importFootage", { path: renderInfo.path }, { timeoutMs: 60000 });
  const res = await callHostHealing(
    ctx,
    "placeFootage",
    { path: renderInfo.path, targetSeconds: target, trackIndex },
    { timeoutMs: 60000 }
  );
  const ok = !!(res && res.ok);
  if (!ok) warning = (warning ? warning + " " : "") + "Premiere didn't confirm the clip landed; check the timeline (Cmd+Z reverts).";
  return { ok, targetSeconds: res ? res.targetSeconds : target, trackIndex, warning };
}

/** Render the signaled version and put it on the timeline; updates + persists the job. */
async function renderAndPlace(ctx, job, kitPath, signal, token, stats = null) {
  const status = (text) => pushEvent(ctx, job.id, { kind: "status", text });
  // Match the LIVE sequence's resolution, even when the job's captured size is
  // wrong or the sequence changed: same-aspect mismatches render with --scale,
  // different-aspect mismatches get a plain warning instead of a distorted clip.
  // A user-pinned size (sizeSource "custom") is deliberate — never rescale it.
  let scale = 1;
  let scaleWarning = null;
  if (job.sizeSource !== "custom") {
    try {
      const timeline = await getTimeline(ctx);
      const live = sequenceFrameSize(timeline.sequence);
      const s = renderScale(job, live && live.width, live && live.height);
      scale = s.scale;
      scaleWarning = s.warning;
      if (s.outWidth && s.scale !== 1) status(`Rendering at the sequence's ${s.outWidth}p width…`);
    } catch { /* host unreachable for the size check: render at the job's own size */ }
  }
  const renderInfo = await renderJob({ kitDirPath: kitPath, job, version: signal.version, scale, token, onProgress: status });
  const placeInfo = await placeRender(ctx, job, renderInfo, status);
  if (signal.title) job.title = signal.title; // the agent named what it built
  job.lastRenderedVersion = signal.version;
  job.renders = job.renders || [];
  job.renders.push({ version: signal.version, file: renderInfo.file, ts: Date.now(), notes: signal.notes || "" });
  job.placed = { ...placeInfo, file: renderInfo.file, version: signal.version };
  saveJob(job);
  // "(18.4k tokens, 3m 12s)": what the turn cost and how long it took, message
  // sent to clip placed.
  const statBits = [];
  if (stats) {
    const t = fmtTokens(stats.tokens);
    if (t) statBits.push(t + " tokens");
    const e = fmtElapsed(Date.now() - stats.startedAt);
    if (e) statBits.push(e);
  }
  const stat = statBits.length ? ` (${statBits.join(", ")})` : "";
  const text =
    (placeInfo.ok
      ? `Animation v${signal.version} placed on V${placeInfo.trackIndex + 1} at ${mmss(placeInfo.targetSeconds)}${stat}.`
      : `Animation v${signal.version} rendered${stat}, but Premiere didn't confirm it landed. Check the timeline.`) +
    (scaleWarning ? " " + scaleWarning : "") +
    (placeInfo.warning ? " " + placeInfo.warning : "") +
    (stats && stats.extraNote ? " " + stats.extraNote : "");
  appendChat(job, { role: "system", kind: "placed", text, targetSeconds: placeInfo.targetSeconds, trackIndex: placeInfo.trackIndex });
  pushEvent(ctx, job.id, { kind: "placed", version: signal.version, file: renderInfo.file, ok: placeInfo.ok, targetSeconds: placeInfo.targetSeconds, text });
  return { renderInfo, placeInfo, text };
}

/**
 * The frame-check gate for "Use frames" jobs: run the anchor check the agent
 * was told to run itself; while it FAILS and rounds remain, send the report
 * back to the agent as an automatic message and let it fix the scene, then
 * check again. Never blocks a render for good: after the last round the clip
 * renders anyway and the placed notice says what is still off. Returns
 * {status, note} where note is the sentence appended to the placed notice.
 */
async function verifyWithFixups(ctx, job, kitPath, { model, effort, token, onTokens = () => {} }) {
  const status = (text) => pushEvent(ctx, job.id, { kind: "status", text });
  const rounds = verifyRounds();
  status("Checking the drawings against the footage…");
  let result = verifyJobAnchors(job, kitPath);
  let round = 0;
  while (result.status === "fail" && round < rounds) {
    if (token.aborted) throw new Error("Cancelled");
    round++;
    const what = result.fails ? `${result.fails} drawing(s) don't match the footage` : "the anchor list has problems";
    appendChat(job, { role: "system", kind: "note", text: `Frame check: ${what}. Sending the agent back to fix them before rendering (round ${round} of ${rounds}).` });
    pushEvent(ctx, job.id, { kind: "frameCheck", round, text: `Frame check: ${what}.` });
    status("Fixing the drawings against the footage…");
    const prompt = [
      `[Automatic frame check, not a message from the user. Round ${round} of ${rounds}.]`,
      "The anchored drawings below do not match the footage under them. Fix each one's timing and/or position (a drawing may only be visible while its target is on screen, inside one shot; start it after the target appears and end it before the screen changes), or mark expectMotion only if the target legitimately animates. Read the sheets the check wrote. Then re-run `node scripts/check-anchors.mjs " + job.id + "` until it reports no FAIL, and bump the version in render.json. Reply in one short sentence.",
      "",
      result.report,
    ].join("\n");
    const startedAt = Date.now();
    let streamed = "";
    const tools = [];
    const turn = await runChatTurn({
      kitDirPath: kitPath,
      job,
      prompt,
      styleSkill: readStyleSkill(job.style),
      framesSkill: readFramesSkill(),
      model,
      effort,
      token,
      onEvent: (ev) => {
        if (ev.kind === "delta") streamed += ev.text;
        else if (ev.kind === "tool") tools.push({ name: ev.name, detail: ev.detail });
        pushEvent(ctx, job.id, ev);
      },
    });
    job.sessionId = turn.sessionId;
    appendChat(job, { role: "assistant", text: (turn.text && turn.text.trim()) || streamed, tools, hidden: true, auto: true });
    snapshotScene(job, kitPath);
    saveJob(job);
    const inTok = (turn.usage && turn.usage.input_tokens) || 0;
    const outTok = (turn.usage && turn.usage.output_tokens) || 0;
    onTokens(inTok + outTok);
    recordUsage({ type: "claude", purpose: "Animation frame fix-up", model: model || "latest", effort: effort || null, calls: 1, durationMs: Date.now() - startedAt, inputTokens: inTok, outputTokens: outTok, costUsd: 0 });
    status("Checking the drawings against the footage…");
    result = verifyJobAnchors(job, kitPath);
  }
  let note = null;
  if (result.status === "fail") {
    note = `Frame check: ${result.fails ? `${result.fails} drawing(s) may still not match the footage` : "the anchor list still has problems"} (details in the note above).`;
    appendChat(job, { role: "system", kind: "note", text: `Frame check details:\n${result.report}` });
  } else if (result.status === "missing") {
    note = "The agent declared no anchors, so the frame check was skipped.";
  } else if (result.status === "ok" && round) {
    note = "Frame check passed after the fix.";
  }
  return { status: result.status, note };
}

/**
 * renderAndPlace, but a failure is PERSISTED to the chat before it propagates.
 * The RPC rejection only produces a toast, which is gone the moment the panel
 * reloads - and a render that dies leaves nothing on disk and nothing in the
 * chat, so the user comes back to a session that looks like it simply stopped.
 */
async function renderPlaceOrReport(ctx, job, kitPath, signal, token, stats = null) {
  try {
    return await renderAndPlace(ctx, job, kitPath, signal, token, stats);
  } catch (e) {
    if (token && token.aborted) throw e;
    const text = `Version ${signal.version} could not be rendered. ${e.message} Nothing changed on the timeline. Press "Render again" to retry without spending another turn.`;
    appendChat(job, { role: "system", kind: "error", text });
    pushEvent(ctx, job.id, { kind: "renderFailed", version: signal.version, text });
    e.reported = true; // animChat must not post a second notice for the same failure
    throw e;
  }
}

/**
 * Every way a turn can end badly, written into the job's chat so it survives a
 * panel reload, a reconnect, or the user looking away. A turn that dies with
 * nothing persisted is the worst failure mode this tab has: the panel simply
 * goes quiet and the session looks frozen.
 */
function reportTurnFailure(ctx, job, err, token) {
  if (err && err.reported) return;                       // renderPlaceOrReport already said it
  const cancelled = (token && token.aborted) || /cancel/i.test(String(err && err.message));
  const text = cancelled
    ? "Stopped. Whatever the agent had already written is saved; send a message to carry on."
    : `The agent stopped before finishing this turn. ${err && err.message ? err.message : "Unknown error."}`;
  try {
    appendChat(job, { role: "system", kind: cancelled ? "note" : "error", text });
    pushEvent(ctx, job.id, { kind: cancelled ? "turnStopped" : "turnFailed", text });
  } catch { /* the notice is best-effort; never mask the original failure */ }
  if (err) err.reported = true;
}

/* ============================ RPC handlers ============================ */

/** The style choices for the tab's dropdown. */
async function animStyles() {
  return { styles: listStyles(), trackIndex: animTrackIndex() };
}

/** Everything the panel needs to (re)draw the tab: jobs next to this Premiere project. */
async function animState(_params, _helpers, ctx) {
  let dir;
  try {
    dir = await projectDirOf(ctx);
  } catch (e) {
    return { projectDir: null, jobs: [], busy: !!ctx.animOp, error: e.message };
  }
  const a = anim(ctx);
  a.projectDir = dir;
  const jobs = loadJobsFrom(dir);
  for (const j of jobs) {
    j.projectDir = dir; // the folder may have moved since the job was saved
    // keep the in-memory copy (it may hold a fresher sessionId mid-write)
    if (!a.jobs.has(j.id)) a.jobs.set(j.id, j);
  }
  return {
    projectDir: dir,
    busy: !!ctx.animOp,
    jobs: [...a.jobs.values()].filter((j) => j.projectDir === dir).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0)).map((j) => jobSummary(j, ctx)),
  };
}

/**
 * Create an animation job: either for the selected contiguous segments, or —
 * with params.raw — a standalone one of a chosen length that lands at the
 * playhead and ignores the transcript entirely. First run also sets up the
 * animation workspace (npm install) — progress streams to the panel.
 */
async function animCreate(params, helpers, ctx) {
  return cancellableAnim(ctx, async (token) => {
    const dir = await projectDirOf(ctx);
    const a = anim(ctx);
    a.projectDir = dir;
    const kitPath = await ensureKit({ onProgress: helpers.progress, token });
    if (token.aborted) throw new Error("Cancelled");
    helpers.progress("Creating the animation…");
    const common = {
      style: params.style,
      background: params.background,
      trackIndex: params.track,
      width: params.width,
      height: params.height,
      projectDir: dir,
    };
    const job = params.raw
      ? await createRawJob(ctx, { ...common, durationSec: params.durationSec }, kitPath)
      : await createJob(ctx, { ...common, indexes: params.segments, seeFrames: !!params.seeFrames, onProgress: helpers.progress, token }, kitPath);
    a.jobs.set(job.id, job);
    return { job: jobSummary(job, ctx), message: `Animation ${job.id} created (${fmtDur(job.durationInFrames / job.fps)}). Tell the agent what to build.` };
  });
}

/**
 * One chat turn with the animation agent. Streams animEvent pushes (delta /
 * tool / status / placed); resolves when the turn — and any auto render +
 * placement the agent triggered via render.json — completes.
 */
async function animChat(params, _helpers, ctx) {
  return cancellableAnim(ctx, async (token) => {
    const job = getJob(ctx, params.jobId);
    const text = String(params.text || "").trim();
    const images = Array.isArray(params.images) ? params.images : [];
    if (!text && !images.length) throw new Error("Type a message first.");

    const kitPath = await ensureKit({ onProgress: (m) => pushEvent(ctx, job.id, { kind: "status", text: m }), token });
    if (token.aborted) throw new Error("Cancelled");

    const refs = images.map((im) => saveRefImage(job, kitPath, im.name, im.data));
    appendChat(job, { role: "user", text, images: refs.map((r) => basename(r)) });
    try {
      return await runTurn();
    } catch (e) {
      reportTurnFailure(ctx, job, e, token);
      throw e;
    }

    async function runTurn() {
      const firstTurn = !job.sessionId;
      let prompt = text;
      if (refs.length) {
        prompt += `\n\n[The user attached ${refs.length} reference image(s): ${refs.join(", ")}. View them with the Read tool.]`;
      }
      if (firstTurn) {
        prompt = `[First message for job ${job.id}. Read src/jobs/${job.id}/brief.md before answering.]\n\n` + prompt;
      }

      const startedAt = Date.now();
      let streamed = "";
      const tools = [];
      const turn = await runChatTurn({
        kitDirPath: kitPath,
        job,
        prompt,
        styleSkill: readStyleSkill(job.style),
        framesSkill: job.seeFrames ? readFramesSkill() : "",
        model: params.model,
        effort: params.effort,
        token,
        onEvent: (ev) => {
          if (ev.kind === "delta") streamed += ev.text;
          else if (ev.kind === "tool") tools.push({ name: ev.name, detail: ev.detail });
          pushEvent(ctx, job.id, ev);
        },
      });

      job.sessionId = turn.sessionId;
      const assistantText = (turn.text && turn.text.trim()) || streamed;
      // When this turn triggered a render, the placed notice IS the reply: the
      // agent's final prose is persisted hidden and never shown as a bubble.
      const signal = readRenderSignal(job, kitPath);
      const willRender = !!(signal && signal.version > (job.lastRenderedVersion || 0));
      appendChat(job, { role: "assistant", text: assistantText, tools, ...(willRender ? { hidden: true } : {}) });
      snapshotScene(job, kitPath);
      saveJob(job);
      const tokens = ((turn.usage && turn.usage.input_tokens) || 0) + ((turn.usage && turn.usage.output_tokens) || 0);
      recordUsage({
        type: "claude",
        purpose: "Animation chat",
        model: params.model || "latest",
        effort: params.effort || null,
        calls: 1,
        durationMs: Date.now() - startedAt,
        inputTokens: (turn.usage && turn.usage.input_tokens) || 0,
        outputTokens: (turn.usage && turn.usage.output_tokens) || 0,
        costUsd: 0, // subscription
      });
      pushEvent(ctx, job.id, { kind: "assistantDone", text: willRender ? "" : assistantText, tools });

      // The agent signals "ready" by bumping render.json — render + place now.
      let placedMsg = null;
      if (willRender) {
        if (token.aborted) throw new Error("Cancelled");
        // Frame-aware: prove the anchored drawings against the footage first.
        // A FAIL goes back to the agent (bounded rounds) before anything renders.
        let finalSignal = signal;
        let frameNote = null;
        let extraTokens = 0;
        if (job.seeFrames) {
          const v = await verifyWithFixups(ctx, job, kitPath, { model: params.model, effort: params.effort, token, onTokens: (n) => { extraTokens += n; } });
          frameNote = v.note;
          finalSignal = readRenderSignal(job, kitPath) || signal;
        }
        const done = await renderPlaceOrReport(ctx, job, kitPath, finalSignal, token, { tokens: tokens + extraTokens, startedAt, extraNote: frameNote });
        placedMsg = done.text;
      }

      pushEvent(ctx, job.id, { kind: "turnDone" });
      return {
        ok: turn.ok,
        text: willRender ? "" : assistantText,
        tools,
        placed: placedMsg,
        sessionId: job.sessionId,
        message: placedMsg || (turn.ok ? "Reply received." : assistantText),
      };
    }
  });
}

/**
 * Render + place the version the agent already signalled, without another chat
 * turn. This is the retry for a render that died on its own (a recycled browser
 * tab, a crashed renderer): the scene is finished and paid for, only the render
 * failed.
 */
async function animRender(params, _helpers, ctx) {
  return cancellableAnim(ctx, async (token) => {
    const job = getJob(ctx, params.jobId);
    const kitPath = await ensureKit({ onProgress: (m) => pushEvent(ctx, job.id, { kind: "status", text: m }), token });
    if (token.aborted) throw new Error("Cancelled");
    const signal = readRenderSignal(job, kitPath);
    if (!signal) throw new Error("There is nothing to render yet. Ask the agent to build the animation first.");
    if (signal.version <= (job.lastRenderedVersion || 0)) {
      throw new Error("This version is already on the timeline. Ask for a change to get a new one.");
    }
    let done;
    try {
      done = await renderPlaceOrReport(ctx, job, kitPath, signal, token);
    } catch (e) {
      reportTurnFailure(ctx, job, e, token);
      throw e;
    }
    pushEvent(ctx, job.id, { kind: "turnDone" });
    return { placed: done.text, message: done.text };
  });
}

/**
 * Set a raw animation's length from its chat. Refused mid-turn: the agent is
 * building against the current frame count, and the manifest would change under
 * a render that's already running.
 */
async function animSetLength(params, _helpers, ctx) {
  if (ctx.animOp) throw new Error("The animation agent is still working. Wait for it to finish or press Stop, then change the length.");
  const job = getJob(ctx, params.jobId);
  const kitPath = await ensureKit({});
  setRawLength(job, kitPath, params.durationSec);
  const dur = job.durationInFrames / job.fps;
  const text = `Length set to ${fmtDur(dur)}.` +
    (job.lastRenderedVersion ? " Ask for a new version to re-render at the new length." : "");
  appendChat(job, { role: "system", kind: "length", text });
  return { job: jobSummary(job, ctx), message: text };
}

/** Stop the in-flight chat turn / render (kills the child processes). */
async function animCancel(_params, _helpers, ctx) {
  if (ctx.animOp) {
    ctx.animOp.aborted = true;
    if (ctx.animOp.child) { try { ctx.animOp.child.kill("SIGTERM"); } catch { /* gone */ } }
    if (ctx.animOp.children) for (const c of ctx.animOp.children) { try { c.kill("SIGTERM"); } catch { /* gone */ } }
  }
  return { cancelled: true };
}

/**
 * Remove an animation from the list: its composition leaves the kit (so it
 * stops rendering) and it is flagged discarded. Rendered files stay on disk by
 * default so a clip already on the timeline doesn't go offline — deleting
 * timeline content is the user's call in Premiere.
 */
async function animDiscard(params, _helpers, ctx) {
  if (ctx.animOp) throw new Error("The animation agent is still working. Stop it first.");
  const job = getJob(ctx, params.jobId);
  const kitPath = await ensureKit({});
  discardJob(job, kitPath, { deleteOutputs: params.deleteOutputs === true });
  anim(ctx).jobs.delete(job.id);
  return { ok: true, message: `Deleted ${job.id} from the list.` + (params.deleteOutputs ? "" : " Any clip it placed stays on the timeline (its rendered file is kept).") };
}

export const animHandlers = { animStyles, animState, animCreate, animChat, animRender, animCancel, animDiscard, animSetLength };
