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
  jobsRootFor, animTrackIndex,
} from "../animation/jobs.js";
import { listStyles, readStyleSkill } from "../animation/kit.js";
import { toolDetail, buildSystemAppend } from "../animation/chat.js";
import { parseFfDuration, parseRenderProgress } from "../animation/render.js";

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

/* ---------- renderFps ---------- */
check("30.00003 rounds to 30", renderFps(30.00003) === 30, renderFps(30.00003));
check("29.97 stays fractional", approx(renderFps(29.97), 29.97, 0.001), renderFps(29.97));
check("bad fps falls back to 30", renderFps(NaN) === 30, renderFps(NaN));

/* ---------- job id + track ---------- */
check("job ids are composition-safe", /^anim-[a-z0-9]+$/.test(newJobId()), newJobId());
check("default animation track is V2 (index 1)", animTrackIndex() === 1, animTrackIndex());

/* ---------- kit: styles registry + skill ---------- */
const styles = listStyles();
check("excalidraw style is registered", styles.some((s) => s.id === "excalidraw" && s.default), styles);
check("style skill is readable", /Learnings log/i.test(readStyleSkill("excalidraw")), null);
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
  check("render.json signal parses", sig && sig.version === 2 && sig.notes === "first pass", sig);
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

/* ---------- render parsing ---------- */
check("ffmpeg duration parses", approx(parseFfDuration("...\n  Duration: 00:01:23.45, start: 0\n"), 83.45, 0.001), parseFfDuration("Duration: 00:01:23.45"));
check("missing duration is null", parseFfDuration("nope") === null, null);
check("render progress parses the last fraction", parseRenderProgress("Rendered 30/300 frames ... 45/300") === 15, parseRenderProgress("45/300"));
check("done/total over 100% is rejected", parseRenderProgress("500/300") === null, null);
check("progress caps at 99 until done", parseRenderProgress("300/300") === 99, parseRenderProgress("300/300"));

if (failures) { console.error(`\n${failures} animation check(s) failed`); process.exit(1); }
console.log("\nanimation checks passed");
