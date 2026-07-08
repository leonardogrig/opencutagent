# OpenCutAgent architecture

OpenCutAgent lets Claude (or the panel's own buttons) edit a video on Adobe Premiere Pro's **live timeline**: transcribe what is said, decide what to cut (retakes, false starts, dead air), and apply the cuts to the real sequence, undoably. This page explains how the pieces talk and why the load-bearing design decisions look the way they do.

## The four pieces

```
Claude Code ──stdio──► MCP server (server/) ──ws 127.0.0.1:3001──► CEP panel (cep-panel/client) ──evalScript──► premiere.jsx
             MCP tools   Node: ffmpeg, Scribe,                        UI, waveform, review list        ALL Premiere DOM access
             (ppro_*)    cut math, headless claude                    auto-reconnects
```

- **MCP server** (`server/`): the brain. Hosts the WebSocket bridge the panel connects to, exposes the `ppro_*` MCP tools to Claude Code, runs ffmpeg (loudness envelopes, audio extraction), calls ElevenLabs Scribe (transcription), computes every cut list, and, for the panel's AI buttons, spawns headless `claude -p` calls. All in-memory session state lives here: `ctx.review` (loaded segments + keep/cut marks) and `ctx.silence` (loudness session).
- **CEP panel** (`cep-panel/client/`): the face. A plain HTML/JS/CSS panel inside Premiere. It is **only a WebSocket client + evalScript proxy**: it renders state pushed by the server, forwards host operations to ExtendScript, and never computes cut decisions itself.
- **Host script** (`cep-panel/host/premiere.jsx`): the only file that touches Premiere's scripting API. Every operation is dispatched as `$.editagent.dispatch(action, params)` and returns JSON. It is ExtendScript (ES3) and wraps version-sensitive Premiere APIs in try-ladders.
- **Skills** (`.claude/skills/`): teach a Claude Code session the editing workflows (read, propose, confirm, execute, verify). The same skill text is injected into headless calls so both AI modes share one source of truth.

### Who starts the server

There is **one server per machine** (port 3001, or `PREMIERE_BRIDGE_PORT`); it operates on whatever sequence is active in Premiere. Three launchers, deliberately collision-safe:

1. **The panel auto-starts it.** When a connect attempt fails, `main.js` spawns `node server/index.js` (check-first: it only spawns after a failed connect, so it never fights an existing server). Just opening the panel is enough for headless use.
2. **Claude Code spawns it** via `.mcp.json` (stdio) when a session opens in the project. Required for Sync mode (chat drives the tools). Start the session first so its server owns the port; the panel then connects instead of auto-starting.
3. **Manually:** `npm start` or `./start-opencutagent.command`.

The bound port is written to `~/.editagent/bridge-port` so the panel finds the server even when the port had to move.

## The two AI modes

The "AI analysis" (which take to keep, what threshold counts as silence) is always **Claude itself**; there is no external LLM API. The panel's "Sync with Claude Code" toggle picks the transport:

- **OFF (default, headless):** the panel's "Analyze w/ Claude" / "Suggest threshold" buttons call server RPCs that spawn `claude -p` on the user's subscription (`server/ai.js`). The call is a pure judgment oracle: segment data in, JSON decision out (enforced by `--json-schema`), with **no tools and no MCP config** (`--strict-mcp-config`, `--tools ""`, cwd outside the project) so it can never touch Premiere or spawn a second bridge.
- **ON (Sync):** the buttons defer to the user's live Claude Code chat. Claude calls the `ppro_*` tools and pushes results to the panel (`reviewUpdate`, `silenceConfig` messages).

Both modes write the same server state, so results render identically in the panel.

Long timelines are **chunked**: `analyzeRetakes` splits the segment list into overlapping windows (~36 owned segments + ~14 context each side, concurrency-capped, owner-disjoint merge), turning one giant unreliable call into many small reliable ones. This took the 412-segment eval from timeout to 97% beat-level F1 (`npm run eval:retakes`).

## Retakes pipeline

1. **Transcribe the source, not the timeline.** Premiere's own transcript is not scriptable, so the server transcribes the **source media file** once (ElevenLabs Scribe) and maps words onto the timeline. This matches how Premiere TBE/Descript/TimeBolt work: one accurate transcription, cached, survives any re-edit.
2. **Timeline-scoped billing.** Only the source ranges actually used on the timeline are sent to Scribe (`transcribeSourceRanges`): used ranges merge into a few padded "islands", and a union cache (`.cache/transcripts/`) means a reload after cutting never re-bills already-transcribed audio.
3. **Clip-bounded segmentation** (`review.js buildReview`): the transcript is sliced to each clip's window, phrased within the clip, and the clip's `[sourceIn, sourceOut]` is tiled with no gaps, so a segment never crosses a cut and cutting a segment leaves no slivers. Word-empty clips become one cuttable "(no speech)" segment and are auto-marked Cut deterministically (never delegated to the AI).
4. **Reconcile against the live timeline** (`review.js reconcile`): every segment carries its **source range** (media path + source in/out + track), and before any apply the server re-locates each segment on the live timeline (`present` / `partial` / `absent`), keyed on media+track+source-overlap, never on clip ids (they renumber after razors) and never on stored timeline frames (they go stale after the first ripple). Razoring stale frames is the classic "razor everywhere, delete nothing" failure.
5. **Apply** ripple-deletes the Cut segments (see fast apply below) and **verification reads the timeline back** (clip count + duration); host call counts are not trusted.

## Silence pipeline (no transcription, no API key)

`server/audio/levels.js` extracts a per-window **peak envelope** with ffmpeg, **normalized to the recording's own peak** and floored at -60 dB. Normalization is what makes threshold values portable across recordings (a "-45" on a quietly-recorded take then behaves like "-45" in AutoCut/TimeBolt, which meter the same way). `detectSilences` applies the threshold plus the pacing knobs (min silence length, keep-talk, margins); keep-talk demotion is unconditional on length, matching industry semantics. The panel renders the envelope and recomputes zones instantly client-side with mirrored logic (`test/silence.js` pins server and panel mirrors together).

## Fast apply: the three-rung ladder

Applying hundreds of cuts in place is slow (each ripple shifts every downstream clip) and Premiere's per-track razor makes it O(ranges x clips). `applyRangesBatched` (`silences.js`) picks the fastest safe path:

1. **Round-trip XML** (`roundtrip.js`, default for ripple applies with >= `EDITAGENT_REBUILD_MIN` cuts): export the sequence as Premiere's own FCP7 XML, surgically edit **timing only** (split/trim/delete clip items, recompute ticks, fix links, shift markers) while passing every node we don't understand through verbatim, and reimport as a new `<name> - tightened` sequence. Effects, transforms, and audio levels that FCP7 XML can carry survive. Verified live 2026-07-03.
2. **Generated rebuild** (`rebuild.js`): if the round-trip fails, build a bare FCP7 XML sequence from our own bookkeeping (A/V sync by construction, BigInt-exact frame math). Drops clip effects; refuses timelines it cannot represent (titles, speed changes) by throwing.
3. **Batched razor** (in-place fallback, and the path for lift/mute or small applies): razor every edge first (razors never shift), lift-delete pieces per range, then close gaps per track with self-verifying emptiness checks, chunked ~50 ranges per host call for progress and cancel.

Rungs 1-2 produce a **new** sequence (undo = delete it); rung 3 edits in place under an undo snapshot (`undo.js`, Cmd+Z friendly).

## Design rules that keep this maintainable

- **All Premiere access in one file** (`premiere.jsx`). A future UXP port touches one file.
- **Pure functions for all edit math** (interval merging, frame conversion, XML surgery, cut-list building, marker planning) so `server/test/` covers them without Premiere. `npm test` needs no Premiere, no ffmpeg, no API key.
- **The panel never decides; the server never draws.** State flows server to panel; user intent flows panel to server as RPCs.
- **Trust nothing stale.** Clip ids renumber, stored frames drift, "applied N/N" counts calls. Reconcile from source ranges and verify by re-reading the timeline.
- **Version-sensitive host APIs get try-ladders** and a Phase-0 probe (`ppro_run_script`) before first live use.
- **Lessons are recorded** in `CLAUDE.md` ("Lessons learned"): every dead end found the hard way is written down so no one re-discovers it.
