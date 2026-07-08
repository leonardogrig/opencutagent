// Headless Claude "judgment" calls — run the user's installed `claude` CLI in
// print mode (-p) to make a single decision (pick a silence threshold / mark
// retakes), then return the structured answer. This is what powers the panel's
// own AI buttons WITHOUT the user typing in a chat.
//
// Why a subprocess and not the Agent SDK: only the CLI uses the user's Claude
// *subscription* (keychain OAuth). The SDK requires a pay-per-token API key.
//
// Why it never collides with this MCP server: the call runs with
//   --strict-mcp-config (load NO mcp servers) + --tools "" (no built-in tools)
// from a neutral cwd, so it can't spawn a second `premiere` bridge on port 3001
// and can't touch the filesystem. It's a pure text-in / JSON-out oracle; the
// server already holds the data (ctx.silence / ctx.review) and applies the result.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { liveEnv } from "./config.js";
import { log } from "./log.js";
import { mmss } from "./tools/util.js";
import { recordUsage } from "./usage.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // server/ -> root

function aiTimeoutMs() {
  const v = parseInt(liveEnv("EDITAGENT_AI_TIMEOUT_MS") || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 600000; // 10 min default; raise via EDITAGENT_AI_TIMEOUT_MS for big retake runs
}

const IS_WINDOWS = process.platform === "win32";

/**
 * Resolve how to launch the `claude` CLI as [file, ...prefixArgs]:
 * explicit override -> common install paths -> PATH.
 * On Windows, npm installs a .cmd shim that spawn() refuses to exec (EINVAL),
 * and shell:true would mangle the JSON-schema argument — so a .cmd resolves to
 * its JS entry run with this same node binary instead.
 */
function resolveClaudeLaunch() {
  const asLaunch = (bin) => {
    if (IS_WINDOWS && /\.(cmd|bat)$/i.test(bin)) {
      const cli = join(dirname(bin), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      if (existsSync(cli)) return [process.execPath, cli];
    }
    return [bin];
  };
  const override = liveEnv("EDITAGENT_CLAUDE_BIN");
  if (override && existsSync(override)) return asLaunch(override);
  const candidates = IS_WINDOWS
    ? [
        join(homedir(), ".local", "bin", "claude.exe"), // native installer
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.cmd") : null, // npm -g shim
      ].filter(Boolean)
    : [
        join(homedir(), ".local", "bin", "claude"), // native installer (default)
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
        join(homedir(), ".npm-global", "bin", "claude"),
      ];
  for (const c of candidates) if (existsSync(c)) return asLaunch(c);
  return ["claude"]; // last resort: rely on PATH (spawn uses libuv execvp / CreateProcess)
}

/** Turn low-level spawn/auth failures into a message the panel can show verbatim. */
function friendlyError(message, code) {
  const m = String(message || "");
  if (code === "ENOENT" || code === "EINVAL" || /ENOENT|EINVAL|not found/i.test(m)) {
    return "Couldn't find (or launch) the `claude` CLI. Install Claude Code, or set EDITAGENT_CLAUDE_BIN in .env to its full path (on Windows point it at claude.exe, not a .cmd shim).";
  }
  if (/not logged in|please run .*login|\/login|setup-token|unauthenticated|no credentials|authentication/i.test(m)) {
    return "Claude isn't signed in for headless use. Open a terminal and run `claude` once to log in (or `claude setup-token`), then retry.";
  }
  if (/rate limit|usage limit|quota|overloaded|exceeded/i.test(m)) {
    return "Claude is rate-limited or over its usage limit right now. Try again shortly, or pick a smaller model/effort.";
  }
  if (/ANTHROPIC_API_KEY|credit balance|billing/i.test(m)) {
    return "Claude tried to use an API key instead of your subscription. Remove ANTHROPIC_API_KEY from the environment and retry.";
  }
  return m || "Claude call failed.";
}

/**
 * Run one headless judgment call.
 * @param {object} o
 * @param {string} o.prompt        the user message (sent on stdin — no arg-size limit)
 * @param {string} [o.system]      full system prompt (REPLACES the default — keeps it focused/cheap)
 * @param {object} [o.schema]      JSON Schema; forces a validated structured result
 * @param {string} [o.model]       "latest" (omit flag) | alias (opus/sonnet/haiku/fable) | full id
 * @param {string} [o.effort]      low|medium|high|xhigh|max
 * @param {object} [o.token]       cancel token (ctx.panelOp); we set token.child so "cancel" can kill us
 * @returns {Promise<{data:any, raw:object}>}  data = structured_output (or parsed result)
 */
export function askClaude({ prompt, system, schema, model, effort, token } = {}) {
  return new Promise((resolve, reject) => {
    const [bin, ...prefixArgs] = resolveClaudeLaunch();
    const args = [...prefixArgs, "-p", "--output-format", "json", "--strict-mcp-config", "--tools", "", "--no-session-persistence"];
    if (schema) args.push("--json-schema", JSON.stringify(schema));
    if (system) args.push("--system-prompt", system);
    if (model && model !== "latest") args.push("--model", model);
    if (effort) args.push("--effort", effort);

    // Force subscription auth: never let a stray API key silently bill the user.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    let child;
    try {
      child = spawn(bin, args, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(friendlyError(e.message, e.code)));
      return;
    }
    // Register so the panel's "cancel" can kill us. `child` is the single-call
    // convenience; `children` (a Set) lets one token track many parallel chunk
    // calls (analyzeRetakes) so cancel kills them all, not just the last.
    if (token) { token.child = child; if (token.children) token.children.add(child); }

    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, aiTimeoutMs());

    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.stdin.on("error", () => { /* swallow EPIPE if the process never started */ });

    child.on("error", (e) => {
      clearTimeout(timer);
      if (token) { if (token.child === child) token.child = null; if (token.children) token.children.delete(child); }
      reject(new Error(friendlyError(e.message, e.code)));
    });

    child.on("close", (codeNum) => {
      clearTimeout(timer);
      if (token) { if (token.child === child) token.child = null; if (token.children) token.children.delete(child); }

      if (token && token.aborted) { reject(new Error("Cancelled")); return; }
      if (timedOut) { reject(new Error(`Claude didn't answer within ${Math.round(aiTimeoutMs() / 1000)}s. Try a faster model/effort or a shorter selection.`)); return; }

      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* not JSON (likely an error on stderr) */ }

      if (!parsed) {
        log("askClaude: no JSON on stdout. stderr:", err.slice(0, 500));
        reject(new Error(friendlyError(err.trim() || `claude exited with code ${codeNum} and produced no output.`)));
        return;
      }
      if (parsed.is_error || parsed.subtype === "error_during_execution" || parsed.subtype === "error_max_turns") {
        reject(new Error(friendlyError(parsed.result || err.trim() || "Claude returned an error.")));
        return;
      }

      const data = parsed.structured_output != null ? parsed.structured_output : extractJson(parsed.result);
      if (data == null) {
        log("askClaude: no structured output. result:", String(parsed.result).slice(0, 300));
        reject(new Error("Claude didn't return a usable answer. Try again, or a stronger model."));
        return;
      }
      resolve({ data, raw: parsed });
    });

    try {
      child.stdin.write(prompt || "");
      child.stdin.end();
    } catch (e) {
      // If the child already died, 'close'/'error' handlers will settle the promise.
      log("askClaude: stdin write failed:", e.message);
    }
  });
}

/** Best-effort JSON recovery if structured_output is somehow absent. */
function extractJson(text) {
  if (text == null) return null;
  const s = String(text).trim();
  try { return JSON.parse(s); } catch { /* try to find a JSON span */ }
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/* ============================== prompts ============================== */
// We inject OpenCutAgent's OWN skill files so the panel's AI uses the exact same
// expertise as the chat workflow (single source of truth — edit the skill, the
// panel gets smarter). The skills are written to drive the interactive MCP loop,
// so the wrapper below tells the model to ignore the tool-calling parts and just
// return the decision.

function readSkill(name) {
  try {
    const p = join(PROJECT_ROOT, ".claude", "skills", name, "SKILL.md");
    if (existsSync(p)) return readFileSync(p, "utf8");
  } catch { /* ignore */ }
  return "";
}

/**
 * Extract one `##` section of a skill by a substring of its header (case-insensitive),
 * up to the next `##`. Lets the headless oracle inject ONLY the part it needs (e.g.
 * the retake judgment) instead of the whole editing skill — keeps the single source
 * of truth in SKILL.md while cutting irrelevant tokens/dilution. Falls back to the
 * full skill if the header isn't found.
 */
function skillSection(name, headerMatch) {
  const md = readSkill(name);
  if (!md) return "";
  const lines = md.split("\n");
  const m = headerMatch.toLowerCase();
  const start = lines.findIndex((l) => l.startsWith("## ") && l.toLowerCase().includes(m));
  if (start < 0) return md;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith("## ")) { end = i; break; }
  return lines.slice(start, end).join("\n").trim();
}

function wrapSystem({ role, judgment, skill }) {
  return [
    `You are the analysis engine inside OpenCutAgent, a video-editing panel for Adobe Premiere Pro. ${role}`,
    "You are running NON-INTERACTIVELY with NO tools and NO MCP access. Do not try to call tools, read files, run commands, or ask questions — none are available. Read the data in the user's message and return ONLY the structured JSON answer the schema requires.",
    judgment,
    skill
      ? "The text below is OpenCutAgent's own skill guidance for this task. It normally drives an interactive tool-calling workflow — IGNORE every instruction about calling ppro_* tools, previewing, confirming, or waiting for the user. Use it ONLY for the editing JUDGMENT (which take to keep, how to pick a threshold):\n\n<skill>\n" + skill + "\n</skill>"
      : "",
  ].filter(Boolean).join("\n\n");
}

export const THRESHOLD_SCHEMA = {
  type: "object",
  properties: {
    threshold_db: { type: "integer" },
  },
  required: ["threshold_db"],
  additionalProperties: false,
};

export const RETAKE_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          decision: { type: "string", enum: ["keep", "cut"] },
          group: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["index", "decision"],
        additionalProperties: false,
      },
    },
  },
  required: ["decisions"],
  additionalProperties: false,
};

export function thresholdSystem() {
  return wrapSystem({
    role: "Your job: choose a single Noise Threshold (dBFS) for loudness-based silence removal.",
    skill: readSkill("remove-silences"),
    judgment:
      "A good threshold is anchored to SPEECH: roughly 30 dB below the speech level (90th percentile), never closer than 10 dB to it, and always above the noise floor. The generous drop matters — quiet passages (the speaker leaning back, trailing off) sit 15–25 dB under their normal level and MUST stay above the threshold or they get shredded. A wide noise↔speech gap allows a more aggressive (higher, closer to 0) threshold; a narrow gap (noisy room, music bed) needs a conservative (lower) one. The meter is peak-per-window, NORMALIZED to the recording's own peak, with a hard −60 floor — so −60 means 'detect nothing'; never answer −60, stay within −55…−20. The heuristic suggestion is a fine starting point — adjust it with judgment, don't just echo it.",
  });
}

export function retakeSystem() {
  return wrapSystem({
    role: "Your job: mark which transcript segments are duplicate retakes / false starts / filler to CUT, keeping the clean final pass of each line.",
    // Inject ONLY the retake section of the editing skill (single source of truth,
    // minus the irrelevant trim/silence guidance that would dilute the judgment).
    skill: skillSection("premiere-edit", "retake / duplicate"),
    judgment: [
      "The recording is raw talking-head: the speaker constantly RESTARTS a line — starting over from the top, getting a little further each attempt — until one clean pass. These restarts are the duplicates to remove.",
      "Decide CUT vs KEEP for every segment:",
      "• CUT a segment when it RESTARTS the same words as a nearby segment (the staircase), ends mid-word or in a dash '-', trails off, is a prefix of a later segment, or is standalone filler / throat-clear / 'testing' / ambient noise like '(mouse clicking)'.",
      "• Of a run of restarts of ONE line, KEEP only the single most complete, fluent pass and CUT all the others — a run can be 3 or 30 long; cut every one but the keeper.",
      "• KEEP a segment that moves FORWARD with NEW content, even if it opens with similar words. A run of distinct, fluent sentences (each a different point) are ALL keepers — there can be several keepers in a row. A restart re-attempts the SAME words; a next point adds NEW words.",
      "• If no take of a line is clean alone, keep the FEWEST consecutive takes that together read as one fluent line (clean first half + clean second half).",
      "Calibration: BE DECISIVE about obvious restarts (ends in '-', or is a prefix of its neighbour → cut it). Keeping two or three versions of the same sentence 'to be safe' is the exact failure you must avoid — it leaves duplicates on the timeline. Reserve keep-when-unsure for genuine CONTENT ambiguity (distinct point vs duplicate?), never for plain restarts. Be thorough across the WHOLE list — long runs of one line can be 20–40 restarts; cut them all.",
    ].join("\n"),
  });
}

/** Compact dBFS histogram so the model can see the speech/noise distribution shape. */
function dbHistogram(silence, binSize = 5) {
  const bins = new Map();
  let total = 0;
  for (const c of silence.clips) {
    for (const d of c.db) {
      if (!isFinite(d)) continue;
      const floor = Math.floor(d / binSize) * binSize;
      bins.set(floor, (bins.get(floor) || 0) + 1);
      total++;
    }
  }
  if (!total) return "(no data)";
  return [...bins.keys()]
    .sort((a, b) => a - b)
    .map((f) => `${f} to ${f + binSize} dB: ${bins.get(f)} (${Math.round((bins.get(f) / total) * 100)}%)`)
    .join("\n");
}

export function thresholdPrompt(silence) {
  const st = silence.stats || {};
  return [
    "Audio loudness was measured across the whole timeline (ffmpeg, peak per 20ms window, NORMALIZED to the recording's own peak, clamped to a −60 floor — lower is quieter; −60 means at-or-below the meter floor).",
    "Overall:",
    `- windows analyzed: ${st.windows}`,
    `- min dB: ${st.minDb}`,
    `- max dB: ${st.maxDb}`,
    `- median dB: ${st.medianDb}`,
    `- noise floor (15th pct of non-silent): ${st.noiseFloorDb}`,
    `- speech level (90th pct): ${st.speechDb}`,
    `- heuristic suggestion: ${st.suggestedThresholdDb} dB`,
    "",
    "Loudness distribution (bin → window count):",
    dbHistogram(silence),
    "",
    "Return ONLY the Noise Threshold as a negative integer dBFS — audio below it is treated as silence and removed. No explanation.",
  ].join("\n");
}

export function retakePrompt(segmentLines, count, opts = {}) {
  const windowed = Number.isInteger(opts.decideFrom) && Number.isInteger(opts.decideTo);
  return [
    `Below are the timeline's transcript segments (${count}), one per line as "[index] m:ss text".`,
    "Decide which to CUT to remove re-recorded takes, false starts, and standalone filler.",
    windowed
      ? `This is a WINDOW of a longer timeline. Return decisions ONLY for indices ${opts.decideFrom}–${opts.decideTo}; the segments before/after that range are CONTEXT (so you can tell whether a line near the edge gets restarted or completed) — do NOT return decisions for the context segments.`
      : null,
    "Return decisions ONLY for the segments you CUT (everything else stays kept). Each: {index, decision:\"cut\", group, reason}.",
    'Use a shared integer "group" per beat so related takes cluster together in the UI. Keep "reason" to 6 words or fewer.',
    "If nothing should be cut, return an empty decisions array.",
    "",
    "Segments:",
    segmentLines,
  ].filter((l) => l != null).join("\n");
}

/* ===================== chunked retake analysis ===================== */
// A single claude call over a whole long timeline (400+ segments) is unreliable:
// it must emit hundreds of cut decisions in one structured answer and tends to get
// lazy mid-list or time out entirely. So we slice the timeline into overlapping
// windows — each window OWNS a block of segments and also sees a margin of context
// on both sides (so a restart-run that straddles a boundary is still judged with the
// line's completion visible). Each segment is decided by exactly ONE owner window,
// so merging is conflict-free. Windows run concurrently (capped).

function intEnv(name, def) { const v = parseInt(liveEnv(name) || "", 10); return Number.isFinite(v) && v > 0 ? v : def; }

/**
 * Plan owner-blocks + context margins over `n` segments. Pure (unit-tested).
 * Returns [{ownStart, ownEnd, ctxStart, ctxEnd}] with half-open ranges into the
 * segment array. ownStart..ownEnd is what this window decides; ctxStart..ctxEnd is
 * what it's shown.
 */
export function planRetakeChunks(n, block, context) {
  block = block || intEnv("EDITAGENT_AI_CHUNK", 36);
  context = context == null ? intEnv("EDITAGENT_AI_CHUNK_CONTEXT", 14) : context;
  const chunks = [];
  if (n <= 0) return chunks;
  // Small enough to do in one shot (no window note, full quality): skip chunking.
  if (n <= block + context) { chunks.push({ ownStart: 0, ownEnd: n, ctxStart: 0, ctxEnd: n, single: true }); return chunks; }
  for (let s = 0; s < n; s += block) {
    const ownStart = s, ownEnd = Math.min(n, s + block);
    chunks.push({ ownStart, ownEnd, ctxStart: Math.max(0, ownStart - context), ctxEnd: Math.min(n, ownEnd + context), single: false });
  }
  return chunks;
}

/** Run async `tasks` with at most `limit` in flight; preserves order. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Analyze retake/duplicate segments over a whole timeline, chunked + concurrent.
 * @param {Array} speechSegs  segments to judge (empties already removed), each
 *   {index, startSec, text} — the SAME objects the caller will mark by index.
 * @param {object} o  { model, effort, token, onProgress }
 * @returns {Promise<Array>} merged cut decisions [{index, decision:"cut", group?, reason?}]
 */
export async function analyzeRetakes(speechSegs, { model, effort, token, onProgress = () => {} } = {}) {
  const n = speechSegs.length;
  if (!n) return [];
  const startedAt = Date.now();
  const stats = { calls: 0, inputTokens: 0, outputTokens: 0 };
  if (token && !token.children) token.children = new Set(); // so cancel kills all chunk calls
  const plan = planRetakeChunks(n);
  const conc = intEnv("EDITAGENT_AI_CONCURRENCY", 4);
  const system = retakeSystem();
  let finished = 0;
  onProgress(`Claude is analyzing ${n} segments in ${plan.length} pass(es)…`);

  const tasks = plan.map((ch, ci) => async () => {
    if (token && token.aborted) return [];
    const win = speechSegs.slice(ch.ctxStart, ch.ctxEnd);
    const own = speechSegs.slice(ch.ownStart, ch.ownEnd);
    const ownIdx = new Set(own.map((s) => s.index));
    const lines = win.map((s) => `[${s.index}] ${mmss(s.startSec)} ${s.text}`).join("\n");
    const opts = ch.single ? {} : { decideFrom: own[0].index, decideTo: own[own.length - 1].index };
    const { data, raw } = await askClaude({
      prompt: retakePrompt(lines, win.length, opts),
      system, schema: RETAKE_SCHEMA, model, effort, token,
    });
    stats.calls += 1;
    stats.inputTokens += (raw.usage && raw.usage.input_tokens) || 0;
    stats.outputTokens += (raw.usage && raw.usage.output_tokens) || 0;
    finished += 1;
    if (plan.length > 1) onProgress(`Claude finished pass ${finished}/${plan.length}…`);
    // Keep only decisions this window OWNS (context decisions belong to another window).
    // Offset group ids per chunk so two windows' "group 0" don't merge into one panel cluster.
    const base = (ci + 1) * 100000;
    return (data.decisions || [])
      .filter((d) => d && d.decision === "cut" && ownIdx.has(d.index))
      .map((d) => (Number.isInteger(d.group) ? { ...d, group: base + d.group } : d));
  });

  const perChunk = await pool(tasks, conc);
  if (token && token.aborted) throw new Error("Cancelled");
  recordUsage({
    type: "claude",
    purpose: "Retake analysis",
    model: model || "latest",
    effort: effort || null,
    segments: n,
    calls: stats.calls,
    durationMs: Date.now() - startedAt,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    costUsd: 0, // headless claude -p runs on the user's Claude subscription
  });
  // Merge (owner-disjoint, so no conflicts); de-dup defensively by index.
  const byIndex = new Map();
  for (const cuts of perChunk) for (const d of cuts) if (!byIndex.has(d.index)) byIndex.set(d.index, d);
  return [...byIndex.values()];
}

