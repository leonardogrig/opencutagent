// Unit checks for the persistent AI usage log (.cache/usage-log.json): entries
// append and survive re-read, newest-first ordering, totals math, resilience to
// a missing/corrupt file, and the no-init no-op guarantee (logging must never
// break a transcription or an edit).
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initUsage, recordUsage, readUsage } from "../usage.js";

let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

const dir = mkdtempSync(join(tmpdir(), "editagent-usage-"));
initUsage(dir);

// empty log reads clean
{
  const r = readUsage();
  check("empty log: no entries, zero totals", r.entries.length === 0 && r.totals.costUsd === 0 && r.totals.claudeCalls === 0, r);
}

// record + read back, newest first, totals sum
{
  recordUsage({ type: "transcription", model: "scribe_v2", media: "a.mp4", seconds: 1800, costUsd: 0.11 });
  recordUsage({ type: "claude", purpose: "Retake analysis", model: "latest", calls: 12, inputTokens: 90000, outputTokens: 8000, costUsd: 0 });
  const r = readUsage();
  check("two entries recorded", r.entries.length === 2, r.entries.length);
  check("newest first", r.entries[0].type === "claude" && r.entries[1].type === "transcription", r.entries.map((e) => e.type));
  check("entries carry a timestamp", r.entries.every((e) => Number.isFinite(e.ts)), r.entries);
  check("totals: cost + transcribed seconds + claude calls", Math.abs(r.totals.costUsd - 0.11) < 1e-9 && r.totals.transcribedSec === 1800 && r.totals.claudeCalls === 12, r.totals);
}

// corrupt file: reads as empty, next record starts fresh instead of throwing
{
  writeFileSync(join(dir, "usage-log.json"), "{not json");
  check("corrupt log reads as empty", readUsage().entries.length === 0, null);
  recordUsage({ type: "claude", purpose: "Threshold calculation", calls: 1, costUsd: 0 });
  check("record after corruption starts fresh", readUsage().entries.length === 1, readUsage().entries.length);
}

// un-initialized module must be a silent no-op (tests import RPC handlers without booting index.js)
{
  initUsage(null);
  recordUsage({ type: "claude", calls: 1 });
  const r = readUsage();
  check("no-init: record no-ops, read returns empty", r.entries.length === 0, r);
}

rmSync(dir, { recursive: true, force: true });

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("All usage-log checks passed.");
