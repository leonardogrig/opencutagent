// Unit checks for the Animation tab's pure logic: contiguous-selection
// validation, manifest generation, the scene scaffold + agent brief, render-fps
// normalization, the render.json signal, job persistence, and the chat/render
// parsing helpers. No Premiere, no claude, no Remotion needed.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSelection, manifestSource, sceneScaffold, buildBrief, renderFps, newJobId,
  regenerateManifest, readRenderSignal, saveRefImage, saveJob, loadJobsFrom, readChat, appendChat,
  jobsRootFor, animTrackIndex, discardJob, jobTitle, clampTrackIndex,
  normalizeSizeOverride, fmtTokens, fmtElapsed, normalizeRawDuration, buildRawBrief, createRawJob, buildWordsJson,
  sequenceFrameSize, setRawLength,
} from "../animation/jobs.js";
import { listStyles, readStyleSkill, readFramesSkill, kitDir as animWorkspaceDir, mergePreservedGuide, guideVersion, KIT_TEMPLATE_DIR } from "../animation/kit.js";
import {
  parseVideoSize, fitTransform, canvasMapFilter, frameName,
  mergeFrameSpans, prepareFrameAssets, removeFrameAssets, v1FrameSpans,
  planExportTimes, timecodesFor, verifyJobAnchors, verifyRounds, KIT_SCRIPTS_DIR,
} from "../animation/frames.js";
import { buildFilter } from "../../animation-kit/scripts/grab-frames.mjs";
import {
  changedBlocks, pixelChange, detectChanges, shotsFromChanges, blackSpans, pickFrames, nearestFrameIndex,
  judgeAnchor, formatAnchorReport, clampRect, regionThumbSize, grayFrames, readTimeSec, countWords,
} from "../../animation-kit/scripts/frame-analysis.mjs";
import { parseAnchors, anchorSamples, runAnchorCheck } from "../../animation-kit/scripts/check-anchors.mjs";
import { execFileSync } from "node:child_process";
import { ffmpegBin } from "../paths.js";
import { toolDetail, buildSystemAppend } from "../animation/chat.js";
import { claudeSpawnEnv } from "../ai.js";
import { liveEnv } from "../config.js";
import { parseFfDuration, parseRenderProgress, renderScale, isTransientRenderError, renderConcurrency } from "../animation/render.js";

let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/* ---------- validateSelection ---------- */
// Segments 0..5; #2 was removed (absent), #4 is present but "in between" for some picks.
const segs = [0, 1, 2, 3, 4, 5].map((i) => ({ index: i }));
const map = [
  { index: 0, state: "present", liveStartSec: 0, liveEndSec: 2 },
  { index: 1, state: "present", liveStartSec: 2, liveEndSec: 5 },
  { index: 2, state: "absent", liveStartSec: null, liveEndSec: null },
  { index: 3, state: "present", liveStartSec: 5, liveEndSec: 9 },
  { index: 4, state: "present", liveStartSec: 9, liveEndSec: 12 },
  { index: 5, state: "partial", liveStartSec: 12, liveEndSec: 13 },
];

let r = validateSelection(segs, map, [0, 1]);
check("adjacent present pair is valid", r.ok === true && approx(r.range.startSec, 0) && approx(r.range.endSec, 5), r);
r = validateSelection(segs, map, [1, 3]);
check("removed segment between two picks doesn't break adjacency", r.ok === true && approx(r.range.endSec, 9), r);
r = validateSelection(segs, map, [1, 4]);
check("present segment in between rejects the selection", r.ok === false && /next to each other/.test(r.error), r);
r = validateSelection(segs, map, [2, 3]);
check("absent segment can't be selected", r.ok === false && /isn't on the timeline/.test(r.error), r);
r = validateSelection(segs, map, [5]);
check("partial segment can't be selected", r.ok === false, r);
r = validateSelection(segs, map, []);
check("empty selection rejected", r.ok === false, r);
r = validateSelection(segs, map, [3]);
check("single segment is valid", r.ok === true && approx(r.range.startSec, 5) && approx(r.range.endSec, 9), r);
r = validateSelection(segs, map, [4, 3, 3]);
check("order/duplicates normalized", r.ok === true && r.indexes.join(",") === "3,4", r);

/* ---------- manifestSource ---------- */
const src = manifestSource([
  { id: "anim-abc", fps: 30, width: 1920, height: 1080, durationInFrames: 450 },
  { id: "anim-x-2", fps: 29.97, width: 3840, height: 2160, durationInFrames: 100 },
]);
check("manifest imports each scene", src.includes('import Scene_anim_abc from "./anim-abc/Scene";') && src.includes('import Scene_anim_x_2 from "./anim-x-2/Scene";'), src);
check("manifest registers entries with numbers intact", src.includes('{ id: "anim-abc", component: Scene_anim_abc, fps: 30, width: 1920, height: 1080, durationInFrames: 450 }'), src);
check("empty manifest is valid TS", manifestSource([]).includes("export const jobs: JobEntry[] = ["), manifestSource([]));

/* ---------- sceneScaffold / buildBrief ---------- */
const job = {
  id: "anim-test1",
  style: "excalidraw",
  background: "transparent",
  fps: 30, width: 1920, height: 1080, durationInFrames: 300,
  range: { startSec: 10, endSec: 20 },
};
const scaffold = sceneScaffold(job);
check("scaffold is transparent-aware", scaffold.includes("<Canvas transparent={true}>"), scaffold);
check("scaffold names the job", scaffold.includes("anim-test1"), null);
check("solid scaffold uses solid canvas", sceneScaffold({ ...job, background: "solid" }).includes("transparent={false}"), null);
check("scaffold points at the style package when it ships src", sceneScaffold({ ...job, style: "n8n" }, { styleHasSrc: true }).includes('"../../../styles/n8n/src"'), null);
check("scaffold stays generic for a skill-only style", !scaffold.includes("styles/"), null);

const brief = buildBrief(job, {
  selected: [
    { index: 4, relStart: 0, relEnd: 4.2, text: "hello there" },
    { index: 5, relStart: 4.2, relEnd: 10, text: "welcome back" },
  ],
  transcriptLines: ["- [0:01] intro line", ">>> [0:10] hello there"],
  wordsBySegment: new Map([[4, [{ text: "hello", rel: 0.1 }, { text: "there", rel: 0.6 }]]]),
});
check("brief pins the duration in frames", brief.includes("300 frames (10s). FIXED"), brief);
check("brief lists the selected narration with relative times", brief.includes("[0.00s - 4.20s] hello there"), brief);
check("brief carries word timing when cached", brief.includes("hello@0.10 there@0.60"), brief);
check("brief includes the full transcript context", brief.includes(">>> [0:10] hello there"), brief);
check("brief explains transparent mode", /transparent \(overlay/.test(brief), brief);

/* ---------- raw animations (no transcript, user-chosen length) ---------- */
check("normalizeRawDuration: a plain length passes", normalizeRawDuration(5) === 5 && normalizeRawDuration("7.5") === 7.5, [normalizeRawDuration(5), normalizeRawDuration("7.5")]);
check("normalizeRawDuration: out-of-range/garbage is refused (never a silent default)",
  normalizeRawDuration(0.2) === null && normalizeRawDuration(601) === null &&
  normalizeRawDuration("x") === null && normalizeRawDuration(null) === null, null);
const rawBrief = buildRawBrief({
  id: "anim-raw1", style: "excalidraw", background: "solid",
  fps: 30, width: 3840, height: 2160, durationInFrames: 150,
  range: { startSec: 650.5, endSec: 655.5 },
});
check("raw brief pins the duration in frames", rawBrief.includes("150 frames (5s). FIXED"), rawBrief);
check("raw brief says there is no narration to follow", /NOT tied to the video's transcript/.test(rawBrief) && /no narration/.test(rawBrief), rawBrief);
check("raw brief names where the clip lands", rawBrief.includes("10:50"), rawBrief);
check("raw brief carries no transcript section", !rawBrief.includes("Full video transcript"), rawBrief);
// getTimeline() normalizes the host's frameSizeHorizontal/Vertical into
// frameSize{}; reading only one shape composed everything at 1920x1080.
check("sequenceFrameSize reads the normalized shape", JSON.stringify(sequenceFrameSize({ frameSize: { width: 3840, height: 2160 } })) === '{"width":3840,"height":2160}', sequenceFrameSize({ frameSize: { width: 3840, height: 2160 } }));
check("sequenceFrameSize reads the raw host shape", JSON.stringify(sequenceFrameSize({ frameSizeHorizontal: 1920, frameSizeVertical: 1080 })) === '{"width":1920,"height":1080}', null);
check("sequenceFrameSize is null when the host can't report it", sequenceFrameSize({}) === null && sequenceFrameSize(null) === null, null);

/* ---------- renderFps ---------- */
check("30.00003 rounds to 30", renderFps(30.00003) === 30, renderFps(30.00003));
check("29.97 stays fractional", approx(renderFps(29.97), 29.97, 0.001), renderFps(29.97));
check("bad fps falls back to 30", renderFps(NaN) === 30, renderFps(NaN));

/* ---------- job id + track + title ---------- */
check("job ids are composition-safe", /^anim-[a-z0-9]+$/.test(newJobId()), newJobId());
check("default animation track is V2 (index 1)", animTrackIndex() === 1, animTrackIndex());
check("clampTrackIndex: a chosen V3 passes", clampTrackIndex(2) === 2, clampTrackIndex(2));
check("clampTrackIndex: V1 is allowed (user's call; the panel warns)", clampTrackIndex(0) === 0, clampTrackIndex(0));
check("clampTrackIndex: garbage falls back to the default", clampTrackIndex("x") === 1 && clampTrackIndex(null) === 1 && clampTrackIndex(-2) === 1, null);
check("jobTitle: short text passes through", jobTitle("Webhook branches") === "Webhook branches", jobTitle("Webhook branches"));
const longTitle = jobTitle("For example, I've just asked it a really long question");
check("jobTitle: long text truncates to <= 20 chars on a word", longTitle.length <= 20 && longTitle.endsWith("…"), longTitle);
check("jobTitle: empty text falls back", jobTitle("") === "Animation" && jobTitle("   ") === "Animation", null);

/* ---------- output-size override + placed-notice formatting ---------- */
let sz = normalizeSizeOverride(3840, 2160);
check("normalizeSizeOverride: 4K passes through", sz && sz.width === 3840 && sz.height === 2160, sz);
sz = normalizeSizeOverride(1081, 1921);
check("normalizeSizeOverride: odd dims round down to even", sz && sz.width === 1080 && sz.height === 1920, sz);
sz = normalizeSizeOverride("2560", "1440.4");
check("normalizeSizeOverride: numeric strings accepted", sz && sz.width === 2560 && sz.height === 1440, sz);
check("normalizeSizeOverride: absent/garbage/out-of-range is null (sequence size wins)",
  normalizeSizeOverride(null, null) === null && normalizeSizeOverride(undefined, undefined) === null &&
  normalizeSizeOverride("x", 1080) === null && normalizeSizeOverride(1920, 8) === null &&
  normalizeSizeOverride(9000, 1080) === null, null);
check("fmtTokens: sub-1k literal, k with one decimal, big k rounded",
  fmtTokens(950) === "950" && fmtTokens(18432) === "18.4k" && fmtTokens(123456) === "123k" && fmtTokens(21000) === "21k",
  [fmtTokens(950), fmtTokens(18432), fmtTokens(123456), fmtTokens(21000)]);
check("fmtTokens: zero/garbage is null", fmtTokens(0) === null && fmtTokens("x") === null, null);
check("fmtElapsed: seconds then minutes", fmtElapsed(45000) === "45s" && fmtElapsed(192000) === "3m 12s", [fmtElapsed(45000), fmtElapsed(192000)]);
check("fmtElapsed: garbage is null", fmtElapsed("x") === null && fmtElapsed(-5) === null, null);

/* ---------- kit: styles registry + skill ---------- */
const styles = listStyles();
check("excalidraw style is registered", styles.some((s) => s.id === "excalidraw" && s.default), styles);
check("n8n style is registered (not default)", styles.some((s) => s.id === "n8n" && !s.default && !s.custom), styles);
check("style skill is readable", /Learnings log/i.test(readStyleSkill("excalidraw")), null);
check("n8n skill teaches its shipped components", /SketchNode/.test(readStyleSkill("n8n")) && /Learnings log/i.test(readStyleSkill("n8n")), null);
if (existsSync(join(KIT_TEMPLATE_DIR, "styles", "n8n-brand"))) { // private style package, absent in public checkouts
  check("n8n-brand style is registered (not default, ships src)", styles.some((s) => s.id === "n8n-brand" && !s.default && !s.custom), styles);
  const skill = readStyleSkill("n8n-brand");
  check("n8n-brand skill teaches its shipped components + log", /BrandCanvas/.test(skill) && /Capsule/.test(skill) && /PixelGlyph/.test(skill) && /Learnings log/i.test(skill), null);
  check("n8n-brand skill forbids the sketch engine", /NOT hand-drawn/i.test(skill) && /no rough\.js/i.test(skill), null);
  check("n8n-brand skill has no em dashes", !/\u2014/.test(skill), null);
  const brandSrc = join(KIT_TEMPLATE_DIR, "styles", "n8n-brand", "src");
  check("n8n-brand package ships theme + index + inlined fonts", ["theme.ts", "index.ts", "fontdata/interTight.ts", "fontdata/geistMono.ts"].every((f) => existsSync(join(brandSrc, f))), null);
  const theme = readFileSync(join(brandSrc, "theme.ts"), "utf8");
  check("n8n-brand theme carries the signature pink + five modes", /#FF91AC/.test(theme) && ["neutralLight", "neutralDark", "maker", "pinkLight", "pinkDark"].every((m) => theme.includes(m + ":")), null);
  check("scaffold points at the n8n-brand package", sceneScaffold({ ...job, style: "n8n-brand" }, { styleHasSrc: true }).includes('"../../../styles/n8n-brand/src"'), null);
}
// Leo pixel presenter: a talking-character style, lip sync fed by words.json
check("leo style is registered (not default, ships src)", styles.some((s) => s.id === "leo" && !s.default && !s.custom), styles);
{
  const skill = readStyleSkill("leo");
  check("leo skill teaches words.json lip sync + its components + log", /words\.json/.test(skill) && /LeoCorner/.test(skill) && /PixelPanel/.test(skill) && /timeOffset/.test(skill) && /Never hand-time/.test(skill) && /Learnings log/i.test(skill), null);
  check("leo skill forbids the sketch engine and em dashes", /NOT hand-drawn/.test(skill) && /no rough\.js/.test(skill) && !/—/.test(skill), null);
  const leoSrc = join(KIT_TEMPLATE_DIR, "styles", "leo", "src");
  check("leo package ships palette + sprite + lipsync + motion + component + index", ["palette.ts", "sprite.ts", "lipsync.ts", "motion.ts", "Leo.tsx", "index.ts"].every((f) => existsSync(join(leoSrc, f))), null);
  const sprite = readFileSync(join(leoSrc, "sprite.ts"), "utf8");
  check("leo sprite has every viseme the lip sync can emit + a cap variant", ["rest", "mm", "ah", "ee", "oh", "oo", "fv", "smile", "grin", "laugh"].every((v) => new RegExp(`\\b${v}:\\s+\\[`).test(sprite)) && /CAP_BRIM/.test(sprite), null);
  check("scaffold points at the leo package", sceneScaffold({ ...job, style: "leo" }, { styleHasSrc: true }).includes('"../../../styles/leo/src"'), null);
  // words.json builder: flattens per-segment words, keeps end only when it is after start, sorts
  const wb = new Map([
    [7, [{ text: "later", rel: 4.2, end: 4.6 }, { text: "bad", rel: 5.0, end: 4.9 }]],
    [3, [{ text: "first", rel: 0.1, end: 0.4 }, { text: "", rel: 0.5 }, { text: "noRel" }]],
  ]);
  const wj = buildWordsJson(wb);
  check("buildWordsJson flattens, sorts by start, drops a bad end and empty/untimed words", JSON.stringify(wj) === JSON.stringify([
    { text: "first", start: 0.1, end: 0.4 }, { text: "later", start: 4.2, end: 4.6 }, { text: "bad", start: 5.0 },
  ]), wj);
  check("buildWordsJson of nothing is an empty list", JSON.stringify(buildWordsJson()) === "[]" && JSON.stringify(buildWordsJson(new Map())) === "[]", null);
}

if (existsSync(join(KIT_TEMPLATE_DIR, "styles", "n8n-ui"))) { // private style package, absent in public checkouts
  check("n8n-ui style is registered (not default, ships src)", styles.some((s) => s.id === "n8n-ui" && !s.default && !s.custom), styles);
  const skill = readStyleSkill("n8n-ui");
  check("n8n-ui skill teaches its shipped components + log", /UiFrame/.test(skill) && /WorkflowCanvas/.test(skill) && /NodeCreator/.test(skill) && /NDV/.test(skill) && /Cursor/.test(skill) && /WorkflowSettings/.test(skill) && /Learnings log/i.test(skill), null);
  check("n8n-ui skill forbids the sketch engine", /NOT hand-drawn/i.test(skill) && /no rough\.js/i.test(skill), null);
  check("n8n-ui skill demands node-for-node workflow fidelity from screenshots", /node for node/i.test(skill) && /screenshot/i.test(skill), null);
  check("n8n-ui skill has no em dashes", !/\u2014/.test(skill), null);
  check("n8n-ui skill teaches editorial pacing, cursor discipline and the emphasis zoom", /Editorial pacing/.test(skill) && /Cursor discipline/.test(skill) && /emphasisAt/.test(skill) && /readTime/.test(skill) && /ArrowNote/.test(skill), null);
  const uiSrc = join(KIT_TEMPLATE_DIR, "styles", "n8n-ui", "src");
  check("n8n-ui package ships theme + index + inlined icons + catalogue", ["theme.ts", "index.ts", "iconfiles.ts", "iconData.ts", "nodeCatalog.ts", "Shell.tsx", "WorkflowCanvas.tsx", "WorkflowMenu.tsx", "WorkflowSettings.tsx"].every((f) => existsSync(join(uiSrc, f))), null);
  const theme = readFileSync(join(uiSrc, "theme.ts"), "utf8");
  check("n8n-ui theme carries the app's dark palette", /#171717/.test(theme) && /#262626/.test(theme) && /#2b2b2b/.test(theme) && /#ff6900/.test(theme), null);
  const icons = readFileSync(join(uiSrc, "iconfiles.ts"), "utf8");
  check("n8n-ui logos are inlined data URIs (no public/ assets)", /"gmail\.svg": "data:image\/svg\+xml;base64,/.test(icons) && !existsSync(join(KIT_TEMPLATE_DIR, "public", "n8n-icons")), null);
  check("scaffold points at the n8n-ui package", sceneScaffold({ ...job, style: "n8n-ui" }, { styleHasSrc: true }).includes('"../../../styles/n8n-ui/src"'), null);
}
check("unknown style skill is empty", readStyleSkill("nope") === "", readStyleSkill("nope"));

/* ---------- workspace-file helpers (temp dirs) ---------- */
const tmp = mkdtempSync(join(tmpdir(), "ocatest-"));
try {
  // regenerateManifest scans job folders
  const kitDir = join(tmp, "kit");
  mkdirSync(join(kitDir, "src", "jobs", "anim-aaa"), { recursive: true });
  writeFileSync(join(kitDir, "src", "jobs", "anim-aaa", "job.json"), JSON.stringify({ id: "anim-aaa", fps: 30, width: 1920, height: 1080, durationInFrames: 60 }));
  writeFileSync(join(kitDir, "src", "jobs", "anim-aaa", "Scene.tsx"), "export default null;");
  mkdirSync(join(kitDir, "src", "jobs", "broken"), { recursive: true }); // no job.json/Scene -> skipped
  const count = regenerateManifest(kitDir);
  const manifest = readFileSync(join(kitDir, "src", "jobs", "manifest.ts"), "utf8");
  check("regenerateManifest registers valid job folders only", count === 1 && manifest.includes("anim-aaa") && !manifest.includes("broken"), manifest);

  // render.json signal
  const j2 = { id: "anim-aaa" };
  check("no render.json means no signal", readRenderSignal(j2, kitDir) === null, null);
  writeFileSync(join(kitDir, "src", "jobs", "anim-aaa", "render.json"), JSON.stringify({ version: 2, notes: "first pass" }));
  const sig = readRenderSignal(j2, kitDir);
  check("render.json signal parses", sig && sig.version === 2 && sig.notes === "first pass" && sig.title === null, sig);
  writeFileSync(join(kitDir, "src", "jobs", "anim-aaa", "render.json"), JSON.stringify({ version: 3, title: "A very long animation title from the agent" }));
  const sig2 = readRenderSignal(j2, kitDir);
  check("render.json title is adopted and clamped to 20 chars", sig2 && sig2.title && sig2.title.length <= 20, sig2);
  writeFileSync(join(kitDir, "src", "jobs", "anim-aaa", "render.json"), "{bad json");
  check("malformed render.json is ignored", readRenderSignal(j2, kitDir) === null, null);

  // ref images: sanitized + deduped names
  const p1 = saveRefImage(j2, kitDir, "my shot (1).png", Buffer.from("a").toString("base64"));
  const p2 = saveRefImage(j2, kitDir, "my shot (1).png", Buffer.from("b").toString("base64"));
  check("ref image saved under the job", p1 === "src/jobs/anim-aaa/refs/my_shot_1_.png" && existsSync(join(kitDir, p1)), p1);
  check("duplicate ref names get a suffix", p2 !== p1 && existsSync(join(kitDir, p2)), p2);

  // job + chat persistence next to the "project"
  const projectDir = join(tmp, "proj");
  const job3 = { id: "anim-bbb", createdAt: 5, fps: 30, width: 1, height: 1, durationInFrames: 10, projectDir, outDir: join(jobsRootFor(projectDir), "anim-bbb") };
  saveJob(job3);
  appendChat(job3, { role: "user", text: "hi" });
  appendChat(job3, { role: "assistant", text: "hello", tools: [{ name: "Write", detail: "Scene.tsx" }] });
  const loaded = loadJobsFrom(projectDir);
  check("jobs load back from the project folder", loaded.length === 1 && loaded[0].id === "anim-bbb", loaded);
  const chat = readChat(loaded[0]);
  check("chat log persists in order", chat.length === 2 && chat[0].role === "user" && chat[1].tools[0].name === "Write", chat);

  // custom styles: a package dropped into the WORKSPACE's styles/ is discovered,
  // flagged custom, and its skill reads from the workspace; a shipped style with
  // the same id shadows a workspace copy.
  const wsHome = join(tmp, "anim-home");
  mkdirSync(join(wsHome, "styles", "mystyle"), { recursive: true });
  writeFileSync(join(wsHome, "styles", "mystyle", "style.json"), JSON.stringify({ id: "mystyle", name: "My Style", description: "hand-made" }));
  writeFileSync(join(wsHome, "styles", "mystyle", "SKILL.md"), "custom skill text");
  mkdirSync(join(wsHome, "styles", "excalidraw"), { recursive: true });
  writeFileSync(join(wsHome, "styles", "excalidraw", "style.json"), JSON.stringify({ id: "excalidraw", name: "Shadowed" }));
  const prevHome = process.env.EDITAGENT_ANIM_HOME;
  process.env.EDITAGENT_ANIM_HOME = wsHome;
  if (animWorkspaceDir() === wsHome) {
    const merged = listStyles();
    check("workspace custom style is listed and flagged", merged.some((s) => s.id === "mystyle" && s.custom === true && s.name === "My Style"), merged);
    const exca = merged.find((s) => s.id === "excalidraw");
    check("shipped style shadows a workspace copy with the same id", exca && exca.name === "Excalidraw" && !exca.custom, exca);
    check("custom style skill reads from the workspace", readStyleSkill("mystyle") === "custom skill text", readStyleSkill("mystyle"));
  } else {
    console.log("SKIP  custom-style checks (EDITAGENT_ANIM_HOME is pinned in .env)");
  }
  if (prevHome === undefined) delete process.env.EDITAGENT_ANIM_HOME;
  else process.env.EDITAGENT_ANIM_HOME = prevHome;

  // createRawJob end to end against a fake host: no review is loaded at all
  // (a raw animation must work before anything is transcribed).
  {
    const rawProject = join(tmp, "rawproj");
    const rawKit = join(tmp, "rawkit");
    mkdirSync(join(rawKit, "src", "jobs"), { recursive: true });
    const ctx = {
      bridge: {
        callHost: async (action) => {
          if (action === "getTimelineState") {
            return {
              sequence: {
                name: "Seq 01", frameRate: 30.00003, timebase: 8475667, dropFrame: false,
                frameSizeHorizontal: 3840, frameSizeVertical: 2160,
                videoTrackCount: 4, audioTrackCount: 4,
              },
              clips: [], gaps: [],
            };
          }
          if (action === "getPlayhead") return { seconds: 650.5, vTracks: 4 };
          throw new Error("Unknown action " + action);
        },
      },
    };
    const rawJob = await createRawJob(ctx, { durationSec: 5, style: "excalidraw", background: "solid", trackIndex: 2, projectDir: rawProject }, rawKit);
    check("raw job needs no loaded segments", rawJob.raw === true && rawJob.segmentIndexes.length === 0, rawJob);
    check("raw job takes the sequence's real size and fps", rawJob.width === 3840 && rawJob.height === 2160 && rawJob.fps === 30 && rawJob.sizeSource === "sequence", rawJob);
    check("raw job length becomes fixed frames", rawJob.durationInFrames === 150, rawJob.durationInFrames);
    check("raw job is anchored at the playhead", approx(rawJob.range.startSec, 650.5) && approx(rawJob.range.endSec, 655.5), rawJob.range);
    check("raw job keeps the chosen track", rawJob.trackIndex === 2, rawJob.trackIndex);
    check("raw job scaffolds a brief + scene the agent can open",
      existsSync(join(rawKit, "src", "jobs", rawJob.id, "brief.md")) &&
      readFileSync(join(rawKit, "src", "jobs", rawJob.id, "words.json"), "utf8") === "[]" &&
      existsSync(join(rawKit, "src", "jobs", rawJob.id, "Scene.tsx")) &&
      readFileSync(join(rawKit, "src", "jobs", "manifest.ts"), "utf8").includes(rawJob.id), null);
    check("raw job's created notice says where it lands", /10:50/.test(readChat(rawJob)[0].text) && /V3/.test(readChat(rawJob)[0].text), readChat(rawJob)[0]);
    let rawErr = null;
    try { await createRawJob(ctx, { durationSec: 0, projectDir: rawProject }, rawKit); } catch (e) { rawErr = e.message; }
    check("raw job refuses an unusable length", /between 0.5 and 600/.test(rawErr || ""), rawErr);
    const defaulted = await createRawJob(ctx, { projectDir: rawProject }, rawKit);
    check("raw job with no length takes the 5s default (it's set in the chat)", defaulted.durationInFrames === 150, defaulted.durationInFrames);

    // setRawLength: the length is edited INSIDE the chat, so it rewrites the
    // composition facts without ever touching the agent's Scene.tsx.
    const sceneBefore = readFileSync(join(rawKit, "src", "jobs", rawJob.id, "Scene.tsx"), "utf8");
    writeFileSync(join(rawKit, "src", "jobs", rawJob.id, "Scene.tsx"), "// the agent's work\n" + sceneBefore);
    setRawLength(rawJob, rawKit, 8);
    const kitJson = JSON.parse(readFileSync(join(rawKit, "src", "jobs", rawJob.id, "job.json"), "utf8"));
    check("setRawLength retimes the composition", rawJob.durationInFrames === 240 && kitJson.durationInFrames === 240, [rawJob.durationInFrames, kitJson.durationInFrames]);
    check("setRawLength keeps the placement anchor and moves the end", approx(rawJob.range.startSec, 650.5) && approx(rawJob.range.endSec, 658.5), rawJob.range);
    check("setRawLength never overwrites the agent's scene",
      readFileSync(join(rawKit, "src", "jobs", rawJob.id, "Scene.tsx"), "utf8").startsWith("// the agent's work"), null);
    check("setRawLength refreshes the brief the agent reads",
      readFileSync(join(rawKit, "src", "jobs", rawJob.id, "brief.md"), "utf8").includes("240 frames (8s)"), null);
    check("setRawLength persists to the job record on disk",
      JSON.parse(readFileSync(join(rawJob.outDir, "job.json"), "utf8")).durationInFrames === 240, null);
    let lenErr = null;
    try { setRawLength(rawJob, rawKit, 9999); } catch (e) { lenErr = e.message; }
    check("setRawLength refuses an unusable length", /between 0.5 and 600/.test(lenErr || "") && rawJob.durationInFrames === 240, lenErr);
    lenErr = null;
    try { setRawLength({ ...rawJob, raw: false }, rawKit, 8); } catch (e) { lenErr = e.message; }
    check("setRawLength refuses a segment-based job (the timeline sets its length)", /follows the timeline/.test(lenErr || ""), lenErr);
  }

  // discard: flagged + kept on disk (a placed clip's render must not go offline), gone from the list
  discardJob(loaded[0], kitDir);
  const onDisk = JSON.parse(readFileSync(join(job3.outDir, "job.json"), "utf8"));
  check("discard flags the job instead of deleting its files", onDisk.discarded === true && existsSync(join(job3.outDir, "chat.json")), onDisk);
  check("discarded jobs leave the list", loadJobsFrom(projectDir).length === 0, loadJobsFrom(projectDir));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/* ---------- chat helpers ---------- */
check("toolDetail shows the edited file", toolDetail("Edit", { file_path: "/x/y/Scene.tsx" }) === "Scene.tsx", toolDetail("Edit", { file_path: "/x/y/Scene.tsx" }));
check("toolDetail prefers the bash description", toolDetail("Bash", { command: "npx tsc", description: "Typecheck" }) === "Typecheck", null);
const sys = buildSystemAppend({ id: "anim-z", fps: 30, width: 1920, height: 1080, durationInFrames: 90, background: "solid", style: "excalidraw" }, "STYLE GUIDE HERE");
check("system prompt pins the job folder + duration", sys.includes("src/jobs/anim-z/") && sys.includes("duration 90 frames (3.00s)"), sys);
check("system prompt embeds the style skill", sys.includes("<style-skill>") && sys.includes("STYLE GUIDE HERE"), null);
check("system prompt teaches the render.json protocol", sys.includes('render.json as {"version": N'), null);
const rawSys = buildSystemAppend({ id: "anim-r", fps: 30, width: 1920, height: 1080, durationInFrames: 90, background: "solid", style: "excalidraw", raw: true }, "S");
check("raw system prompt tells the agent there is no transcript", /STANDALONE/.test(rawSys) && /no transcript for this one/.test(rawSys) && !/narration with word timings/.test(rawSys), rawSys);

/* ---------- headless spawn env (API-key scrub + pinned Claude login dir) ---------- */
{
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevDir = process.env.EDITAGENT_CLAUDE_CONFIG_DIR;
  process.env.ANTHROPIC_API_KEY = "sk-stray";
  process.env.EDITAGENT_CLAUDE_CONFIG_DIR = "/tmp/claude-test-cfg";
  // liveEnv prefers the real project .env over process.env, so assert against
  // whatever it resolves (machine-independent either way).
  const expectedDir = liveEnv("EDITAGENT_CLAUDE_CONFIG_DIR");
  const env = claudeSpawnEnv();
  check("spawn env scrubs a stray ANTHROPIC_API_KEY", !("ANTHROPIC_API_KEY" in env), env.ANTHROPIC_API_KEY);
  check("spawn env pins CLAUDE_CONFIG_DIR from EDITAGENT_CLAUDE_CONFIG_DIR", !!expectedDir && env.CLAUDE_CONFIG_DIR === expectedDir, env.CLAUDE_CONFIG_DIR);
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  if (prevDir === undefined) delete process.env.EDITAGENT_CLAUDE_CONFIG_DIR; else process.env.EDITAGENT_CLAUDE_CONFIG_DIR = prevDir;
}

/* ---------- render scale (sequence-resolution self-heal) ---------- */
{
  const j = { width: 1920, height: 1080 };
  check("renderScale: matching sequence renders 1:1", renderScale(j, 1920, 1080).scale === 1 && renderScale(j, 1920, 1080).warning === null, renderScale(j, 1920, 1080));
  const up = renderScale(j, 3840, 2160);
  check("renderScale: 4K sequence upscales a 1080p composition 2x", up.scale === 2 && up.outWidth === 3840 && up.warning === null, up);
  const down = renderScale({ width: 3840, height: 2160 }, 1920, 1080);
  check("renderScale: downscale works too", approx(down.scale, 0.5), down);
  const vert = renderScale(j, 1080, 1920);
  check("renderScale: aspect mismatch warns instead of distorting", vert.scale === 1 && /different shape/.test(vert.warning), vert);
  check("renderScale: unknown sequence size renders at the job's own size", renderScale(j, null, undefined).scale === 1 && renderScale(j, 0, 0).warning === null, renderScale(j, null, undefined));
}

/* ---------- interrupted-turn detection ---------- */
{
  const { turnInterrupted } = await import("../animation/index.js");
  const userLast = [{ role: "system" }, { role: "user", text: "make it blue" }];
  const replied = [...userLast, { role: "assistant", text: "done" }];
  const errored = [...userLast, { role: "system", kind: "error", text: "died" }];
  check("interrupted: a user message with no reply is flagged", turnInterrupted(userLast, false) === true);
  check("interrupted: a reply clears it", turnInterrupted(replied, false) === false);
  check("interrupted: a persisted error clears it", turnInterrupted(errored, false) === false);
  check("interrupted: a running turn is never 'interrupted'", turnInterrupted(userLast, true) === false);
  check("interrupted: an empty chat is fine", turnInterrupted([], false) === false && turnInterrupted(null, false) === false);
}

/* ---------- concurrency by resolution ---------- */
{
  check("concurrency: 1080p uses Remotion's default", renderConcurrency(1920, 1080) === null);
  check("concurrency: 1440p is capped", renderConcurrency(2560, 1440) === 4);
  check("concurrency: 4K is capped harder", renderConcurrency(3840, 2160) === 3);
  check("concurrency: vertical 4K counts pixels, not width", renderConcurrency(2160, 3840) === 3);
  check("concurrency: unknown size leaves the default", renderConcurrency(null, undefined) === null);
}

/* ---------- transient render failures (worth a silent retry) ---------- */
{
  // The live failure that motivated this: frame 3270 of 5990, a recycled tab
  // that never finished loading the font.
  const fontHang = 'remotion render failed (exit 1). A delayRender() "Loading font Excalifont" was called but not cleared after 118000ms.';
  check("transient: a delayRender timeout retries", isTransientRenderError(fontHang) === true);
  check("transient: a crashed renderer retries", isTransientRenderError("remotion render failed (exit 1). Error: the renderer crashed") === true);
  check("transient: a closed puppeteer target retries", isTransientRenderError("Protocol error: Target closed") === true);
  check("transient: a cancel is NOT retried", isTransientRenderError("Cancelled") === false);
  check("transient: our own hard stop is NOT retried", isTransientRenderError("remotion render timed out after 30 min.") === false);
  check("transient: a wedged render (no progress) IS retried", isTransientRenderError("remotion render stopped reporting progress for 10 min and looked stuck, so it was stopped.") === true);
  check("transient: a real scene error is NOT retried", isTransientRenderError("remotion render failed (exit 2). ReferenceError: foo is not defined") === false);
  check("transient: empty input is safe", isTransientRenderError(undefined) === false);
}

/* ---------- frame-aware jobs ("Use frames") ---------- */
{
  // ffmpeg -i stderr parsing (media fallback): the codec tag (0x31637634) must never match.
  const ffInfo = "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637634), yuv420p(tv, bt709), 2560x1440 [SAR 1:1 DAR 16:9], 4570 kb/s, 30 fps\n  Stream #0:1[0x2](und): Audio: aac, 48000 Hz, stereo";
  const size = parseVideoSize(ffInfo);
  check("frames: video size parses past the codec tag", size && size.width === 2560 && size.height === 1440, size);
  check("frames: audio-only stderr yields no size", parseVideoSize("  Stream #0:0: Audio: aac, 48000 Hz") === null, null);

  const fitSame = fitTransform(1920, 1080, 3840, 2160);
  check("frames: same-aspect fit scales with no letterbox", approx(fitSame.scale, 0.5) && fitSame.ox === 0 && fitSame.oy === 0, fitSame);
  const fitPillar = fitTransform(1920, 1080, 1440, 1080);
  check("frames: narrower source pillarboxes centered", approx(fitPillar.scale, 1) && fitPillar.ox === 240 && fitPillar.oy === 0, fitPillar);
  check("frames: canvas map filter fits then pads", canvasMapFilter(1920, 1080) === "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2", canvasMapFilter(1920, 1080));

  check("frames: names zero-pad and sort chronologically", frameName(3.2) === "t0003.20.png" && frameName(0) === "t0000.00.png" && frameName(9.5) < frameName(10), frameName(3.2));
  check("frames: a .999 fraction carries into the next second", frameName(59.999) === "t0060.00.png", frameName(59.999));

  const spans = mergeFrameSpans([
    { relStart: 0, relEnd: 2, mediaPath: "/a.mp4", sourceInSec: 10 },
    { relStart: 2, relEnd: 5, mediaPath: "/a.mp4", sourceInSec: 12 },      // contiguous in rel AND source -> merges
    { relStart: 5, relEnd: 7, mediaPath: "/a.mp4", sourceInSec: 40 },      // source jumps (a cut) -> stays separate
    { relStart: 7, relEnd: 8, mediaPath: "/b.mp4", sourceInSec: 45 },      // different media -> separate
  ]);
  check("frames: contiguous spans merge, cuts and media changes don't", spans.length === 3 && approx(spans[0].relEnd, 5) && approx(spans[1].sourceInSec, 40) && spans[2].mediaPath === "/b.mp4", spans);

  // Fallback source = the V1 track's clips under the selection.
  const clip = (over) => ({
    name: "c", trackType: "video", trackIndex: 0, mediaPath: "/v1.mp4", speedIsNormal: true,
    start: { seconds: 10 }, end: { seconds: 30 }, sourceIn: { seconds: 100 }, ...over,
  });
  const v1r = v1FrameSpans([
    clip({}),
    clip({ trackIndex: 1, mediaPath: "/v2-screen.mp4" }),
    clip({ trackType: "audio", mediaPath: "/a.mp4" }),
    clip({ name: "fast", start: { seconds: 30 }, end: { seconds: 40 }, speedIsNormal: false }),
    clip({ mediaPath: null }),
  ], { startSec: 20, endSec: 36 });
  check("frames: source spans come from V1 only, trimmed to the range",
    v1r.spans.length === 1 && approx(v1r.spans[0].relStart, 0) && approx(v1r.spans[0].relEnd, 10) && approx(v1r.spans[0].sourceInSec, 110) && v1r.spans[0].mediaPath === "/v1.mp4", v1r);
  check("frames: an off-speed V1 clip is skipped with a warning", v1r.warnings.length === 1 && /speed/.test(v1r.warnings[0]), v1r.warnings);
  check("frames: empty V1 in range yields no spans", v1FrameSpans([clip({ trackIndex: 2 })], { startSec: 0, endSec: 5 }).spans.length === 0, null);

  // Export planning: Premiere's own frames every step, ruler timecodes for QE.
  const p1 = planExportTimes(9.5, 0.5);
  check("frames: export times walk the range every step and stay inside the end", p1.step === 0.5 && p1.times.length === 19 && p1.times[0] === 0 && p1.times[18] === 9, p1);
  const p2 = planExportTimes(600, 0.5, 400);
  check("frames: a long range widens the step to stay under the frame cap", p2.step > 0.5 && p2.times.length <= 400 && p2.times.length > 300, [p2.step, p2.times.length]);
  check("frames: a zero-length range still exports its first frame", planExportTimes(0, 0.5).times.length === 1, planExportTimes(0, 0.5));
  const tcs = timecodesFor([0, 3.1], { startSec: 21.6, fps: 30, dropFrame: false, zeroPointFrames: 0 });
  check("frames: rel times become ruler timecodes + extension-less names (QE appends .png)", tcs[0].tc === "00:00:21:18" && tcs[1].tc === "00:00:24:21" && tcs[1].name === "t0003.10" && tcs[1].t === 3.1, tcs);
  const tcDf = timecodesFor([0], { startSec: 60, fps: 29.97, dropFrame: true, zeroPointFrames: 107892 });
  check("frames: drop-frame sequences get ';' timecodes including the zero point", /;/.test(tcDf[0].tc) && /^01:/.test(tcDf[0].tc), tcDf);
  check("frames: verify rounds default to 1 and clamp", verifyRounds() >= 0 && verifyRounds() <= 3, verifyRounds());

  // Change analysis on synthetic gray frames (32x18, 16x9 blocks of 2x2 px).
  const W = 32, H = 18;
  const flat = (v) => new Uint8Array(W * H).fill(v);
  const half = () => { const a = flat(20); for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) a[y * W + x] = 200; return a; };
  const cursor = () => { const a = flat(20); a[5 * W + 5] = 200; a[5 * W + 6] = 200; a[6 * W + 5] = 200; return a; };
  check("frames: identical frames change no blocks", changedBlocks(flat(20), flat(20), W, H) === 0, null);
  check("frames: half the screen swapped = half the blocks", approx(changedBlocks(flat(20), half(), W, H), 0.5), changedBlocks(flat(20), half(), W, H));
  check("frames: a cursor-sized change stays under the minor threshold", changedBlocks(flat(20), cursor(), W, H) < 0.10, changedBlocks(flat(20), cursor(), W, H));
  const pc = pixelChange(flat(20), half());
  check("frames: pixel change reports the changed fraction + mean", approx(pc.frac, 0.5) && approx(pc.meanAbs, 90), pc);
  const times = [0, 0.5, 1, 1.5, 2];
  const ch = detectChanges([flat(20), flat(20), half(), half(), cursor()], times, W, H);
  check("frames: screen changes are timed at the frame the new content first shows, major only when big", ch.length === 2 && ch[0].t === 1 && ch[0].kind === "major" && ch[1].t === 2 && ch[1].kind === "major", ch);
  const shots = shotsFromChanges(times, ch, 2.5);
  check("frames: shots are the stretches between major changes, with their duration", shots.length === 3 && shots[0].start === 0 && shots[0].end === 1 && shots[0].dur === 1 && shots[1].end === 2 && shots[2].end === 2.5 && shots[2].dur === 0.5, shots);
  const bl = blackSpans([flat(5), flat(5), flat(100), flat(3)], [0, 0.5, 1, 1.5], 0.5);
  check("frames: black spans merge adjacent black frames and cover each frame's step", bl.length === 2 && bl[0].start === 0 && bl[0].end === 1 && bl[1].start === 1.5 && bl[1].end === 2, bl);

  const fr = [{ t: 0, file: "a" }, { t: 0.5, file: "b" }, { t: 1, file: "c" }, { t: 1.5, file: "d" }];
  check("frames: nearest frame index", nearestFrameIndex(fr, 0.7) === 1 && nearestFrameIndex(fr, 9) === 3 && nearestFrameIndex([], 1) === -1, null);
  check("frames: picking at the export density returns every frame inside the window", pickFrames(fr, 0.2, 1.1, 0.5).map((f) => f.t).join() === "0.5,1", pickFrames(fr, 0.2, 1.1, 0.5));
  check("frames: a coarser pick walks ticks snapped to exported frames", pickFrames(fr, 0, 1.5, 1).map((f) => f.t).join() === "0,1", pickFrames(fr, 0, 1.5, 1));
  check("frames: an empty window still yields the nearest frame", pickFrames(fr, 0.2, 0.3, 0.5).map((f) => f.t).join() === "0", pickFrames(fr, 0.2, 0.3, 0.5));

  // The anchor judgement: is the target really there for the whole span?
  const A = flat(50), B = flat(200);
  const smallDiff = () => { const a = flat(50); for (let i = 0; i < Math.round(a.length * 0.06); i++) a[i] = 120; return a; };
  const samp = (arr) => arr.map(([t, r]) => ({ t, region: r }));
  const outl = judgeAnchor(samp([[1, A], [1.5, A], [2, A], [2.5, B], [3, B]]), { from: 1.5, to: 3, step: 0.5 });
  check("frames: a target that disappears mid-span FAILS as 'outlives' at the change time", outl.verdict === "fail" && outl.outlives && outl.outlives.from === 2.5 && !outl.startsEarly && outl.before && outl.before.same, outl);
  const early = judgeAnchor(samp([[1, B], [1.5, B], [2, A], [2.5, A], [3, A], [3.5, A]]), { from: 1.5, to: 3, step: 0.5 });
  check("frames: a drawing that starts before its target FAILS as 'startsEarly'", early.verdict === "fail" && early.startsEarly && early.startsEarly.until === 1.5 && !early.outlives && early.after && early.after.same, early);
  const okj = judgeAnchor(samp([[1, B], [1.5, A], [2, A], [2.5, A], [3, B]]), { from: 1.5, to: 2.5, step: 0.5 });
  check("frames: a target present for the whole span is OK, and the context says when it appears/disappears", okj.verdict === "ok" && okj.before && !okj.before.same && okj.after && !okj.after.same, okj);
  const warnj = judgeAnchor(samp([[1, A], [1.5, A], [2, smallDiff()]]), { from: 1, to: 2, step: 0.5 });
  check("frames: a small change (cursor pass) is a WARN, not a fail", warnj.verdict === "warn" && warnj.changes.length === 1, warnj);
  const motion = judgeAnchor(samp([[1, A], [1.5, B], [2, A]]), { from: 1, to: 2, step: 0.5, expectMotion: true });
  check("frames: expectMotion reports changes but never fails", motion.verdict === "ok" && motion.changes.length === 2, motion);
  // Time budget: text must be readable in the time the target is really there.
  check("frames: read time = settle + per word + draw-in; a bare stroke needs half a second", approx(readTimeSec(0), 0.5) && approx(readTimeSec(4, 0.4), 2.0) && countWords("  your alert  or an email ") === 5 && countWords("") === 0, [readTimeSec(0), readTimeSec(4, 0.4)]);
  const busy = judgeAnchor(samp([[8, B], [8.5, A], [9, B]]), { from: 8.55, to: 8.95, step: 0.5, words: 7 });
  check("frames: seven words on a target visible for 0.4s FAILS as too busy", busy.verdict === "fail" && busy.tooBusy && busy.tooBusy.words === 7 && busy.visibleSec === 0.4 && /Drop the text/.test(busy.notes.join(" ")), busy);
  const roomy = judgeAnchor(samp([[1, A], [1.5, A], [2, A], [2.5, A], [3, A]]), { from: 1, to: 3, step: 0.5, words: 3, drawIn: 0.3 });
  check("frames: three words over two seconds is fine", roomy.verdict === "ok" && !roomy.tooBusy && roomy.neededSec === 1.65, roomy);
  const shortened = judgeAnchor(samp([[1, A], [1.5, A], [2, A], [2.5, B], [3, B]]), { from: 1, to: 3, step: 0.5, words: 5 });
  check("frames: the budget counts only the time the target is really there (outlives shortens it)", shortened.verdict === "fail" && shortened.outlives && shortened.tooBusy && shortened.visibleSec === 1.5, shortened);
  const bare = judgeAnchor(samp([[8, B], [8.5, A], [9, B]]), { from: 8.55, to: 8.95, step: 0.5 });
  check("frames: a bare stroke on a 0.4s target passes with a 'too brief' hint", bare.verdict === "ok" && /too brief/.test(bare.notes.join(" ")), bare);
  const unk = judgeAnchor([], { from: 1, to: 2, step: 0.5 });
  check("frames: no frame anywhere near the span = unknown", unk.verdict === "unknown", unk);
  const flash = judgeAnchor(samp([[0.5, B], [1, A], [1.5, B]]), { from: 1.05, to: 1.45, step: 0.5, words: 3 });
  check("frames: a span shorter than the frame step is judged on the nearest frame, and the budget still applies", flash.verdict === "fail" && flash.tooBusy && /shorter than the frame step/.test(flash.notes.join(" ")), flash);
  const report = formatAnchorReport([{ id: "title", what: "the title", ...outl }, { id: "ok", ...okj }], { step: 0.5 });
  check("frames: the report names the failure and the fix", /title \(the title\).*FAIL/.test(report) && /gone/.test(report) && /1 anchor\(s\) FAIL/.test(report) && /appears between/.test(report), report);
  check("frames: rects clamp to the canvas", JSON.stringify(clampRect({ x: -5, y: 10.4, w: 3000, h: 20.2 }, 1920, 1080)) === '{"x":0,"y":10,"w":1920,"h":21}' && clampRect({ x: 2000, y: 0, w: 10, h: 10 }, 1920, 1080) === null, clampRect({ x: -5, y: 10.4, w: 3000, h: 20.2 }, 1920, 1080));
  const rts = regionThumbSize({ x: 0, y: 0, w: 1000, h: 250 });
  check("frames: region thumbs cap the width and keep the aspect", rts.w === 256 && rts.h === 64, rts);

  // grab-frames: local cutouts of the exported frames.
  const gmap = { canvas: { width: 1920, height: 1080 }, frameWidth: 1568, step: 0.5, frames: fr };
  const full = buildFilter(gmap, {});
  check("frames: full frames downscale and print a coordinate factor", full.vf === "scale=1568:-2" && approx(full.factor, 1.224, 0.001) && full.prefix === "", full);
  check("frames: a frame at canvas width needs no filter", buildFilter({ ...gmap, frameWidth: 4000 }, {}).vf === null, null);
  const crop = buildFilter(gmap, { crop: { x: 50, y: 60, w: 200, h: 100 } });
  check("frames: crops are 1:1 canvas pixels", crop.vf === "crop=200:100:50:60" && crop.factor === 1 && crop.prefix === "crop-x50y60-", crop);

  // check-anchors: manifest parsing + sampling window.
  const pa = parseAnchors({ anchors: [
    { id: "a", what: "x", rect: { x: 10, y: 10, w: 50, h: 20 }, from: 1, to: 2 },
    { id: "bad-rect", rect: { x: 0, y: 0, w: 0, h: 5 }, from: 1, to: 2 },
    { id: "bad-time", rect: { x: 0, y: 0, w: 5, h: 5 }, from: 2, to: 1 },
  ] }, 1920, 1080);
  check("frames: anchors.json validates rects and times", pa.anchors.length === 1 && pa.anchors[0].id === "a" && pa.errors.length === 2 && pa.anchors[0].words === 0, pa);
  const pt = parseAnchors({ anchors: [{ id: "t", rect: { x: 0, y: 0, w: 5, h: 5 }, from: 0, to: 1, text: "your alert or an email", drawIn: "0.4" }, { id: "w", rect: { x: 0, y: 0, w: 5, h: 5 }, from: 0, to: 1, words: 2 }] }, 100, 100);
  check("frames: anchors carry their text budget (text -> words, or a word count) and draw-in", pt.anchors[0].words === 5 && approx(pt.anchors[0].drawIn, 0.4) && pt.anchors[1].words === 2, pt.anchors);
  check("frames: a bare array is accepted too", parseAnchors([{ id: "z", rect: { x: 0, y: 0, w: 5, h: 5 }, from: 0, to: 1 }], 100, 100).anchors.length === 1, null);
  check("frames: samples span one step past both ends", anchorSamples(fr, 0.5, 1, 0.5).map((f) => f.t).join() === "0,0.5,1,1.5", anchorSamples(fr, 0.5, 1, 0.5));
  check("frames: a span with no frames samples the nearest one", anchorSamples(fr, 5, 6, 0.5).length === 1, anchorSamples(fr, 5, 6, 0.5));

  // Prompt + brief wiring.
  const fjob = { id: "anim-f", fps: 30, width: 1920, height: 1080, durationInFrames: 300, background: "transparent", style: "excalidraw", seeFrames: true };
  const fsys = buildSystemAppend(fjob, "S", "FRAMES GUIDE BODY");
  check("frames: system prompt carries the frames guide + the anchor check", /FRAME-AWARE/.test(fsys) && fsys.includes("<frames-skill>") && fsys.includes("FRAMES GUIDE BODY") && /check-anchors/.test(fsys), null);
  const plainSys = buildSystemAppend({ ...fjob, seeFrames: false }, "S", "FRAMES GUIDE BODY");
  check("frames: a normal job gets no frames guide", !plainSys.includes("<frames-skill>") && !/FRAME-AWARE/.test(plainSys), null);
  const fbrief = buildBrief(fjob, { selected: [{ index: 0, relStart: 0, relEnd: 10, text: "hi" }], transcriptLines: [] });
  check("frames: brief points at frames-map.json", fbrief.includes("frames-map.json") && fbrief.includes("Screen frames"), null);
  const plainBrief = buildBrief({ ...fjob, seeFrames: false }, { selected: [], transcriptLines: [] });
  check("frames: a normal brief has no frames section", !plainBrief.includes("frames-map.json"), null);
  const guide = readFileSync(join(KIT_SCRIPTS_DIR, "..", "frames", "SKILL.md"), "utf8");
  check("frames: readFramesSkill returns a guide", /DebugFrame/.test(readFramesSkill()), null);
  check("frames: the shipped frames guide is v3 with anchors, shots and the time budget", guideVersion(guide) >= 3 && /check-anchors/.test(guide) && /anchors\.json/.test(guide) && /shots/.test(guide) && /DebugFrame/.test(guide) && /0\.25s per word/.test(guide), null);

  // Preserved guides upgrade by version but keep the workspace's Learnings Log.
  const tmplGuide = "<!-- guide-version: 2 -->\n# Guide v2\nnew body\n\n## Learnings Log\n\nAppend here.\n";
  const wsGuide = "# Guide v1\nold body\n\n## Learnings Log\n\nAppend here.\n- 2026-07-01 keep circles 12px padded\n";
  const merged = mergePreservedGuide(tmplGuide, wsGuide);
  check("frames: a newer guide replaces the body and carries the log entries over", merged && merged.includes("new body") && !merged.includes("old body") && merged.includes("- 2026-07-01 keep circles 12px padded"), merged);
  check("frames: an equal-or-older template leaves the workspace guide alone", mergePreservedGuide(tmplGuide, merged) === null && mergePreservedGuide("# no version", wsGuide) === null, null);

  // prepareFrameAssets is best-effort: no ctx + missing media still writes the map.
  const fkit = mkdtempSync(join(tmpdir(), "oca-frames-"));
  mkdirSync(join(fkit, "src", "jobs", "anim-f"), { recursive: true });
  const prep = await prepareFrameAssets({ job: fjob, spans: [{ relStart: 0, relEnd: 5, mediaPath: join(fkit, "missing.mp4"), sourceInSec: 0 }], kitDirPath: fkit });
  check("frames: missing media degrades to a warning, not a throw", prep.hasVideo === false && prep.source === "none" && prep.warnings.length >= 1, prep);
  const mapOnDisk = JSON.parse(readFileSync(join(fkit, "src", "jobs", "anim-f", "frames-map.json"), "utf8"));
  check("frames: frames-map.json v2 is written even with no frames", mapOnDisk.version === 2 && mapOnDisk.jobId === "anim-f" && mapOnDisk.frames.length === 0 && mapOnDisk.canvas.width === 1920 && mapOnDisk.step === 0.5, mapOnDisk);
  check("frames: an empty job needs no anchor check", verifyJobAnchors(fjob, fkit).status === "none", verifyJobAnchors(fjob, fkit));

  // End-to-end anchor check on synthetic PNG frames (needs ffmpeg; skipped without it).
  let haveFf = false;
  try { execFileSync(ffmpegBin(), ["-version"], { stdio: "ignore" }); haveFf = true; } catch { /* no ffmpeg on this box */ }
  if (haveFf) {
    const fullDir = join(fkit, "public", "frames", "anim-f", "full");
    mkdirSync(fullDir, { recursive: true });
    const framesOnDisk = [];
    // 0..1.0s: a bright box (the "target") at (100,50,60,30); 1.5..2.5s: gone.
    for (let i = 0; i < 6; i++) {
      const t = i * 0.5;
      const file = frameName(t);
      const vf = t <= 1.0 ? "drawbox=100:50:60:30:color=white:t=fill" : "null";
      execFileSync(ffmpegBin(), ["-hide_banner", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=#202020:s=320x180", "-vf", vf, "-frames:v", "1", join(fullDir, file)], { stdio: "ignore" });
      framesOnDisk.push({ t, file });
    }
    const gray = grayFrames(ffmpegBin(), framesOnDisk.map((f) => join(fullDir, f.file)), { w: 32, h: 18 });
    check("frames: grayFrames decodes one buffer per PNG", gray.length === 6 && gray[0].length === 32 * 18 && gray[0][5 * 32 + 12] > 200 && gray[5][5 * 32 + 12] < 60, gray.map((g) => g[5 * 32 + 12]));
    const region = grayFrames(ffmpegBin(), framesOnDisk.map((f) => join(fullDir, f.file)), { w: 60, h: 30, crop: { x: 100, y: 50, w: 60, h: 30 } });
    check("frames: crops decode at the rect's own size", region.length === 6 && region[0].length === 60 * 30 && region[0][0] > 200 && region[4][0] < 60, null);
    const map2 = { version: 2, jobId: "anim-f", source: "sequence", canvas: { width: 320, height: 180, fps: 30 }, step: 0.5, frames: framesOnDisk, changes: [], shots: [], black: [] };
    writeFileSync(join(fkit, "src", "jobs", "anim-f", "frames-map.json"), JSON.stringify(map2));
    check("frames: no anchors.json on a job with footage = missing", verifyJobAnchors(fjob, fkit).status === "missing", verifyJobAnchors(fjob, fkit));
    writeFileSync(join(fkit, "src", "jobs", "anim-f", "anchors.json"), JSON.stringify({ anchors: [
      { id: "box-late", what: "the box", rect: { x: 100, y: 50, w: 60, h: 30 }, from: 0.5, to: 2.0 },
      { id: "box-ok", rect: { x: 100, y: 50, w: 60, h: 30 }, from: 0, to: 1.0 },
      { id: "empty-ok", rect: { x: 200, y: 100, w: 40, h: 40 }, from: 0, to: 2.5 },
    ] }));
    const chk = runAnchorCheck({ kitDir: fkit, jobId: "anim-f", ffmpeg: ffmpegBin() });
    const late = chk.results.find((r) => r.id === "box-late");
    check("frames: end-to-end: the drawing that outlives its box FAILS at 1.5s", !chk.ok && chk.fails === 1 && late && late.verdict === "fail" && late.outlives && late.outlives.from === 1.5, chk.results.map((r) => [r.id, r.verdict]));
    check("frames: end-to-end: drawings whose target holds are OK", chk.results.find((r) => r.id === "box-ok").verdict === "ok" && chk.results.find((r) => r.id === "empty-ok").verdict === "ok", null);
    check("frames: end-to-end: a sheet is written per anchor + a report json", late.sheet && existsSync(join(fkit, "public", "frames", "anim-f", "check", "box-late.png")) && existsSync(join(fkit, "src", "jobs", "anim-f", "anchor-report.json")), late.sheet);
    check("frames: verifyJobAnchors maps the check to a fail status with a report", verifyJobAnchors(fjob, fkit).status === "fail" && /box-late/.test(verifyJobAnchors(fjob, fkit).report), verifyJobAnchors(fjob, fkit));
    writeFileSync(join(fkit, "src", "jobs", "anim-f", "anchors.json"), JSON.stringify({ anchors: [{ id: "box-ok", rect: { x: 100, y: 50, w: 60, h: 30 }, from: 0, to: 1.0 }] }));
    check("frames: verifyJobAnchors is ok once the timing is fixed", verifyJobAnchors(fjob, fkit).status === "ok", verifyJobAnchors(fjob, fkit));
  } else {
    console.log("SKIP  frames: end-to-end anchor check (ffmpeg not found)");
  }
  removeFrameAssets("anim-f", fkit);
  check("frames: discard cleanup removes the extracted frames", !existsSync(join(fkit, "public", "frames", "anim-f")), null);
  rmSync(fkit, { recursive: true, force: true });
}

/* ---------- render parsing ---------- */
check("ffmpeg duration parses", approx(parseFfDuration("...\n  Duration: 00:01:23.45, start: 0\n"), 83.45, 0.001), parseFfDuration("Duration: 00:01:23.45"));
check("missing duration is null", parseFfDuration("nope") === null, null);
check("render progress parses the last fraction", parseRenderProgress("Rendered 30/300 frames ... 45/300") === 15, parseRenderProgress("45/300"));
check("done/total over 100% is rejected", parseRenderProgress("500/300") === null, null);
check("progress caps at 99 until done", parseRenderProgress("300/300") === 99, parseRenderProgress("300/300"));

if (failures) { console.error(`\n${failures} animation check(s) failed`); process.exit(1); }
console.log("\nanimation checks passed");
