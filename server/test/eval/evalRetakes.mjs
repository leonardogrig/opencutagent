// Retake-judgment eval: runs the REAL headless oracle (server/ai.js askClaude with
// retakeSystem()/retakePrompt() — the exact thing the panel's "Analyze w/ Claude"
// button uses) against a human-labeled fixture, and scores keep/cut accuracy.
//
// Why this exists: the panel kept obvious retakes (progressive re-starts of the
// same line). This harness measures that quantitatively so the skill/prompt can be
// improved against a fixed target instead of by vibes.
//
// Usage:
//   node server/test/eval/evalRetakes.mjs                       # full set, sonnet/high
//   node server/test/eval/evalRetakes.mjs --range 0-39          # cheap subset (clearest beats)
//   node server/test/eval/evalRetakes.mjs --model latest --effort high
//   node server/test/eval/evalRetakes.mjs --from out/last.json  # re-score a saved run, no API call
//
// Scores ONLY the speech segments the AI actually judges: empty/ambient lines
// ("(throat clearing)") are auto-cut deterministically by the server and excluded
// from the prompt, so they're reported separately and not counted against the AI.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { askClaude, RETAKE_SCHEMA, retakeSystem, retakePrompt, analyzeRetakes, planRetakeChunks } from "../../ai.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const model = flag("model", "sonnet");
const effort = flag("effort", "high");
const range = flag("range", null);
const fromFile = flag("from", null);
const fixture = flag("fixture", "retakes-n8n");
const single = argv.includes("--single"); // force the old one-call path (for comparison)
const C = { red: (s) => `\x1b[31m${s}\x1b[0m`, grn: (s) => `\x1b[32m${s}\x1b[0m`, yel: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

// ---- load fixture + golden ----
const segLines = readFileSync(join(HERE, "fixtures", `${fixture}.segments.txt`), "utf8").split("\n");
const golden = JSON.parse(readFileSync(join(HERE, "fixtures", `${fixture}.golden.json`), "utf8"));
const segs = [];
for (const line of segLines) {
  const m = line.match(/^\[(\d+)\]\s+(\S+)\s+([\s\S]*)$/);
  if (m) segs.push({ index: +m[1], time: m[2], text: m[3].trim() });
}
const byIndex = new Map(segs.map((s) => [s.index, s]));

// golden cut set from beats: every index in a beat range that is not a keeper.
const goldenCut = new Set();
const beatOf = new Map(); // index -> {range, keepers}
for (const [[s, e], keepers] of golden.beats) {
  const keep = new Set(keepers);
  for (let i = s; i <= e; i++) { if (!keep.has(i)) goldenCut.add(i); beatOf.set(i, { range: [s, e], keepers }); }
}

// empty/ambient = parenthetical-only, no real words (mirrors server wordCount===0 auto-cut).
const isEmpty = (text) => text.replace(/\([^)]*\)/g, " ").replace(/[^A-Za-z0-9]+/g, " ").trim().length === 0;

let pool = segs;
if (range) { const [a, b] = range.split("-").map(Number); pool = segs.filter((s) => s.index >= a && s.index <= b); }
const speechSegs = pool.filter((s) => !isEmpty(s.text));
const emptySegs = pool.filter((s) => isEmpty(s.text));
const speechIdx = new Set(speechSegs.map((s) => s.index));

// ---- get AI decisions (real call, or load a saved run) ----
let decisions, meta;
if (fromFile) {
  const f = JSON.parse(readFileSync(fromFile.startsWith("/") ? fromFile : join(HERE, fromFile), "utf8"));
  decisions = Array.isArray(f) ? f : (f.decisions || []);
  meta = { source: "file", file: fromFile };
  console.log(C.dim(`Scoring saved run: ${fromFile}`));
} else {
  // analyzeRetakes formats time from startSec; derive it from the fixture's m:ss.
  const withSec = speechSegs.map((s) => { const [m, sec] = s.time.split(":").map(Number); return { ...s, startSec: m * 60 + sec }; });
  const mdl = model === "latest" ? undefined : model;
  const nChunks = single ? 1 : planRetakeChunks(withSec.length).length;
  console.log(C.dim(`Calling claude  model=${model} effort=${effort}  speech-segs=${withSec.length}  ${single ? "single-call" : `chunks=${nChunks}`}${range ? `  range=${range}` : ""}…`));
  const t0 = Date.now();
  if (single) {
    const lines = withSec.map((s) => `[${s.index}] ${s.time} ${s.text}`).join("\n");
    const { data } = await askClaude({ prompt: retakePrompt(lines, withSec.length), system: retakeSystem(), schema: RETAKE_SCHEMA, model: mdl, effort });
    decisions = data.decisions || [];
  } else {
    decisions = await analyzeRetakes(withSec, { model: mdl, effort, onProgress: (m) => console.log(C.dim("  " + m)) });
  }
  meta = { source: "claude", model, effort, single, chunks: nChunks, secs: Math.round((Date.now() - t0) / 1000) };
  console.log(C.dim(`  …answered in ${meta.secs}s, ${decisions.length} cut decisions returned`));
  mkdirSync(join(HERE, "out"), { recursive: true });
  const tag = `${fixture}-${model}-${effort}${single ? "-single" : ""}${range ? `-${range}` : ""}`;
  writeFileSync(join(HERE, "out", `${tag}.json`), JSON.stringify({ meta, decisions }, null, 2));
  writeFileSync(join(HERE, "out", "last.json"), JSON.stringify({ meta, decisions }, null, 2));
}

const aiCut = new Set(decisions.filter((d) => d.decision === "cut" && speechIdx.has(d.index)).map((d) => d.index));

// ---- score over SPEECH segments only ----
const goldenCutSpeech = new Set([...goldenCut].filter((i) => speechIdx.has(i)));
let TP = 0, FP = 0, FN = 0, TN = 0;
const missed = [], overcut = [];
for (const s of speechSegs) {
  const g = goldenCutSpeech.has(s.index), a = aiCut.has(s.index);
  if (g && a) TP++;
  else if (!g && a) { FP++; overcut.push(s); }
  else if (g && !a) { FN++; missed.push(s); }
  else TN++;
}
const precision = TP + FP ? TP / (TP + FP) : 1;
const recall = TP + FN ? TP / (TP + FN) : 1;
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ---- report ----
const ctxLine = (s) => `  ${C.dim(`[${s.index}] ${s.time}`)} ${s.text.length > 90 ? s.text.slice(0, 90) + "…" : s.text}`;
console.log("\n" + C.b("══ Retake eval ══") + `  fixture=${fixture}  pool=${pool.length} (${speechSegs.length} speech, ${emptySegs.length} empty)`);
console.log(`golden cuts (speech): ${goldenCutSpeech.size}   AI cuts (speech): ${aiCut.size}`);
console.log(`${C.b("recall")}   ${pct(recall)}  ${C.dim(`(caught ${TP}/${goldenCutSpeech.size} real retakes — higher = fewer kept duplicates)`)}`);
console.log(`${C.b("precision")} ${pct(precision)}  ${C.dim(`(${FP} over-cuts of ${aiCut.size} — higher = safer)`)}`);
console.log(`${C.b("F1")}       ${pct(f1)}`);

console.log("\n" + C.red(C.b(`✗ MISSED RETAKES (${missed.length})`)) + C.dim(" — golden=CUT but AI kept (the user's complaint):"));
for (const s of missed) console.log(ctxLine(s));
console.log("\n" + C.yel(C.b(`⚠ OVER-CUTS (${overcut.length})`)) + C.dim(" — golden=KEEP but AI cut (lost good content):"));
for (const s of overcut) console.log(ctxLine(s));

// ---- beat-level score: what the USER actually feels ----
// Per beat, compare how many segments each side KEEPS (ignoring which specific take):
//   leftover dupes = AI kept more than golden  → duplicates still on the timeline
//   lost content   = AI kept fewer than golden → good content cut
// This forgives "kept the other identical take" (still removes the duplicate).
const beatStats = new Map(); // beatKey -> {gKeep, aKeep, total}
for (const s of speechSegs) {
  const b = beatOf.get(s.index);
  if (!b) continue;
  const key = b.range.join("-");
  const st = beatStats.get(key) || { gKeep: 0, aKeep: 0, total: 0, range: b.range };
  st.total++;
  if (!goldenCut.has(s.index)) st.gKeep++;
  if (!aiCut.has(s.index)) st.aKeep++;
  beatStats.set(key, st);
}
let leftover = 0, lost = 0, dirtyBeats = 0, overcutBeats = 0;
for (const st of beatStats.values()) {
  const extra = st.aKeep - st.gKeep;
  if (extra > 0) { leftover += extra; dirtyBeats++; }
  else if (extra < 0) { lost += -extra; overcutBeats++; }
}
const beatsTouched = beatStats.size;
console.log("\n" + C.b("── beat-level (the user-facing score) ──"));
console.log(`${C.b("leftover duplicates")}: ${leftover}  ${C.dim(`across ${dirtyBeats}/${beatsTouched} beats — segments the AI KEPT that golden cut (real dupes still on timeline)`)}`);
console.log(`${C.b("lost good content")}:    ${lost}  ${C.dim(`across ${overcutBeats}/${beatsTouched} beats — segments the AI cut that golden kept`)}`);
console.log(C.dim(`(per-segment FN/FP above count picking the OTHER take of an identical pair as errors; beat-level does not)`));

// empties sanity: how many of the auto-cut empties does golden agree are cuts?
const emptyGoldCut = emptySegs.filter((s) => goldenCut.has(s.index)).length;
if (emptySegs.length) console.log("\n" + C.dim(`empties auto-cut: ${emptySegs.length} (golden agrees on ${emptyGoldCut})`));

// per-beat audit (only when small enough to read)
if (speechSegs.length <= 60) {
  console.log("\n" + C.b("── per-segment audit ──") + C.dim("  G=golden A=ai  ✓agree ✗disagree"));
  for (const s of pool) {
    const empty = isEmpty(s.text);
    const g = empty ? "cut*" : (goldenCut.has(s.index) ? "cut" : "keep");
    const a = empty ? "cut*" : (aiCut.has(s.index) ? "cut" : "keep");
    const ok = g.replace("*", "") === a.replace("*", "");
    const mark = empty ? C.dim("·") : (ok ? C.grn("✓") : C.red("✗"));
    console.log(`${mark} ${C.dim(`[${String(s.index).padStart(3)}]`)} G:${g.padEnd(5)} A:${a.padEnd(5)} ${s.text.length > 70 ? s.text.slice(0, 70) + "…" : s.text}`);
  }
}

console.log("");
process.exit(0);
