# Working in OpenCutAgent

OpenCutAgent (formerly EditAgent; the local folder is still `editagent/`) is a Premiere Pro CEP panel + Node MCP server that lets Claude edit a video on Premiere's **live timeline**: transcribe, mark retakes/silences, cut, and generate Remotion animations onto a track. The AI judgment is always **Claude itself** (this chat via the `ppro_*` tools, a headless `claude -p` spawned by the server, or the cloud proxy). There is no other LLM.

- `docs/ARCHITECTURE.md` explains how the pieces talk and why. Read it once.
- `docs/LESSONS.md` is the dated, full-detail history of every feature and failure (symptom, root cause, fix). **Search it before debugging anything that "used to work" or looks like a known symptom.** It is long on purpose; it is not loaded per session.
- **When you hit a new failure and find the fix:** add a one-line rule under the matching section below, and the full story to `docs/LESSONS.md` (and to the project memory file).

## Layout

```
Claude Code --stdio--> server/ (MCP + ws 127.0.0.1:3001 + ffmpeg/Scribe/claude -p) --ws--> cep-panel/client (UI) --evalScript--> cep-panel/host/premiere.jsx (ALL Premiere DOM access)
```

- `server/` - tools (`tools/`), RPCs the panel calls (`rpc/index.js`), review/segmentation (`review.js`, `transcription/`), silences (`silences.js`, `audio/`), headless AI (`ai.js`), cloud proxy client (`cloud.js`), animation agent (`animation/`), XML fast-apply (`rebuild.js`, `roundtrip.js`). State: `ctx.review`, `ctx.silence`, `ctx.panelOp` (edit lane), `ctx.animOp` (animation lane).
- `cep-panel/client/` - `main.js` + `index.html` + `styles.css` (token system, spec in `cep-panel/DESIGN.md`, gallery in `preview.html`). Debug handle in a browser: `window.__editagent = {Retake, Silence, AI, Anim, setConn}`.
- `animation-kit/` - Remotion template. At runtime it is synced to **`~/.opencutagent/animation-kit`** (the agent's cwd must be outside this repo or it auto-loads this file). Styles are drop-in packages `styles/<id>/{style.json,SKILL.md,src/}`; `n8n-brand`, `n8n-ui`, `n8n-game` are gitignored/local-only.
- `.claude/skills/` - the editing workflows; the same text is injected into headless calls (single source of truth).
- Backend (cloud mode, metered proxy, site): separate private repo `~/Documents/opencutagent_backend`.

## Server and connection (the #1 source of "why isn't it working")

The panel is ONLY a ws client. Nothing works until `server/index.js` listens on 3001. It is started by (1) the panel auto-start, (2) Claude Code via `.mcp.json` (needed for Sync mode; start Claude Code first), or (3) `npm start` / `./start-opencutagent.command`. One server per machine, operating on whatever sequence is active.

- Check who holds the port: `lsof -nP -iTCP:3001 -sTCP:LISTEN`. A relative `node server/index.js` command = started by hand in a terminal.
- **"panel not connected" though the panel says Connected / "Unknown RPC method" after a code change:** a stale server (often from a SECOND Claude Code window) owns 3001 with old code. Keep ONE Claude Code window in the project, `pkill -9 -f "editagent/server/index.js"` once (does not match a hand-started server; kill that by PID), then `/mcp` reconnect `premiere`. Do not kill+probe repeatedly; every kill triggers a respawn.
- **"Waiting for server…"** = no server on 3001, not a code bug. Reopen the panel or start one by hand.
- A zombie MCP-spawned server that is alive but not listening (ppid = a `claude` process) is harmless.
- `.mcp.json` is gitignored (template `.mcp.json.example`); this Claude Code build does NOT expand `${VAR}`, use absolute paths.
- **Ground truth without the MCP:** kill the squatter and run a throwaway script importing `server/bridge.js` + `review.js` that binds 3001, waits for the panel to reconnect, dumps `getTimeline`/`buildReview`/`reconcile`, exits. Give it a dummy `rpcDispatcher`. Never "just connect and peek" at a running server: a second ws client hijacks the panel binding.
- **Live panel DevTools:** `cep-panel/.debug` + PlayerDebugMode expose the real panel at `http://localhost:8078` (`curl /json`, then `Runtime.evaluate` over its ws). Use this FIRST for "behaves weird only in Premiere"; it beats screenshot guessing.
- The panel-spawned server has stdout on /dev/null (no log) and inherits the bare GUI PATH; `server/paths.js augmentPath()` widens it. Reproduce PATH bugs with `env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin node …`.

## Loading code changes

- `server/*` -> restart Claude Code (or kill the panel's server; it respawns). No hot reload; `ctx.review` is lost. `.env` changes are live (`liveEnv`).
- `cep-panel/host/premiere.jsx` -> reopen the panel, or hot-patch with `$.evalFile("<abs repo path>/cep-panel/host/premiere.jsx")` via `ppro_run_script`. Batch ops self-heal on "Unknown action" by doing this themselves.
- `cep-panel/client/*` -> reopen the panel.
- `animation-kit/*` -> the workspace resyncs on the next `ensureKit` (hash-stamped). The sync is ADDITIVE: delete removed files from `~/.opencutagent/animation-kit` by hand. Style `SKILL.md` and `frames/SKILL.md` are PRESERVED in the workspace (they carry a user Learnings log): bump `<!-- guide-version: N -->` or the change is invisible, including to tests that read the workspace copy (tests should read `KIT_TEMPLATE_DIR`).

## Retake workflow (Sync mode)

1. `ppro_get_timeline_state` returns data = connected.
2. `ppro_get_retake_segments` populates `ctx.review` (one segment per sentence, pause, cut-off word, immediate word-for-word repeat, or capitalised sentence starter; Scribe audio events and loudness-detected "(unrecognized sound)" stretches are their own word-empty, auto-cut segments; the "Generated segments" clip mode is gone). Judge the segments yourself: keep the most complete pass of each serial-restart run; distinct next-points may yield several keepers per beat; cut fragments and false starts. No-speech segments are auto-cut deterministically, not your call.
3. `ppro_mark_retakes` in one batched call.
4. `ppro_apply_retakes` (`remove_gaps:true` = ripple, `remove_fillers:true` = also cut um/uh) or the panel's Apply All. You pick WHICH segments go; the server places every cut edge in the quiet between words (`server/cutplan.js`).
5. **Verify by re-reading the timeline** (clip count + duration). "applied X/X" counts host calls, not deletions.

Apply ladder for big cuts: FCP7-XML round-trip (preserves effects, makes a NEW "… - tightened" sequence, not undoable) -> generated XML rebuild -> in-place razor/lift/close batches. A failed razor apply = a sliced timeline; recover with New Sequence From Clip, do not undo hundreds of steps. A "Translation Report" alert on apply is benign (from the XML export step).

## Hard rules (each one cost a session; see LESSONS.md for the story)

**Copy and UX**
- **No em dashes in any user-visible string** (client, server messages, skills, style guides). Tests check style skills for them.
- Never copy competitor strings verbatim (AutoCut/TimeBolt). Parameter semantics may match; distinctive copy may not.
- Durations are formatted at the message, never at the data: `fmtDur` (footage length, "1:25") vs `fmtElapsed` (wall clock, "3m 12s") in `server/tools/util.js` with byte-identical twins in `main.js`. Keep them in sync.
- The animation chat's audience is a VIDEO EDITOR: never surface tool calls, code, paths or jargon in the panel.
- **No code path may end an animation turn without writing something to chat.json.** A toast is not an error signal.
- Every pre-flight number field the user cannot judge yet belongs inside the flow, not before it (raw-animation length lives in the chat header).

**CEP panel engine gaps (browser QA cannot catch these)**
- CEP's Chromium has **no `:has()`** and **no `window.prompt`**. Drive state classes from JS (`syncSegCtl`), use inline inputs for naming.
- `hidden` attribute: a global `[hidden]{display:none!important}` exists. Never add a component `[hidden]` override; never pair the attribute with an inline `style.display` show.
- Never show an element by clearing its inline display when the stylesheet hides it; set the real value (`display:"flex"`).
- `cep.getSystemPath("extension")` returns a percent-encoded `file://` URI: strip + `decodeURI` before any fs call.
- Use `nodeRequire` (require -> `cep_node.require` -> null) and handle null.
- Selected-state selectors: `.chk input[type="checkbox"]:not(.switch)` guards the switch styling; keep it.

**Server and editing semantics**
- Reconcile on media + track + source-overlap, **never `clipId`** (renumbers after a razor). Stored `startFrame/endFrame` go stale after any ripple; apply and export always reconcile live.
- **Never cut on a raw transcript timestamp.** Scribe word starts sit ~50-240 ms AFTER the real onset and word ends ~180 ms BEFORE the voice stops, so a cut on a segment tile edge clips the kept sentence's first letters. Segment tiles are the review unit only; `cutplan.js planCutSpans` places every edge in the quiet between words on the loudness envelope (margin of air on the kept side, lowest-energy window in continuous speech, timestamp pads only when no envelope). Keep new trims (pauses, fillers) on that path.
- Only true 29.97/59.94 are drop-frame; "30 fps" is often 30.00003 non-drop.
- Transcription is per source FILE (cached, ranged islands, batched concat), never per clip. Reload reuses cache; `cacheOnly` paths must never bill. `scribe_v2` only.
- Silence meter: normalized peak metering, hard -60 floor, keepTalk demotion unconditional on length. Keep server `detectSilences`/`estimateThreshold` and the panel mirrors in sync (`test/silence.js` pins both). Do not re-add the isolation guard or "minimum time between cuts".
- Sequence markers are the only recolorable timeline annotation (Premiere cannot recolor TrackItems, DVAPR-4217788); ours are sentinel-tagged in `comments`.
- Auto-resync must send the same `segment_mode`/`track` as the last explicit load (`loadParams()` is the single source).
- Cache clearing touches `.cache/{transcripts,levels,rebuild}` only; `usage-log.json` and decisions files stay.
- Env vars stay `EDITAGENT_*`, localStorage `editagent.*`, `$.editagent` namespace; only user-facing names say OpenCutAgent.

**Headless and cloud AI**
- `claude -p` oracle flags are non-negotiable: `--strict-mcp-config`, `--tools ""`, cwd = tmpdir, prompt on stdin, `--json-schema`, no `--bare`, `ANTHROPIC_API_KEY` deleted from env. There is **no `--max-turns`** in this CLI build; verify any flag before designing around it. `--fork-session` exists and is what makes chat rewind possible.
- `EDITAGENT_CLAUDE_CONFIG_DIR` (this machine: `~/.claude-personal`) selects the login for spawns; "OAuth session expired" means the wrong/stale config dir.
- Model list comes from the CLI `initialize` handshake (`listClaudeModels`); index.html options are the offline fallback only, version-free, not hand-maintained. A stale persisted pick must fall back to `options[0]`, never a hardcoded name.
- Cloud mode (default; `~/.opencutagent/cloud.json`) routes AI + transcription through the backend on OpenRouter/ElevenLabs; the local server is still required. **This machine runs self-hosted mode**; AI is paid-only in cloud mode (402 on free).

**Animation kit and renders**
- Never set codec-specific knobs (CRF, mute) globally in `remotion.config.ts`; pass them per render. `--muted=false` on the CLI beats `setMuted(true)`. Audio is opt-in per style (`style.json "audio": true`).
- Never let a font or asset hold an un-retried, un-timed-out `delayRender`; fonts are inlined data URIs via `scripts/inline-fonts.mjs`. Concurrency is capped by resolution (`renderConcurrency`).
- No wall-clock caps on agent/render turns; stall watchdogs instead (`EDITAGENT_ANIM_STALL_MS`, `_RENDER_STALL_MS`). Failures persist to chat.json; "Render again" re-renders without a new turn.
- Placement uses `track.overwriteClip` (never insert), reconciled live at place time; renders always get a NEW versioned filename. Render versions and placed clips are never rewound.
- "Use frames": frames are exported by Premiere itself (QE `exportFramePNG`, ground truth of what the viewer sees; ffmpeg decode of the V1 source can disagree by 2x). Anchored drawings are declared in `anchors.json` and checked by `check-anchors.mjs` before render; `DebugFrame` returns null under `final:true`.
- Every job gets `words.json` (word timings, `[]` for raw jobs). `sizeSource:"custom"` is never "corrected" to the sequence size.
- Pixel-art styles: hand-authored row spans and pixel glyphs beat procedural shapes; held zoom magnifications in multiples of 0.2 with a rounded view origin; a logo tile keeps its own colours (`imageTone:"color"`, flat, no emboss).

## Testing and QA

- `npm test` (whole chain; `server/test/*`), `npm run check` (parses AND flags calls to exported names a file neither imports nor declares; run after any import-touching refactor), `npm run eval:retakes` (real `claude -p` vs a human-labeled 412-segment fixture, 97% F1 baseline), kit: `cd animation-kit && npx tsc --noEmit`.
- **Browser QA of the panel:** `python3 -m http.server --directory cep-panel/client`, open `index.html` (renders outside CEP) or `preview.html` (component gallery). Inject state via `__editagent.*` hooks (`Retake.applyReviewUpdate`, `Retake.setMap`, `AI.renderUsage`, `AI.setCloud`, `Anim.setJobs/openJob/onEvent`, `setConn`). Chrome caches index.html AND styles.css across sessions: hard-reload. Screenshot coordinates are not CSS px (scale by `screenshotW/innerWidth`); an unfocused tab throttles timers, so record events instead of single reads.
- **Kit render QA:** scaffold a throwaway `src/jobs/<id>/` + manifest in the repo kit, `node node_modules/@remotion/cli/remotion-cli.js render <id> out.mp4 --browser-executable=~/.opencutagent/animation-kit/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell`, pull frames with ffmpeg `select`+`tile`, then restore the empty manifest. Re-run a failed job's render by hand the same way to see the untruncated error; a leftover `remotion-webpack-bundle-*` in tmp means a run that did not exit cleanly. Pixel-art iteration: a PPM generator + ffmpeg is ~2s per round vs ~25s for a still.
- Phase-0 probes: version-sensitive Premiere APIs (`insertClip`, `overwriteClip`, `createMarker`, `setColorByIndex`, `exportAsFinalCutProXML`) get a `ppro_run_script` probe before you trust a try-ladder.
- Many features are marked "NOT yet live-verified" in LESSONS.md; when you run one live for the first time, note the result there.

## Quick symptom index

| Symptom | Cause / fix |
|---|---|
| "0 to cut" after Transcribe | No analysis ran; Transcribe only transcribes. Run Analyze w/ Claude or judge in Sync. |
| Apply reports "Removed 0/N" instantly | Stale host script; batch ops now self-heal, otherwise `$.evalFile` the jsx. |
| "Nothing to cut on the timeline" | Cuts already applied earlier (tail removal is invisible near the playhead); footer counts pending cuts only. |
| ffmpeg ENOENT from the panel | Bare GUI PATH; fixed by `paths.js`, or set `FFMPEG_BIN` in the gear's Advanced panel. |
| ElevenLabs 401 | Key needs the `speech_to_text` scope; key verification uses that endpoint, not `/v1/user`. |
| quota_exceeded | Progress is cached per island; Reload only bills the uncovered remainder. |
| Every segment listed twice | Same footage stacked on V1+V2; `dedupeStackedSegments`. |
| ffmpeg exit 234 on Load/Scan | A silent clip (a placed animation); skipped via `hasAudioStream`. |
| Transparent render exit 1 | A CRF set globally with ProRes; keep codec knobs out of remotion.config.ts. |
| Animation placed at 1920x1080 in a bigger sequence | Read `sequence.frameSize` via `sequenceFrameSize()`; `renderScale` self-heals on the next version. |
| Image pills invisible in chat | Inline display cleared instead of set. |
| Panel-spawned AI "OAuth session expired" | `EDITAGENT_CLAUDE_CONFIG_DIR` unset; or `command claude /login` in the default dir. |
