// Persistent AI usage log: every ElevenLabs Scribe call (real money) and every
// headless `claude -p` run (subscription, no per-token bill) is appended here so
// the panel's usage modal can show WHEN AI ran and WHAT it cost. Lives at
// .cache/usage-log.json (the .cache root, NOT a clearable subdir: Clear cache
// must never erase the spend history). Logging is strictly best-effort; a
// failure to record must never break a transcription or an edit.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

const MAX_ENTRIES = 1000;
let usagePath = null;

export function initUsage(cacheDir) {
  usagePath = cacheDir ? join(cacheDir, "usage-log.json") : null;
}

function readAll() {
  try {
    const parsed = JSON.parse(readFileSync(usagePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // missing or corrupt: start fresh, never throw
  }
}

/**
 * Append one usage entry. Shapes:
 *  - { type:"transcription", model, media, seconds, costUsd }
 *  - { type:"claude", purpose, model, effort, calls, durationMs,
 *      inputTokens, outputTokens, costUsd }  (costUsd 0 = subscription)
 */
export function recordUsage(entry) {
  if (!usagePath || !entry) return;
  try {
    const all = readAll();
    all.push({ ts: Date.now(), ...entry });
    writeFileSync(usagePath, JSON.stringify(all.slice(-MAX_ENTRIES), null, 2));
  } catch (e) {
    log("usage log write failed (ignored):", e.message);
  }
}

/** All entries, newest first, plus lifetime totals for the modal footer. */
export function readUsage() {
  const entries = readAll().slice().reverse();
  let costUsd = 0, transcribedSec = 0, claudeCalls = 0;
  for (const e of entries) {
    if (Number.isFinite(e.costUsd)) costUsd += e.costUsd;
    if (e.type === "transcription" && Number.isFinite(e.seconds)) transcribedSec += e.seconds;
    if (e.type === "claude") claudeCalls += e.calls || 1;
  }
  return { entries, totals: { costUsd, transcribedSec, claudeCalls } };
}
