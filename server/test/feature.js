// Unit checks for the retake-review logic (no Premiere / network):
// markDecisions (protected respected, summary) + applyReview (ordering, ripple)
// + the panel applyDecisions RPC path.
import { markDecisions, applyReview, summarize, computeExcessRanges } from "../review.js";
import { createRpcDispatcher } from "../rpc/index.js";
import { fmtDur, fmtElapsed } from "../tools/util.js";
import { augmentPath, commonBinDirs, ffmpegBin, ffmpegMissingMessage, mergePath } from "../paths.js";

let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

const TPS = 254016000000;
const TB = String(TPS / 30); // 30fps timebase
const tk = (sec) => String(Math.round(sec * TPS));

// One source clip on V1 covering [0,3]s at timeline 0 (source sec == timeline sec),
// so reconcile maps each segment's source range to frame = sec*30. apply() now
// reconciles LIVE frames from this, instead of trusting stored startFrame/endFrame.
function coveringTimeline() {
  return {
    sequence: { name: "S", timebase: TB, frameRate: 30, zeroPointTicks: "0", dropFrame: false, videoTrackCount: 1, audioTrackCount: 1 },
    clips: [{
      id: "V1.0", name: "rec", trackType: "video", trackIndex: 0, itemIndex: 0, mediaPath: "m.mp4",
      start: { seconds: 0, ticks: tk(0) }, end: { seconds: 3, ticks: tk(3) },
      inPoint: { seconds: 0, ticks: tk(0) }, outPoint: { seconds: 3, ticks: tk(3) },
    }],
    gaps: [],
  };
}
function srcSeg(index, startFrame, endFrame, opts = {}) {
  return {
    index, startFrame, endFrame,
    mediaPath: "m.mp4", sourceInSec: startFrame / 30, sourceOutSec: endFrame / 30,
    sourceSpeechInSec: opts.speechIn != null ? opts.speechIn : null,
    sourceSpeechOutSec: opts.speechOut != null ? opts.speechOut : null,
    wordCount: opts.wordCount != null ? opts.wordCount : 0,
    trackType: "video", trackIndex: 0,
    decision: opts.decision || "keep", protected: !!opts.protected,
    durationSec: (endFrame - startFrame) / 30, reason: null, group: null,
  };
}
function makeCtx() {
  const calls = [];
  return {
    calls,
    // getTimelineState feeds reconcile (source->live frames + undo snapshot);
    // other host calls (removeRange) are recorded in `calls`.
    bridge: { callHost: async (a, p) => { if (a === "getTimelineState") return coveringTimeline(); calls.push(p); return { ok: true }; }, notifyPanel: () => {} },
    state: { revision: 0 },
    review: {
      sequence: "S", frameRate: 30, dropFrame: false,
      segments: [srcSeg(0, 0, 10), srcSeg(1, 20, 30), srcSeg(2, 40, 55, { protected: true }), srcSeg(3, 60, 70)],
    },
  };
}

// --- markDecisions ---
const ctx = makeCtx();
const sum = markDecisions(ctx, [
  { index: 1, decision: "cut", reason: "retake of #0" },
  { index: 2, decision: "cut" }, // protected -> must stay keep
  { index: 3, decision: "cut" },
]);
check("non-protected marked cut", ctx.review.segments[1].decision === "cut");
check("protected stays keep", ctx.review.segments[2].decision === "keep", ctx.review.segments[2].decision);
check("reason recorded", ctx.review.segments[1].reason === "retake of #0");
check("summary: 2 cut", sum.cut === 2, sum);
check("summarize matches", summarize(ctx.review).keep === 2);

// --- applyReview: only non-protected cuts, batched lift + one close pass ---
const res = await applyReview(ctx, { removeGaps: true });
check("applies 2 cuts (protected skipped)", res.applied === 2, res);
check("one batch call, ranges ascending", ctx.calls[0].ranges && ctx.calls[0].ranges[0].startFrame === 20 && ctx.calls[0].ranges[1].startFrame === 60, ctx.calls);
check("removeGaps → one closeRangeGaps pass", ctx.calls.length === 2 && ctx.calls[1].ranges.length === 2, ctx.calls);
check("protected frame 40 not cut", !ctx.calls[0].ranges.some((r) => r.startFrame === 40), ctx.calls[0].ranges);

// --- computeExcessRanges: trim non-speech air inside keeps ---
{
  const map = [
    { index: 0, state: "present", liveStartSec: 0, liveEndSec: 3 },
    { index: 1, state: "present", liveStartSec: 3, liveEndSec: 5 },
    { index: 2, state: "present", liveStartSec: 5, liveEndSec: 8 },
    { index: 3, state: "absent", liveStartSec: null, liveEndSec: null },
  ];
  const segs = [
    // speech 0.5..2.0 inside [0,3]s → lead [0,0.35] + trail [2.15,3] both ≥ 0.2s
    srcSeg(0, 0, 90, { wordCount: 3, speechIn: 0.5, speechOut: 2.0 }),
    // cut segment: never excess-trimmed (it goes wholesale)
    srcSeg(1, 90, 150, { decision: "cut", wordCount: 2, speechIn: 3.2, speechOut: 4.5 }),
    // no-speech keep: user's call, not excess
    srcSeg(2, 150, 240, { wordCount: 0 }),
    // absent: can't trim what isn't there
    srcSeg(3, 240, 300, { wordCount: 2, speechIn: 8.5, speechOut: 9.0 }),
  ];
  const ex = computeExcessRanges(segs, map, 30);
  check("excess: two spans around the words", ex.length === 2, ex);
  check("excess: lead span [0,0.35]s", ex[0].startFrame === 0 && Math.abs(ex[0].endFrame - Math.round(0.35 * 30)) <= 1, ex[0]);
  check("excess: trail span ends at segment end", ex[1].endFrame === 90 && Math.abs(ex[1].startFrame - Math.round(2.15 * 30)) <= 1, ex[1]);
  check("excess: cut/empty/absent all skipped", !ex.some((r) => r.index !== 0), ex);
  // tiny air below the minimum span is left alone
  const tight = computeExcessRanges([srcSeg(0, 0, 90, { wordCount: 3, speechIn: 0.2, speechOut: 2.9 })], map, 30);
  check("excess: sub-minimum spans skipped", tight.length === 0, tight);
  // protected keeps are hands-off
  const prot = computeExcessRanges([srcSeg(0, 0, 90, { wordCount: 3, speechIn: 0.5, speechOut: 2.0, protected: true })], map, 30);
  check("excess: protected untouched", prot.length === 0, prot);
}

// --- applyReview + applyDecisions with trimExcess: cuts AND excess spans apply together ---
{
  const tctx = makeCtx();
  // Timeline covers [0,3]s. One keep with speech 0.5..2.0 (excess both sides), one cut 2.5..3.0.
  tctx.review.segments = [
    srcSeg(0, 0, 75, { wordCount: 3, speechIn: 0.5, speechOut: 2.0 }),
    srcSeg(1, 75, 90, { decision: "cut" }),
  ];
  const t = await applyReview(tctx, { removeGaps: true, trimExcess: true });
  check("trimExcess: excess spans counted", t.excessSpans === 2, t);
  // trail excess [2.15,2.5]s touches the cut [2.5,3.0]s → mergeFrameRanges folds them
  check("trimExcess: lead + merged trail-and-cut requested", t.requested === 2 && t.appliedSec === 1.2, t);
  const t2ctx = makeCtx();
  t2ctx.review.segments = [srcSeg(0, 0, 75, { wordCount: 3, speechIn: 0.5, speechOut: 2.0 })];
  const d2 = createRpcDispatcher(t2ctx);
  const tr = await d2("applyDecisions", { segments: [], removeGaps: true, trimExcess: true }, { progress: () => {} });
  check("panel trim-only apply works with zero cuts", tr.applied === 2 && /excess non-speech trim/.test(tr.message), tr);
  const t3ctx = makeCtx(); // nothing marked, nothing to trim (segments have no speech extents)
  const d3 = createRpcDispatcher(t3ctx);
  const tr3 = await d3("applyDecisions", { segments: [], removeGaps: true, trimExcess: true }, { progress: () => {} });
  check("trim-on but no work explains both", /no excess non-speech/.test(tr3.message), tr3.message);
}

// --- applyReview: cuts already gone from the timeline are counted, not silently dropped ---
{
  const gone = makeCtx();
  // Timeline covers source [0,3]s but these segments reference source [10,12]s → absent.
  gone.review.segments = [srcSeg(0, 300, 330, { decision: "cut" }), srcSeg(1, 330, 360, { decision: "cut" })];
  const g = await applyReview(gone, { removeGaps: true });
  check("absent cuts: nothing requested", g.requested === 0 && g.applied === 0, g);
  check("absent cuts: marked/gone counted", g.cutsMarked === 2 && g.alreadyGone === 2 && g.alreadyGoneSec === 2, g);
  check("absent cuts: no host calls", gone.calls.length === 0, gone.calls);
}

// --- panel applyDecisions: message says "already removed", not "nothing to cut" ---
{
  const gone = makeCtx();
  gone.review.segments = [srcSeg(0, 300, 330, { decision: "cut" })];
  const dispatchGone = createRpcDispatcher(gone);
  const r = await dispatchGone("applyDecisions", { segments: [], removeGaps: true }, { progress: () => {} });
  check("stale-list apply explains itself", /already removed/.test(r.message), r.message);
  const none = makeCtx(); // nothing marked cut at all
  const dispatchNone = createRpcDispatcher(none);
  const r2 = await dispatchNone("applyDecisions", { segments: [], removeGaps: true }, { progress: () => {} });
  check("no-marks apply says mark first", /marked Cut/.test(r2.message), r2.message);
}

// --- panel applyDecisions RPC path (sends its own segments) ---
const ctx2 = makeCtx();
const dispatch = createRpcDispatcher(ctx2);
const panelSegs = [
  { index: 0, startFrame: 0, endFrame: 10, decision: "keep", protected: false },
  { index: 1, startFrame: 20, endFrame: 30, decision: "cut", protected: false },
  { index: 2, startFrame: 40, endFrame: 55, decision: "cut", protected: false },
];
const res2 = await dispatch("applyDecisions", { segments: panelSegs, removeGaps: false }, { progress: () => {} });
check("panel applyDecisions cuts 2", res2.applied === 2, res2);
check("panel lift (no removeGaps) skips the close pass", ctx2.calls.length === 1 && ctx2.calls[0].ranges.length === 2, ctx2.calls);

// --- unknown RPC method ---
let threw = false;
try { await dispatch("bogus", {}, { progress: () => {} }); } catch (e) { threw = /Unknown RPC method/.test(e.message); }
check("unknown RPC method rejected", threw);

// --- cacheInfo / clearCache (panel Storage section) ---
{
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "editagent-cache-"));
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  mkdirSync(join(dir, "levels", "nested"), { recursive: true });
  writeFileSync(join(dir, "transcripts", "a.json"), "x".repeat(100));
  writeFileSync(join(dir, "levels", "nested", "b.json"), "y".repeat(50));
  writeFileSync(join(dir, "keep-me.json"), "precious"); // NOT in a cache subdir -> untouched
  const cctx = { ...makeCtx(), cacheDir: dir };
  const cdispatch = createRpcDispatcher(cctx);
  const info = await cdispatch("cacheInfo", {}, { progress: () => {} });
  check("cacheInfo sums nested files", info.totalBytes === 150 && info.totalFiles === 2, info);
  const cleared = await cdispatch("clearCache", {}, { progress: () => {} });
  check("clearCache reports freed bytes", cleared.freedBytes === 150 && cleared.freedFiles === 2, cleared);
  const after = await cdispatch("cacheInfo", {}, { progress: () => {} });
  check("cache empty after clear (dirs recreated)", after.totalBytes === 0 && existsSync(join(dir, "transcripts")), after);
  check("files outside cache subdirs survive", existsSync(join(dir, "keep-me.json")), readdirSync(dir));
  // busy guard: an in-flight panel op blocks the destructive clear
  cctx.panelOp = { aborted: false };
  let busyThrew = false;
  try { await cdispatch("clearCache", {}, { progress: () => {} }); } catch (e) { busyThrew = /Busy/.test(e.message); }
  check("clearCache refuses while an op is running", busyThrew);
}

// --- API key + advanced env settings (panel Config popover) ---
{
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { setEnvKey } = await import("../config.js");
  const dir = mkdtempSync(join(tmpdir(), "editagent-env-"));
  const envPath = join(dir, ".env");

  // setEnvKey: creates the file, replaces in place, preserves other lines
  writeFileSync(envPath, "# keep this comment\nOTHER=1\nELEVENLABS_API_KEY=old\n");
  setEnvKey("ELEVENLABS_API_KEY", "sk_new1234", envPath);
  let env = readFileSync(envPath, "utf8");
  check("setEnvKey replaces in place", /ELEVENLABS_API_KEY=sk_new1234/.test(env) && !/=old/.test(env), env);
  check("setEnvKey preserves comments and other keys", /# keep this comment/.test(env) && /OTHER=1/.test(env), env);
  setEnvKey("NEW_KEY", "v", envPath);
  env = readFileSync(envPath, "utf8");
  check("setEnvKey appends a missing key", /NEW_KEY=v\n$/.test(env), env);

  const ectx = { ...makeCtx(), envPath };
  const edispatch = createRpcDispatcher(ectx);

  // keyStatus: shape only (reads the real project .env)
  const ks = await edispatch("keyStatus", {}, { progress: () => {} });
  check("keyStatus returns set + last4", typeof ks.set === "boolean" && ("last4" in ks), ks);

  // setApiKey: validation, verified save (stubbed fetch), rejected key
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    let emptyThrew = false;
    try { await edispatch("setApiKey", { key: "  " }, { progress: () => {} }); } catch (e) { emptyThrew = /Paste/.test(e.message); }
    check("setApiKey rejects an empty key", emptyThrew);
    const saved = await edispatch("setApiKey", { key: "sk_abcd9999" }, { progress: () => {} });
    check("setApiKey verifies and saves", saved.ok && saved.verified && saved.last4 === "9999", saved);
    check("setApiKey wrote the .env", /ELEVENLABS_API_KEY=sk_abcd9999/.test(readFileSync(envPath, "utf8")));
    // A speech_to_text-scoped key returns 400 (missing file), NOT 401 — must verify.
    globalThis.fetch = async () => ({ ok: false, status: 400 });
    const scoped = await edispatch("setApiKey", { key: "sk_scoped42" }, { progress: () => {} });
    check("setApiKey verifies a speech_to_text-scoped key (400 = auth ok)", scoped.ok && scoped.verified, scoped);
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    let badThrew = false;
    try { await edispatch("setApiKey", { key: "sk_bad" }, { progress: () => {} }); } catch (e) { badThrew = /rejected that key/.test(e.message); }
    check("setApiKey surfaces a rejected key", badThrew);
    globalThis.fetch = async () => { throw new Error("offline"); };
    const offline = await edispatch("setApiKey", { key: "sk_offline1" }, { progress: () => {} });
    check("setApiKey saves unverified when offline", offline.ok && !offline.verified && /Could not reach/.test(offline.message), offline);
  } finally {
    globalThis.fetch = realFetch;
  }

  // envList / setEnv: curated specs only, .env write + process.env sync
  const list = await edispatch("envList", {}, { progress: () => {} });
  check("envList returns described vars", list.vars.length > 10 && list.vars.every((v) => v.key && v.desc), list.vars.length);
  check("envList never exposes the API key", !list.vars.some((v) => v.key === "ELEVENLABS_API_KEY"));
  const prevChunk = process.env.EDITAGENT_AI_CHUNK;
  try {
    const se = await edispatch("setEnv", { key: "EDITAGENT_AI_CHUNK", value: "48" }, { progress: () => {} });
    check("setEnv saves a known var", se.ok && /Saved/.test(se.message), se);
    check("setEnv wrote the .env", /EDITAGENT_AI_CHUNK=48/.test(readFileSync(envPath, "utf8")));
    check("setEnv syncs process.env", process.env.EDITAGENT_AI_CHUNK === "48");
    const clr = await edispatch("setEnv", { key: "EDITAGENT_AI_CHUNK", value: "" }, { progress: () => {} });
    check("setEnv empty = reset message", /Reset/.test(clr.message), clr);
    check("setEnv empty clears process.env", process.env.EDITAGENT_AI_CHUNK === undefined);
    let unknownThrew = false;
    try { await edispatch("setEnv", { key: "PATH", value: "x" }, { progress: () => {} }); } catch (e) { unknownThrew = /isn't a setting/.test(e.message); }
    check("setEnv refuses unknown keys", unknownThrew);
  } finally {
    if (prevChunk === undefined) delete process.env.EDITAGENT_AI_CHUNK;
    else process.env.EDITAGENT_AI_CHUNK = prevChunk;
  }
}

/* ---- duration formatting: raw seconds stop being readable past a minute ---- */
check("fmtDur: sub-second keeps 2 decimals, single digits keep 1",
  fmtDur(0.42) === "0.42s" && fmtDur(8.44) === "8.4s", [fmtDur(0.42), fmtDur(8.44)]);
check("fmtDur: whole seconds under a minute",
  fmtDur(45.6) === "46s" && fmtDur(59.4) === "59s", [fmtDur(45.6), fmtDur(59.4)]);
check("fmtDur: rounds BEFORE the 60s boundary (59.6s is 1:00, never '60s')",
  fmtDur(59.6) === "1:00" && fmtDur(60) === "1:00", [fmtDur(59.6), fmtDur(60)]);
check("fmtDur: mm:ss past a minute, h:mm:ss past an hour",
  fmtDur(85.166) === "1:25" && fmtDur(300) === "5:00" && fmtDur(4923) === "1:22:03",
  [fmtDur(85.166), fmtDur(300), fmtDur(4923)]);
check("fmtDur: garbage and negatives never print NaN",
  fmtDur(undefined) === "0s" && fmtDur("x") === "0s" && fmtDur(-90) === "1:30",
  [fmtDur(undefined), fmtDur("x"), fmtDur(-90)]);
check("fmtElapsed: wall clock stays in words, drops a bare zero",
  fmtElapsed(45) === "45s" && fmtElapsed(192) === "3m 12s" && fmtElapsed(300) === "5m" && fmtElapsed(3900) === "1h 05m",
  [fmtElapsed(45), fmtElapsed(192), fmtElapsed(300), fmtElapsed(3900)]);

/* ---- binary lookup: the panel starts us with the bare GUI PATH ---- */
{
  const dirs = commonBinDirs({ platform: "darwin", home: "/Users/x", execPath: "/opt/homebrew/bin/node" });
  check("commonBinDirs: node's own dir first (npm/npx live beside it)", dirs[0] === "/opt/homebrew/bin", dirs[0]);
  check("commonBinDirs: covers homebrew, /usr/local and ~/.local/bin",
    dirs.includes("/usr/local/bin") && dirs.includes("/Users/x/.local/bin"), dirs);
  // (path.dirname is host-flavoured, so only assert what's platform-independent.)
  const win = commonBinDirs({ platform: "win32", home: "C:/Users/x", execPath: "C:/node/node.exe" });
  check("commonBinDirs: Windows looks beside node, never in /opt",
    win[0] === "C:/node" && !win.some((d) => d.startsWith("/opt")), win);
  check("mergePath: appends, keeps existing entries' priority",
    mergePath("/usr/bin:/bin", ["/opt/homebrew/bin"]) === "/usr/bin:/bin:/opt/homebrew/bin",
    mergePath("/usr/bin:/bin", ["/opt/homebrew/bin"]));
  check("mergePath: never duplicates a dir already on PATH",
    mergePath("/usr/bin:/opt/homebrew/bin", ["/opt/homebrew/bin", "/usr/local/bin"]) ===
      "/usr/bin:/opt/homebrew/bin:/usr/local/bin");
  check("mergePath: survives an empty/missing PATH",
    mergePath("", ["/opt/homebrew/bin"]) === "/opt/homebrew/bin" && mergePath(undefined, []) === "");
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  augmentPath(env);
  check("augmentPath: widens the bare GUI PATH", env.PATH.split(":").length > 4, env.PATH);
  const prevBin = process.env.FFMPEG_BIN;
  process.env.FFMPEG_BIN = "/custom/ffmpeg";
  check("ffmpegBin: FFMPEG_BIN override wins", ffmpegBin() === "/custom/ffmpeg", ffmpegBin());
  if (prevBin === undefined) delete process.env.FFMPEG_BIN;
  else process.env.FFMPEG_BIN = prevBin;
  check("ffmpegBin: falls back to a resolvable name", /ffmpeg(\.exe)?$/.test(ffmpegBin()), ffmpegBin());
  check("ffmpegMissingMessage: names the binary and both fixes",
    /"\/x\/ffmpeg"/.test(ffmpegMissingMessage("/x/ffmpeg", "ENOENT")) &&
      /brew install ffmpeg/.test(ffmpegMissingMessage("/x/ffmpeg")) &&
      /FFMPEG_BIN/.test(ffmpegMissingMessage("/x/ffmpeg")));
}

console.log(failures === 0 ? "\nAll feature checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
