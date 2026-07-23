// The Animation tab's chat agent: a real multi-turn Claude Code session run
// headlessly on the user's subscription. Unlike ai.js's pure judgment oracle,
// this agent HAS tools (it writes the Remotion scene and may render stills to
// check itself) — but its cwd is the animation workspace OUTSIDE this repo, it
// loads no MCP servers (--strict-mcp-config), and it never touches Premiere:
// the server owns rendering and timeline placement.
//
// One `claude -p` process per user message; --session-id/--resume keep the
// conversation's full context across messages (and panel/server restarts).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { resolveClaudeLaunch, friendlyError } from "../ai.js";
import { cloudEnabled, cloudChatEnv } from "../cloud.js";
import { liveEnv } from "../config.js";
import { log } from "../log.js";

function chatTimeoutMs() {
  const v = parseInt(liveEnv("EDITAGENT_ANIM_TIMEOUT_MS") || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 1200000; // 20 min: a turn may typecheck + render stills
}

/** One-line description of a tool call for the panel's activity chips. */
export function toolDetail(name, input = {}) {
  switch (name) {
    case "Write": case "Edit": case "Read": case "NotebookEdit":
      return input.file_path ? basename(String(input.file_path)) : "";
    case "Bash":
      return String(input.description || input.command || "").slice(0, 80);
    case "Glob": case "Grep":
      return String(input.pattern || "").slice(0, 60);
    case "TodoWrite":
      return "updating plan";
    default: {
      const s = JSON.stringify(input);
      return s && s !== "{}" ? s.slice(0, 60) : "";
    }
  }
}

/**
 * The per-job system prompt APPENDED to Claude Code's default (the default
 * stays so tool behavior is normal). Repeated on every turn — each turn is a
 * fresh spawn and appended prompts are per-invocation.
 */
export function buildSystemAppend(job, styleSkill) {
  const durSec = (job.durationInFrames / job.fps).toFixed(2);
  return [
    "You are the OpenCutAgent animation agent. The user selected a range of their Premiere Pro timeline and is chatting with you (from a small panel chat, not a terminal) to build a silent Remotion animation for it.",
    "",
    "Who you are talking to (IMPORTANT): a VIDEO EDITOR, not a developer. They never see your tool calls, only a small status line plus your FINAL message per turn. So:",
    "- Keep the final message short (2 to 5 sentences), warm, and in plain creative language: describe WHAT the animation shows and when things appear, like a motion designer would.",
    "- Never include code, file paths, component names, or technical jargon in chat. No markdown headers or bullets of internals.",
    "- Do all technical narration silently; don't think out loud about files or APIs in your visible text.",
    "- Work directly in this session: never spawn sub-agents, schedule wakeups, or wait for background work; this turn ends when you stop.",
    "",
    `Your job: ${job.id}`,
    `- Work ONLY inside src/jobs/${job.id}/ (Scene.tsx is yours; brief.md is the assignment; refs/ holds the user's reference images).`,
    `- Canvas ${job.width}x${job.height} @ ${job.fps} fps, duration ${job.durationInFrames} frames (${durSec}s) — FIXED, never change job.json or the manifest.`,
    `- Background: ${job.background === "transparent" ? "TRANSPARENT overlay (the render keeps alpha over the user's footage — use <Canvas transparent>)" : "solid dark canvas (b-roll that covers the footage — use <Canvas>)"}.`,
    "- Read brief.md FIRST on the first message (it has the narration with word timings and the full-video transcript).",
    "- You may append a general lesson to the style's Learnings Log (styles/" + job.style + "/SKILL.md) when the user corrects a reusable pattern. Everything else outside your job folder is read-only.",
    "",
    "Finishing protocol (IMPORTANT):",
    `- When the scene compiles (npx tsc --noEmit) and you're satisfied, write src/jobs/${job.id}/render.json as {"version": N, "notes": "...", "title": "..."} — start at 1 and bump N on every revision that should be re-rendered. "title" is a short human name for what you built (2 to 3 plain words, 20 characters max, e.g. "Webhook branches") — it labels this animation in the panel.`,
    "- The SERVER watches that file: after your reply it renders the composition and places the clip on the Premiere timeline automatically. Do NOT run `remotion render` for the final yourself, and you have no access to Premiere.",
    "- Stills for self-checking are fine: npx remotion still " + job.id + " src/jobs/" + job.id + "/check.png --frame=N (then view the PNG).",
    "- If you're only answering a question or the scene isn't ready, don't touch render.json.",
    "",
    "The style guide below is authoritative for how the animation should look:",
    "<style-skill>",
    styleSkill || "(style guide missing — default to a clean hand-drawn dark whiteboard look)",
    "</style-skill>",
  ].join("\n");
}

/**
 * Run one chat turn. Streams UI events through onEvent:
 *   {kind:"delta", text}                 assistant text as it streams
 *   {kind:"tool", name, detail}          a tool call started
 * Resolves {ok, text, sessionId, usage, durationMs, numTurns} when the turn ends.
 */
export function runChatTurn({ kitDirPath, job, prompt, styleSkill = "", model, effort, token, onEvent = () => {} }) {
  return new Promise((resolve, reject) => {
    const [bin, ...prefixArgs] = resolveClaudeLaunch();
    const sessionId = job.sessionId || randomUUID();
    const args = [
      ...prefixArgs,
      "-p",
      "--verbose",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
      "--strict-mcp-config",
      // Core tools only: file work + bash for typecheck/stills. No Task/Agent or
      // scheduling — a -p turn that "waits for a background agent" waits forever
      // (seen live: the agent spawned a survey sub-agent + a wakeup on turn one).
      "--tools", "Bash,Read,Write,Edit,Glob,Grep",
      job.sessionId ? "--resume" : "--session-id", sessionId,
      "--append-system-prompt", buildSystemAppend(job, styleSkill),
    ];
    if (model && model !== "latest") args.push("--model", model);
    if (effort) args.push("--effort", effort);

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // never silently bill a stray API key
    if (cloudEnabled()) {
      // Cloud mode: the CLI bills through the OpenCutAgent proxy on the
      // user's account (base-URL gateway override + bearer token) instead of
      // a Claude subscription. Tools still run locally in the workspace.
      Object.assign(env, cloudChatEnv());
    }

    let child;
    try {
      child = spawn(bin, args, { cwd: kitDirPath, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(friendlyError(e.message, e.code)));
      return;
    }
    if (token) { token.child = child; if (token.children) token.children.add(child); }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, chatTimeoutMs());

    let buf = "";
    let stderrBuf = "";
    let emitted = ""; // all text streamed so far (dedupes partial deltas vs full messages)
    let result = null;
    let startedAt = Date.now();

    const handleLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === "stream_event") {
        const ev = msg.event || {};
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text) {
          emitted += ev.delta.text;
          onEvent({ kind: "delta", text: ev.delta.text });
        }
        return;
      }
      if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            onEvent({ kind: "tool", name: block.name, detail: toolDetail(block.name, block.input || {}) });
          } else if (block.type === "text" && block.text) {
            // Fallback when partial deltas weren't emitted (older CLI builds).
            if (!emitted.endsWith(block.text)) {
              const chunk = (emitted && !emitted.endsWith("\n") ? "\n" : "") + block.text;
              emitted += chunk;
              onEvent({ kind: "delta", text: chunk });
            }
          }
        }
        return;
      }
      if (msg.type === "result") result = msg;
    };

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    child.stdin.on("error", () => { /* swallow EPIPE if the process never started */ });

    child.on("error", (e) => {
      clearTimeout(timer);
      if (token) { if (token.child === child) token.child = null; if (token.children) token.children.delete(child); }
      reject(new Error(friendlyError(e.message, e.code)));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf) handleLine(buf);
      if (token) { if (token.child === child) token.child = null; if (token.children) token.children.delete(child); }
      if (token && token.aborted) { reject(new Error("Cancelled")); return; }
      if (timedOut) { reject(new Error(`The animation agent didn't finish within ${Math.round(chatTimeoutMs() / 60000)} minutes. Try again (the session resumes where it left off), or raise EDITAGENT_ANIM_TIMEOUT_MS.`)); return; }
      if (!result) {
        log("animation chat: no result event. stderr:", stderrBuf.slice(0, 500));
        reject(new Error(friendlyError(stderrBuf.trim() || `claude exited with code ${code} and produced no result.`)));
        return;
      }
      if (result.is_error && !String(result.result || "").trim()) {
        reject(new Error(friendlyError(result.result || stderrBuf.trim() || "The animation agent returned an error.")));
        return;
      }
      resolve({
        ok: !result.is_error,
        text: typeof result.result === "string" ? result.result : emitted,
        streamedText: emitted,
        sessionId: result.session_id || sessionId,
        usage: result.usage || null,
        numTurns: result.num_turns || null,
        durationMs: Date.now() - startedAt,
      });
    });

    try {
      child.stdin.write(prompt || "");
      child.stdin.end();
    } catch (e) {
      log("animation chat: stdin write failed:", e.message);
    }
  });
}
