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
  normalizeSizeOverride, fmtTokens, fmtElapsed, normalizeRawDuration, buildRawBrief, createRawJob,
  sequenceFrameSize, setRawLength,
} from "../animation/jobs.js";
import { listStyles, readStyleSkill, readFramesSkill, kitDir as animWorkspaceDir } from "../animation/kit.js";
import {
  parseVideoSize, parseBlackdetect, fitTransform, canvasMapFilter, frameName,
  mergeFrameSpans, prepareFrameAssets, removeFrameAssets,
} from "../animation/frames.js";
import { planExtractions, buildFilter } from "../../animation-kit/scripts/grab-frames.mjs";
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
  // ffmpeg -i stderr parsing: the codec tag (0x31637634) must never match.
  const ffInfo = "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637634), yuv420p(tv, bt709), 2560x1440 [SAR 1:1 DAR 16:9], 4570 kb/s, 30 fps\n  Stream #0:1[0x2](und): Audio: aac, 48000 Hz, stereo";
  const size = parseVideoSize(ffInfo);
  check("frames: video size parses past the codec tag", size && size.width === 2560 && size.height === 1440, size);
  check("frames: audio-only stderr yields no size", parseVideoSize("  Stream #0:0: Audio: aac, 48000 Hz") === null, null);

  const black = parseBlackdetect("[blackdetect @ 0x1] black_start:0 black_end:2.5 black_duration:2.5\n[blackdetect @ 0x1] black_start:10.2 black_end:11 black_duration:0.8", 5);
  check("frames: blackdetect parses and shifts by the span's rel start", black.length === 2 && approx(black[0].start, 5) && approx(black[0].end, 7.5) && approx(black[1].start, 15.2), black);

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

  // grab-frames planning: rel times map onto source times through the spans.
  const gmap = { canvas: { width: 1920, height: 1080 }, frameWidth: 1568, spans: [
    { relStart: 0, relEnd: 2, mediaPath: "/a.mp4", sourceInSec: 10 },
    { relStart: 3, relEnd: 5, mediaPath: "/a.mp4", sourceInSec: 40 },
  ] };
  // t = 0..5: 0,1 in span1; 2 clamps to span1's end; 3,4 in span2; 5 clamps to span2's end.
  const plan = planExtractions(gmap, 0, 5, 1);
  check("frames: plan walks the window and maps rel -> source", plan.length === 6 && approx(plan[0].sourceSec, 10) && approx(plan[4].sourceSec, 41) && plan[4].relSec === 4, plan);
  check("frames: a time in a gap (cut footage) is skipped", planExtractions(gmap, 2.2, 2.8, 1).length === 0, planExtractions(gmap, 2.2, 2.8, 1));
  const edge = planExtractions(gmap, 2, 2, 1);
  check("frames: a span-end boundary clamps inside so a frame still decodes", edge.length === 1 && edge[0].sourceSec < 12, edge);

  const full = buildFilter(gmap, {});
  check("frames: full frames downscale and print a coordinate factor", /scale=1568:-2$/.test(full.vf) && approx(full.factor, 1.224, 0.001) && full.prefix === "", full);
  const crop = buildFilter(gmap, { crop: { x: 50, y: 60, w: 200, h: 100 } });
  check("frames: crops are 1:1 canvas pixels", /crop=200:100:50:60$/.test(crop.vf) && crop.factor === 1 && crop.prefix === "crop-x50y60-", crop);

  // Prompt + brief wiring.
  const fjob = { id: "anim-f", fps: 30, width: 1920, height: 1080, durationInFrames: 300, background: "transparent", style: "excalidraw", seeFrames: true };
  const fsys = buildSystemAppend(fjob, "S", "FRAMES GUIDE BODY");
  check("frames: system prompt carries the frames guide", /FRAME-AWARE/.test(fsys) && fsys.includes("<frames-skill>") && fsys.includes("FRAMES GUIDE BODY"), null);
  const plainSys = buildSystemAppend({ ...fjob, seeFrames: false }, "S", "FRAMES GUIDE BODY");
  check("frames: a normal job gets no frames guide", !plainSys.includes("<frames-skill>") && !/FRAME-AWARE/.test(plainSys), null);
  const fbrief = buildBrief(fjob, { selected: [{ index: 0, relStart: 0, relEnd: 10, text: "hi" }], transcriptLines: [] });
  check("frames: brief points at frames-map.json", fbrief.includes("frames-map.json") && fbrief.includes("Screen frames"), null);
  const plainBrief = buildBrief({ ...fjob, seeFrames: false }, { selected: [], transcriptLines: [] });
  check("frames: a normal brief has no frames section", !plainBrief.includes("frames-map.json"), null);
  check("frames: the shipped frames guide is readable", /grab-frames/.test(readFramesSkill()) && /DebugFrame/.test(readFramesSkill()), null);

  // prepareFrameAssets is best-effort: missing media still writes the map.
  const fkit = mkdtempSync(join(tmpdir(), "oca-frames-"));
  mkdirSync(join(fkit, "src", "jobs", "anim-f"), { recursive: true });
  const prep = await prepareFrameAssets({ job: fjob, spans: [{ relStart: 0, relEnd: 5, mediaPath: join(fkit, "missing.mp4"), sourceInSec: 0 }], kitDirPath: fkit });
  check("frames: missing media degrades to a warning, not a throw", prep.hasVideo === false && prep.warnings.length >= 1, prep);
  const mapOnDisk = JSON.parse(readFileSync(join(fkit, "src", "jobs", "anim-f", "frames-map.json"), "utf8"));
  check("frames: frames-map.json is written even with no usable media", mapOnDisk.jobId === "anim-f" && Array.isArray(mapOnDisk.spans) && mapOnDisk.spans.length === 0 && mapOnDisk.canvas.width === 1920, mapOnDisk);
  check("frames: overview dir exists for the agent to check", existsSync(join(fkit, "public", "frames", "anim-f", "overview")), null);
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
