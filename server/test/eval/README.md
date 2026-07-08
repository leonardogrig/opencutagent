# Retake-judgment eval

Measures how well the **headless retake AI** (`server/ai.js` → `analyzeRetakes`, the engine behind the panel's "Analyze w/ Claude" button) removes duplicate takes / false starts, scored against a human-labeled timeline. It runs the **real** `claude -p` oracle through the **real** chunked code path — this is the production path, not a mock.

## Why it exists

The panel was keeping obvious **serial restarts** ("n8n now has-" → "n8n now has a set of skills-" → … all kept) and, on a full timeline, the single giant `claude` call **timed out**. This harness turns that into a number so the skill/prompt/chunking can be tuned against a fixed target instead of by feel.

## Run

```bash
npm run eval:retakes                 # full 412-segment set, sonnet/high, chunked (real path)
npm run eval:retakes -- --range 0-39 # cheap subset (the clearest restart cluster) for fast iteration
npm run eval:retakes -- --model latest --effort high   # reproduce the panel's default config
npm run eval:retakes -- --single     # OLD one-call path (times out on the full set — for comparison)
npm run eval:retakes -- --from out/last.json           # re-score the last run offline (free, no API call)
```

Each real run is saved to `out/<fixture>-<model>-<effort>.json` and `out/last.json` (gitignored). Re-score any saved run with `--from` — useful after changing the scoring logic without paying for another call.

⚠️ Real runs spend the user's Claude subscription and take minutes. It is **not** part of `npm test`. The pure windowing logic (`planRetakeChunks`) *is* unit-tested in `server/test/retakeSegments.js`.

## What it reports

- **recall** — % of real retakes caught (higher = fewer kept duplicates; this was the bug).
- **precision** — % of cuts that were correct (higher = less good content lost).
- **beat-level: leftover duplicates / lost content** — the user-facing score. Forgives "kept the other identical take" (the duplicate is still removed, the AI just picked the other one), which strict per-segment recall/precision wrongly counts as errors. *This* is the number to watch.
- **MISSED RETAKES / OVER-CUTS** — the exact segments to eyeball, with text.

## Fixtures

- `fixtures/retakes-n8n.segments.txt` — 412 real speech segments + 5 ambient, as fed to the AI (`[index] m:ss text`).
- `fixtures/retakes-n8n.golden.json` — human-approved beats `[[start,end],[keepers]]` (from `.cache/gen-decisions.mjs`). Every index in a beat range that isn't a keeper is a CUT.

To add a fixture: drop `<name>.segments.txt` + `<name>.golden.json` in `fixtures/` and run with `--fixture <name>`.

## Baseline (2026-06-29, sonnet/high)

| path | result |
|------|--------|
| old single call, full set | **timed out (>900s)** — no answer |
| chunked + improved skill, full set | recall 97.5%, precision 97.2%, F1 97.4% — beat-level: **3 leftover dupes, 4 lost** of 412 |
