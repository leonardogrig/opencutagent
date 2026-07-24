// Animation job lifecycle. A job = one animation for one contiguous run of
// transcript segments: a composition folder in the kit workspace
// (src/jobs/<id>/ — where the chat agent works) plus a user-visible output
// folder NEXT TO THE PREMIERE PROJECT ("OpenCutAgent Animations/<id>/") holding
// the chat history, job record, and rendered files (so Premiere's media lives
// with the project, not in a cache).
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { reconcile, requireReview } from "../review.js";
import { readCachedWords } from "../transcription/transcribe.js";
import { round3, mmss } from "../tools/util.js";
import { kitDir } from "./kit.js";
import { liveEnv } from "../config.js";
import { log } from "../log.js";

export const ANIM_DIRNAME = "OpenCutAgent Animations";
/** Default 0-based video track for placement (V2); the panel's Track select overrides per job. */
export function animTrackIndex() {
  const v = parseInt(liveEnv("EDITAGENT_ANIM_TRACK") || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

/** Normalize a panel-chosen track index: integers V1..V16 pass (the panel warns about V1's overwrite), anything else falls back to the default. Pure (unit-tested). */
export function clampTrackIndex(v) {
  if (v == null || v === "") return animTrackIndex(); // Number(null) is 0 — don't let "unset" mean V1
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 15 ? n : animTrackIndex();
}

export function newJobId(now = Date.now()) {
  return "anim-" + now.toString(36);
}

/**
 * Validate a panel-chosen output size. Returns {width,height} rounded DOWN to
 * even numbers (h264 yuv420p refuses odd dimensions) or null when the values
 * aren't a usable size, so garbage falls back to the sequence size. Pure
 * (unit-tested).
 */
export function normalizeSizeOverride(w, h) {
  const W = Math.round(Number(w)), H = Math.round(Number(h));
  if (!Number.isFinite(W) || !Number.isFinite(H)) return null;
  if (W < 16 || H < 16 || W > 8192 || H > 8192) return null;
  return { width: W - (W % 2), height: H - (H % 2) };
}

/** "18432" -> "18.4k" for the placed-notice token count. Pure (unit-tested). */
export function fmtTokens(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v < 1000) return String(v);
  const k = v / 1000;
  return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "")) + "k";
}

/** Milliseconds -> "45s" / "3m 12s" for the placed notice. Pure (unit-tested). */
export function fmtElapsed(ms) {
  const raw = Number(ms);
  if (!Number.isFinite(raw) || raw < 0) return null;
  const s = Math.round(raw / 1000);
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + "m " + (s % 60) + "s";
}

/**
 * A human title for a job, at most `max` characters: derived from the selected
 * narration at creation, replaced by the agent's own name for the animation
 * once it builds one (render.json "title"). Pure (unit-tested).
 */
export function jobTitle(text, max = 20) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!t) return "Animation";
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > Math.floor(max / 2) ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

/* ============================ selection ============================ */

/**
 * Validate that the chosen segment indexes form ONE contiguous run of
 * still-present segments (the user may only select a sequence with no segments
 * in between). `map` is reconcile()'s array. Pure (unit-tested).
 * @returns {{ok:boolean, error?:string, range?:{startSec:number,endSec:number}, indexes?:number[]}}
 */
export function validateSelection(segments, map, indexes) {
  const want = [...new Set((indexes || []).map(Number))].filter(Number.isInteger).sort((a, b) => a - b);
  if (!want.length) return { ok: false, error: "Select at least one segment first." };
  const byIndex = new Map(map.map((m) => [m.index, m]));

  for (const i of want) {
    const m = byIndex.get(i);
    if (!m) return { ok: false, error: `Segment #${i} isn't loaded. Reload the segments and reselect.` };
    if (m.state !== "present") {
      return { ok: false, error: `Segment #${i} isn't on the timeline anymore (${m.state}). Select only segments that are still present.` };
    }
  }

  // Contiguity is judged over the PRESENT segments in timeline order: removed
  // segments between two selected ones are already gone from the timeline, so
  // they don't break adjacency; a present segment in between does.
  const presentOrder = segments
    .map((s) => s.index)
    .filter((i) => { const m = byIndex.get(i); return m && m.state === "present"; });
  const pos = new Map(presentOrder.map((idx, at) => [idx, at]));
  const at = want.map((i) => pos.get(i)).sort((a, b) => a - b);
  for (let k = 1; k < at.length; k++) {
    if (at[k] !== at[k - 1] + 1) {
      return { ok: false, error: "Selected segments must be next to each other, with no segments in between." };
    }
  }

  const first = byIndex.get(want[0]);
  const last = byIndex.get(want[want.length - 1]);
  const range = { startSec: round3(first.liveStartSec), endSec: round3(last.liveEndSec) };
  if (!(range.endSec > range.startSec)) return { ok: false, error: "The selected range has no duration." };
  return { ok: true, range, indexes: want };
}

/* ============================ manifest ============================ */

const ident = (id) => "Scene_" + String(id).replace(/[^A-Za-z0-9_]/g, "_");

/** Source of the generated src/jobs/manifest.ts for these job entries. Pure (unit-tested). */
export function manifestSource(entries) {
  const lines = [
    "/**",
    " * AUTO-GENERATED by the OpenCutAgent server. Do not edit by hand: the server",
    " * rewrites this file whenever a job is created or removed. Each job folder",
    " * (`src/jobs/<id>/`) owns its `Scene.tsx`; this file only registers them.",
    " */",
    'import type { JobEntry } from "./types";',
  ];
  for (const e of entries) lines.push(`import ${ident(e.id)} from "./${e.id}/Scene";`);
  lines.push("", "export const jobs: JobEntry[] = [");
  for (const e of entries) {
    lines.push(
      `  { id: ${JSON.stringify(e.id)}, component: ${ident(e.id)}, fps: ${e.fps}, width: ${e.width}, height: ${e.height}, durationInFrames: ${e.durationInFrames} },`
    );
  }
  lines.push("];", "");
  return lines.join("\n");
}

/** Rewrite the workspace manifest from the job folders actually on disk. */
export function regenerateManifest(dir = kitDir()) {
  const jobsDir = join(dir, "src", "jobs");
  const entries = [];
  let names = [];
  try { names = readdirSync(jobsDir, { withFileTypes: true }); } catch { names = []; }
  for (const e of names) {
    if (!e.isDirectory()) continue;
    const jp = join(jobsDir, e.name, "job.json");
    const sp = join(jobsDir, e.name, "Scene.tsx");
    if (!existsSync(jp) || !existsSync(sp)) continue;
    try {
      const j = JSON.parse(readFileSync(jp, "utf8"));
      if (j && j.id === e.name && j.fps > 0 && j.width > 0 && j.height > 0 && j.durationInFrames > 0) {
        entries.push({ id: j.id, fps: j.fps, width: j.width, height: j.height, durationInFrames: j.durationInFrames });
      }
    } catch { /* skip a corrupt job folder */ }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(jobsDir, "manifest.ts"), manifestSource(entries));
  return entries.length;
}

/* ============================ scaffold ============================ */

/** The starter Scene.tsx the agent replaces. Pure (unit-tested). */
export function sceneScaffold(job, { styleHasSrc = false } = {}) {
  const transparent = job.background === "transparent";
  const styleHint = styleHasSrc
    ? `\n// This job's style ships its own components: import them from\n// "../../../styles/${job.style}/src" (the style guide documents each one).`
    : "";
  return `import React from "react";
import { useVideoConfig, interpolate, useCurrentFrame } from "remotion";
import { Canvas, SketchLayer } from "../../components";
import { SketchText } from "../../sketch";
import { tokens } from "../../theme/tokens";

// ${job.id}: scaffold scene. Read brief.md in this folder, then replace this
// placeholder with the real animation. Duration/size/fps are fixed (useVideoConfig).${styleHint}
const Scene: React.FC = () => {
  const { width, height, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const draw = interpolate(frame, [0, Math.min(45, durationInFrames)], [0, 1], {
    extrapolateRight: "clamp",
  });
  return (
    <Canvas transparent={${transparent}}>
      <SketchLayer>
        <SketchText
          x={width / 2}
          y={height / 2}
          size={tokens.fontSize.h3}
          color={tokens.color.inkMuted}
          opacity={draw}
        >
          ${JSON.stringify(job.id + " placeholder").slice(1, -1)}
        </SketchText>
      </SketchLayer>
    </Canvas>
  );
};

export default Scene;
`;
}

/* ============================ brief ============================ */

const esc = (s) => String(s == null ? "" : s);

/**
 * The assignment document written into the job folder for the agent. Word
 * timings are optional (they come from the transcript cache when available).
 * Pure (unit-tested).
 */
export function buildBrief(job, { selected, transcriptLines, wordsBySegment = new Map() }) {
  const durSec = round3(job.durationInFrames / job.fps);
  const lines = [
    `# Animation brief: ${job.id}`,
    "",
    `- Canvas: ${job.width}x${job.height} @ ${job.fps} fps`,
    `- Duration: ${job.durationInFrames} frames (${durSec}s). FIXED: fill exactly this time.`,
    `- Background: ${job.background === "transparent" ? "transparent (overlay on the footage; use <Canvas transparent>)" : "solid dark canvas (covers the footage like b-roll; use <Canvas>)"}`,
    `- Style: ${job.style}`,
    "",
    "## The narration you are animating (the selected timeline range)",
    "Times are seconds relative to the animation start (t=0 is your first frame).",
    "The voiceover plays on the Premiere timeline under your clip; sync your visual beats to it.",
    "",
  ];
  for (const s of selected) {
    lines.push(`- [${s.relStart.toFixed(2)}s - ${s.relEnd.toFixed(2)}s] ${esc(s.text) || "(no speech)"}`);
    const words = wordsBySegment.get(s.index);
    if (words && words.length) {
      lines.push(`  words: ${words.map((w) => `${esc(w.text)}@${w.rel.toFixed(2)}`).join(" ")}`);
    }
  }
  lines.push(
    "",
    "## Full video transcript (context only)",
    "So you understand the topic around this moment. Lines marked >>> are the selected range.",
    ""
  );
  for (const t of transcriptLines) lines.push(t);
  lines.push("");
  return lines.join("\n");
}

/* ============================ create / persist ============================ */

/** Round a sequence rate to something Remotion-friendly (30.00003 -> 30; 29.97 stays). */
export function renderFps(fps) {
  const n = Number(fps) || 30;
  const r = Math.round(n);
  if (Math.abs(n - r) < 0.01) return r;
  return Math.round(n * 1000) / 1000;
}

export function jobsRootFor(projectDir) {
  return join(projectDir, ANIM_DIRNAME);
}

export function saveJob(job) {
  mkdirSync(job.outDir, { recursive: true });
  writeFileSync(join(job.outDir, "job.json"), JSON.stringify(job, null, 2));
}

export function loadJobsFrom(projectDir) {
  const root = jobsRootFor(projectDir);
  const jobs = [];
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return jobs; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const j = JSON.parse(readFileSync(join(root, e.name, "job.json"), "utf8"));
      // Discarded jobs stay on disk (their rendered clips may still be on the
      // timeline and must not go offline) but leave the panel's list.
      if (j && j.id && !j.discarded) { j.outDir = join(root, e.name); jobs.push(j); }
    } catch { /* skip */ }
  }
  jobs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return jobs;
}

export function readChat(job) {
  try {
    const parsed = JSON.parse(readFileSync(join(job.outDir, "chat.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function appendChat(job, entry) {
  const all = readChat(job);
  all.push({ ts: Date.now(), ...entry });
  try { writeFileSync(join(job.outDir, "chat.json"), JSON.stringify(all, null, 2)); }
  catch (e) { log("chat persist failed (ignored):", e.message); }
  return all;
}

/**
 * Create a job from the current selection: validates contiguity against the
 * LIVE timeline, captures size/fps from the sequence, scaffolds the kit job
 * folder + brief, registers the composition, and persists the job record next
 * to the Premiere project.
 */
export async function createJob(ctx, { indexes, style, background, trackIndex, projectDir, width: widthOpt, height: heightOpt }, kitDirPath) {
  const review = requireReview(ctx);
  const { map, timeline } = await reconcile(ctx);
  const check = validateSelection(review.segments, map, indexes);
  if (!check.ok) throw new Error(check.error);

  const seq = timeline.sequence || {};
  const fps = renderFps(seq.frameRate || review.frameRate || 30);
  // The panel may pin an explicit output size (4K/vertical/custom); otherwise
  // the composition matches the sequence. sizeSource:"custom" also disables the
  // render-time sequence-size matching, so the user's choice always wins.
  const override = normalizeSizeOverride(widthOpt, heightOpt);
  const width = override ? override.width : (Number(seq.frameSizeHorizontal) || 1920);
  const height = override ? override.height : (Number(seq.frameSizeVertical) || 1080);
  if (!override && (!Number(seq.frameSizeHorizontal) || !Number(seq.frameSizeVertical))) {
    // Render-time --scale still corrects same-aspect sizes, but log the gap.
    log(`animation: sequence frame size unavailable, composing at ${width}x${height}`);
  }
  const durationSec = check.range.endSec - check.range.startSec;
  const durationInFrames = Math.max(1, Math.round(durationSec * fps));
  if (durationSec < 0.5) throw new Error("The selected range is shorter than half a second. Select a longer run of segments.");

  const id = newJobId();
  const selText = check.indexes
    .map((i) => { const s = review.segments.find((x) => x.index === i); return (s && s.text) || ""; })
    .join(" ");
  const job = {
    id,
    title: jobTitle(selText),
    createdAt: Date.now(),
    style: style || "excalidraw",
    background: background === "transparent" ? "transparent" : "solid",
    trackIndex: clampTrackIndex(trackIndex),
    sizeSource: override ? "custom" : "sequence",
    fps, width, height, durationInFrames,
    range: check.range,
    segmentIndexes: check.indexes,
    sequence: review.sequence || null,
    sessionId: null,
    lastRenderedVersion: 0,
    renders: [],
    placed: null,
    projectDir,
    outDir: join(jobsRootFor(projectDir), id),
  };

  // Kit job folder (where the agent works)
  const jobDir = join(kitDirPath, "src", "jobs", id);
  mkdirSync(join(jobDir, "refs"), { recursive: true });
  writeFileSync(join(jobDir, "job.json"), JSON.stringify({
    id, fps, width, height, durationInFrames, background: job.background, style: job.style,
  }, null, 2));
  writeFileSync(join(jobDir, "Scene.tsx"), sceneScaffold(job, {
    styleHasSrc: existsSync(join(kitDirPath, "styles", job.style, "src", "index.ts")),
  }));

  // Brief: selected narration (with word timing when cached) + whole transcript
  const byIndex = new Map(map.map((m) => [m.index, m]));
  const selected = [];
  const wordsBySegment = new Map();
  const wordCache = new Map(); // mediaPath -> words
  for (const i of check.indexes) {
    const s = review.segments.find((x) => x.index === i);
    const m = byIndex.get(i);
    if (!s || !m) continue;
    const relStart = round3(m.liveStartSec - check.range.startSec);
    const relEnd = round3(m.liveEndSec - check.range.startSec);
    selected.push({ index: i, relStart, relEnd, text: s.text });
    if (s.mediaPath && s.sourceInSec != null && s.sourceOutSec != null) {
      if (!wordCache.has(s.mediaPath)) wordCache.set(s.mediaPath, readCachedWords(s.mediaPath, ctx.cacheDir));
      const words = wordCache.get(s.mediaPath)
        .filter((w) => w.type !== "spacing" && w.start >= s.sourceInSec - 0.05 && w.start < s.sourceOutSec)
        .map((w) => ({ text: String(w.text || "").trim(), rel: round3(relStart + Math.max(0, w.start - s.sourceInSec)) }))
        .filter((w) => w.text);
      if (words.length) wordsBySegment.set(i, words);
    }
  }
  const selectedSet = new Set(check.indexes);
  const transcriptLines = review.segments
    .filter((s) => s.text && s.fragment !== "empty")
    .map((s) => `${selectedSet.has(s.index) ? ">>> " : "- "}[${mmss(s.startSec)}] ${s.text}`);
  writeFileSync(join(jobDir, "brief.md"), buildBrief(job, { selected, transcriptLines, wordsBySegment }));

  regenerateManifest(kitDirPath);
  saveJob(job);
  appendChat(job, { role: "system", kind: "created", text: `Animation created for ${selected.length} segment(s), ${round3(durationSec)}s.` });
  return job;
}

/**
 * Discard a job: its composition leaves the kit (stops rendering) and it is
 * flagged discarded so the list no longer shows it. The output folder is KEPT
 * by default — a rendered clip already on the timeline references its file, and
 * deleting it would knock the clip offline. deleteOutputs erases everything.
 */
export function discardJob(job, kitDirPath, { deleteOutputs = false } = {}) {
  try { rmSync(join(kitDirPath, "src", "jobs", job.id), { recursive: true, force: true }); } catch { /* ignore */ }
  regenerateManifest(kitDirPath);
  if (deleteOutputs) {
    try { rmSync(job.outDir, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    try { saveJob({ ...job, discarded: true }); } catch { /* ignore */ }
  }
}

/** Snapshot the agent's scene source into the output folder (posterity/survives kit resets). */
export function snapshotScene(job, kitDirPath) {
  try {
    const src = join(kitDirPath, "src", "jobs", job.id, "Scene.tsx");
    if (existsSync(src)) copyFileSync(src, join(job.outDir, "Scene.tsx"));
  } catch { /* best-effort */ }
}

/** The kit-side render.json sentinel the agent writes when the scene is ready. */
export function readRenderSignal(job, kitDirPath) {
  try {
    const parsed = JSON.parse(readFileSync(join(kitDirPath, "src", "jobs", job.id, "render.json"), "utf8"));
    const version = parseInt(parsed && parsed.version, 10);
    if (Number.isFinite(version) && version > 0) {
      return {
        version,
        notes: typeof parsed.notes === "string" ? parsed.notes : "",
        title: typeof parsed.title === "string" && parsed.title.trim() ? jobTitle(parsed.title) : null,
      };
    }
  } catch { /* absent or malformed: not ready */ }
  return null;
}

/** Persist an uploaded chat image into the job's refs/ folder; returns its relative path. */
export function saveRefImage(job, kitDirPath, name, dataBase64) {
  const safe = basename(String(name || "image.png")).replace(/[^\w.@-]+/g, "_").slice(-80) || "image.png";
  const dir = join(kitDirPath, "src", "jobs", job.id, "refs");
  mkdirSync(dir, { recursive: true });
  let file = safe;
  let n = 1;
  while (existsSync(join(dir, file))) {
    const dot = safe.lastIndexOf(".");
    file = dot > 0 ? `${safe.slice(0, dot)}-${n}${safe.slice(dot)}` : `${safe}-${n}`;
    n++;
  }
  writeFileSync(join(dir, file), Buffer.from(String(dataBase64 || ""), "base64"));
  return `src/jobs/${job.id}/refs/${file}`;
}
