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
import { ensureKit, listStyles, readStyleSkill } from "./kit.js";
import {
  createJob, discardJob, loadJobsFrom, readChat, appendChat, saveJob, snapshotScene,
  readRenderSignal, saveRefImage, animTrackIndex,
} from "./jobs.js";
import { runChatTurn } from "./chat.js";
import { renderJob, renderScale } from "./render.js";
import { reconcile, requireReview } from "../review.js";
import { callHostHealing, getTimeline, mmss, round3 } from "../tools/util.js";
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

function jobSummary(job) {
  return {
    id: job.id,
    title: job.title || job.id,
    createdAt: job.createdAt,
    style: job.style,
    background: job.background,
    trackIndex: job.trackIndex != null ? job.trackIndex : animTrackIndex(),
    fps: job.fps,
    width: job.width,
    height: job.height,
    durationInFrames: job.durationInFrames,
    durationSec: round3(job.durationInFrames / job.fps),
    range: job.range,
    segmentIndexes: job.segmentIndexes,
    sequence: job.sequence,
    lastRenderedVersion: job.lastRenderedVersion || 0,
    renders: job.renders || [],
    placed: job.placed || null,
    outDir: job.outDir, // so the panel's folder button can reveal it in Finder/Explorer
    chat: readChat(job),
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
        warning = `Heads up: the selected segments now span ${liveDur.toFixed(2)}s on the timeline but the animation is ${expected.toFixed(2)}s (the timeline changed after this animation was created).`;
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
async function renderAndPlace(ctx, job, kitPath, signal, token) {
  const status = (text) => pushEvent(ctx, job.id, { kind: "status", text });
  // Match the LIVE sequence's resolution, even when the job's captured size is
  // wrong or the sequence changed: same-aspect mismatches render with --scale,
  // different-aspect mismatches get a plain warning instead of a distorted clip.
  let scale = 1;
  let scaleWarning = null;
  try {
    const timeline = await getTimeline(ctx);
    const s = renderScale(job, timeline.sequence && timeline.sequence.frameSizeHorizontal, timeline.sequence && timeline.sequence.frameSizeVertical);
    scale = s.scale;
    scaleWarning = s.warning;
    if (s.outWidth && s.scale !== 1) status(`Rendering at the sequence's ${s.outWidth}p width…`);
  } catch { /* host unreachable for the size check: render at the job's own size */ }
  const renderInfo = await renderJob({ kitDirPath: kitPath, job, version: signal.version, scale, token, onProgress: status });
  const placeInfo = await placeRender(ctx, job, renderInfo, status);
  if (signal.title) job.title = signal.title; // the agent named what it built
  job.lastRenderedVersion = signal.version;
  job.renders = job.renders || [];
  job.renders.push({ version: signal.version, file: renderInfo.file, ts: Date.now(), notes: signal.notes || "" });
  job.placed = { ...placeInfo, file: renderInfo.file, version: signal.version };
  saveJob(job);
  const text =
    (placeInfo.ok
      ? `Animation v${signal.version} placed on V${placeInfo.trackIndex + 1} at ${mmss(placeInfo.targetSeconds)}.`
      : `Animation v${signal.version} rendered, but Premiere didn't confirm it landed. Check the timeline.`) +
    (scaleWarning ? " " + scaleWarning : "") +
    (placeInfo.warning ? " " + placeInfo.warning : "");
  appendChat(job, { role: "system", kind: "placed", text, targetSeconds: placeInfo.targetSeconds, trackIndex: placeInfo.trackIndex });
  pushEvent(ctx, job.id, { kind: "placed", version: signal.version, file: renderInfo.file, ok: placeInfo.ok, targetSeconds: placeInfo.targetSeconds, text });
  return { renderInfo, placeInfo, text };
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
    jobs: [...a.jobs.values()].filter((j) => j.projectDir === dir).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0)).map(jobSummary),
  };
}

/**
 * Create an animation job for the selected contiguous segments. First run also
 * sets up the animation workspace (npm install) — progress streams to the panel.
 */
async function animCreate(params, helpers, ctx) {
  return cancellableAnim(ctx, async (token) => {
    const dir = await projectDirOf(ctx);
    const a = anim(ctx);
    a.projectDir = dir;
    const kitPath = await ensureKit({ onProgress: helpers.progress, token });
    if (token.aborted) throw new Error("Cancelled");
    helpers.progress("Creating the animation…");
    const job = await createJob(ctx, {
      indexes: params.segments,
      style: params.style,
      background: params.background,
      trackIndex: params.track,
      projectDir: dir,
    }, kitPath);
    a.jobs.set(job.id, job);
    return { job: jobSummary(job), message: `Animation ${job.id} created (${round3(job.durationInFrames / job.fps)}s). Tell the agent what to build.` };
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
    appendChat(job, { role: "assistant", text: assistantText, tools });
    snapshotScene(job, kitPath);
    saveJob(job);
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
    pushEvent(ctx, job.id, { kind: "assistantDone", text: assistantText, tools });

    // The agent signals "ready" by bumping render.json — render + place now.
    let placedMsg = null;
    const signal = readRenderSignal(job, kitPath);
    if (signal && signal.version > (job.lastRenderedVersion || 0)) {
      if (token.aborted) throw new Error("Cancelled");
      const done = await renderAndPlace(ctx, job, kitPath, signal, token);
      placedMsg = done.text;
    }

    pushEvent(ctx, job.id, { kind: "turnDone" });
    return {
      ok: turn.ok,
      text: assistantText,
      tools,
      placed: placedMsg,
      sessionId: job.sessionId,
      message: placedMsg || (turn.ok ? "Reply received." : assistantText),
    };
  });
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

export const animHandlers = { animStyles, animState, animCreate, animChat, animCancel, animDiscard };
