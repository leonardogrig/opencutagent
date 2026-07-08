# OpenCutAgent

Edit video on the **live Adobe Premiere Pro timeline** with Claude.

OpenCutAgent is a Premiere Pro panel + local Node server that cuts your footage the way an editor does: transcribe what is said, find the dead air, the filler, the false starts and the duplicate takes, and remove them from your real sequence, undoably. The AI judgment is **Claude itself** on your Claude subscription. There is no external LLM API and no per-token AI bill.

Two ways to drive it:

- **Panel only (default):** open the panel in Premiere and click. "Analyze w/ Claude" and "Suggest threshold" run the `claude` CLI headlessly in the background; you never type a prompt.
- **Chat (Sync mode):** talk to Claude Code ("remove the silences", "cut the duplicate takes") and watch the marks land live in the panel via MCP tools.

Two tabs, two price tags:

- **Remove Silences** is **completely free**: it measures loudness locally with ffmpeg. No API key, no network, no cost.
- **Retakes** needs a **paid transcription**: the timeline is transcribed once (cached forever) and Claude then judges the takes. We recommend **ElevenLabs Scribe v2** (~$0.22/hour of audio, and only the source ranges actually on your timeline are billed).

## Features

- **Remove Silences** tab (free): loudness-based dead-air removal (ffmpeg only, no transcription, no API key). Waveform with draggable threshold, live-recomputing silence zones, pacing presets, margins, and an AI threshold suggestion.
- **Retakes** tab (paid transcription): transcript-based cleanup. Loads the timeline as indexed spoken segments; Claude marks duplicate takes, false starts and filler as Cut; you review, override, protect, then apply.
- **Soft Apply:** instead of deleting, lays colored markers on the timeline (one hue per retake group, green over the suggested keeper) so you can pick final takes by hand.
- **Fast apply:** big cut lists skip in-place razoring and rebuild the tightened sequence via Premiere's own XML round-trip, so a 2-hour timeline with 2000+ cuts applies in seconds, with effects and transforms preserved.
- **Export transcript:** saves the kept speech as a YouTube-ready `.srt`, with caption times matching the tightened video.
- **Live sync:** the panel follows Premiere's playhead, highlights the segment under it, and clicking a segment seeks the timeline.

## How it works

```
Claude Code ──stdio──► MCP server (Node) ──ws 127.0.0.1──► CEP panel (in Premiere) ──evalScript──► Premiere
             ppro_*     runs ffmpeg + Scribe                auto-reconnects                premiere.jsx
             tools      + headless `claude -p`
```

- The **MCP server** (`server/`) hosts a localhost WebSocket bridge for the panel, exposes the timeline as MCP tools, runs ffmpeg + ElevenLabs Scribe, computes every cut list, and spawns the headless `claude` calls for the panel's AI buttons.
- The **CEP panel** (`cep-panel/`) runs inside Premiere and executes timeline operations via `cep-panel/host/premiere.jsx` (the only file that touches Premiere's API).
- The **skills** (`.claude/skills/`) teach Claude the cut and silence-removal workflows; the same text drives the headless calls.

Premiere's own transcript isn't readable via any API, so transcription runs on the **source media** (transcribe once, cache, map onto the timeline; a re-edit or reload never re-bills).

For the full picture (reconcile, fast-apply ladder, chunked AI analysis), see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Prerequisites

- **Adobe Premiere Pro 2024–2026** (uses CEP, which still loads on current 26.x). macOS or Windows.
- **Node.js ≥ 18** (`node -v`).
- **ffmpeg** on your PATH (`ffmpeg -version`):
  - macOS: `brew install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg` (or `choco install ffmpeg`)
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** installed and signed in (`claude` on your PATH). Needed for the AI features (headless buttons and Sync mode); scanning, manual thresholds and manual keep/cut work without it.
- **ElevenLabs API key**: **optional**, only for the transcription features (the Retakes tab, `identify_segments`, transcript-based `remove_silences`). Transcription is the one paid piece; we recommend **Scribe v2** (the default model, selectable in the panel settings). The key must have the **speech_to_text** scope. The Remove Silences tab needs **no key and costs nothing**. Get a key at https://elevenlabs.io.

### Too much? Let Claude install everything

If you already have **Claude Code**, you can skip the entire Install section below. Open a terminal in the folder where you want OpenCutAgent to live, run `claude`, and paste this prompt. Claude will clone the repo, install the prerequisites it can, wire up the panel and the MCP config, and verify the result:

> Install OpenCutAgent on this machine so it is fully ready to use, doing every step yourself and verifying as you go. Steps:
>
> 1. Clone https://github.com/leonardogrig/opencutagent.git into the current directory (skip if already cloned here) and run `npm install` inside its `server/` folder.
> 2. Check prerequisites: Node.js >= 18 and ffmpeg on PATH. If ffmpeg is missing, install it (macOS: `brew install ffmpeg`; Windows: `winget install Gyan.FFmpeg`). If Node is missing or too old, tell me how to install it and stop.
> 3. Enable Adobe CEP developer mode for CSXS.11 and CSXS.12 (macOS: `defaults write com.adobe.CSXS.<n> PlayerDebugMode 1`; Windows: the HKCU `Software\Adobe\CSXS.<n>` `PlayerDebugMode=1` registry values).
> 4. Install the panel: symlink (macOS) or junction/copy (Windows) the repo's `cep-panel` folder to the user CEP extensions folder as `com.opencutagent.panel` (macOS: `~/Library/Application Support/Adobe/CEP/extensions/`; Windows: `%APPDATA%\Adobe\CEP\extensions\`). Replace any stale link at that name.
> 5. Create `.env` from `.env.example` if it doesn't exist. Don't put any API key in it; I can add my ElevenLabs key later from the panel's gear menu.
> 6. Create `.mcp.json` from `.mcp.json.example`, setting the server path to the ABSOLUTE path of this clone's `server/index.js` (forward slashes on Windows; no `${VAR}` expansion).
> 7. Verify: run `npm run check` and `npm test` in `server/`, and confirm the extensions link resolves to the repo's `cep-panel`.
> 8. Finish with a short report of what was installed, anything you could not do, and my two next steps: restart Premiere and open Window > Extensions > OpenCutAgent (the panel auto-starts the server), and optionally add an ElevenLabs key in the panel settings to enable the Retakes tab.
>
> Ask before anything destructive; everything else, just do.

When it finishes, restart Premiere and open **Window ▸ Extensions ▸ OpenCutAgent**. Done — the manual steps below are the same thing, spelled out.

## Install

Replace `/path/to/opencutagent` (or `C:\path\to\opencutagent`) with wherever you cloned the repo.

### 1. Clone + install server dependencies

```bash
git clone https://github.com/leonardogrig/opencutagent.git
cd opencutagent/server
npm install
```

### 2. API key (optional)

```bash
cd ..                  # back to the opencutagent root
cp .env.example .env   # Windows: copy .env.example .env
```

Edit `.env` and set `ELEVENLABS_API_KEY=...` **only if** you want the transcription features. `.env` also holds optional knobs (port, cache dir, AI model/effort defaults, fast-apply thresholds), all documented inline.

### 3. Enable CEP developer mode + install the panel

Premiere only loads **unsigned** dev panels with developer mode on (CEP 11 = Premiere 2024, CEP 12 = 2025/2026).

**macOS**

```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1

# link the panel into Premiere's extensions folder
mkdir -p ~/Library/Application\ Support/Adobe/CEP/extensions
ln -s /path/to/opencutagent/cep-panel \
      ~/Library/Application\ Support/Adobe/CEP/extensions/com.opencutagent.panel
```

**Windows** (PowerShell)

```powershell
reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f

# junction the panel folder (run PowerShell as Administrator)
New-Item -ItemType Junction `
  -Path "$env:APPDATA\Adobe\CEP\extensions\com.opencutagent.panel" `
  -Target "C:\path\to\opencutagent\cep-panel"
```

No admin rights? Just **copy** `cep-panel` to `%APPDATA%\Adobe\CEP\extensions\com.opencutagent.panel` instead of the junction (but re-copy after any panel update).

Restart Premiere, then open the panel: **Window ▸ Extensions ▸ OpenCutAgent**. That's enough for panel-only use: the panel **auto-starts the server** when you open it.

### 4. Point Claude Code at the server (for Sync / chat use)

Copy the example MCP config and set the path to your clone:

```bash
cp .mcp.json.example .mcp.json
```

```json
{
  "mcpServers": {
    "premiere": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/opencutagent/server/index.js"],
      "timeout": 600000
    }
  }
}
```

> Use an **absolute** path; Claude Code does not expand `${VAR}`s in `.mcp.json`. On Windows use a forward-slashed absolute path, e.g. `C:/path/to/opencutagent/server/index.js`.

Then launch Claude Code **from the project folder** so it loads `.mcp.json` and the bundled skills, and approve the server when prompted:

```bash
cd /path/to/opencutagent
claude
```

*(Alternative: register globally with `claude mcp add premiere --scope user -- node /path/to/opencutagent/server/index.js`, and symlink the skills into `~/.claude/skills/` so they load from any folder.)*

### Who starts the server (one server, three launchers)

The panel is only a WebSocket client; everything runs through one local server (`server/index.js`, port 3001). It can start three collision-safe ways:

1. **Opening the panel auto-starts it** (the panel spawns it only after a failed connect, so it never fights an existing one). This is all you need for panel-only use.
2. **Claude Code spawns it** via `.mcp.json` when a session is open in the project. For Sync mode, start the `claude` session **first** so its server owns the port; the panel then connects to it.
3. **Manually:** `npm start` from the repo root (stop with `npm stop`), or double-click `start-opencutagent.command` on macOS.

To smoke-test the server by itself (no Premiere needed):

```bash
cd /path/to/opencutagent/server
npm run smoke   # boots the server, lists the tools over stdio
```

After changing server code, restart the Claude session (or `/mcp` → reconnect `premiere`); there is no hot-reload.

## Use it: Remove Silences (loudness-based, no key)

1. Open a project + sequence, open the panel, click **Scan Audio**. The server measures each clip's loudness (ffmpeg, cached per source) and the panel draws the waveform with silences highlighted and a draggable **Noise Threshold** line.
2. **Tune live**: drag the threshold, edit the ms fields (min silence length, keep-talk, margins), or pick a pacing preset. The zones recompute instantly. The meter is normalized to the recording's own peak, so threshold values behave like AutoCut/TimeBolt's.
3. **Suggest threshold** (optional): Claude reads the measured loudness stats and picks a threshold that fits the recording (headless by default; via your chat in Sync mode).
4. Pick the **Silence Management** mode: *Remove* (ripple, close gaps), *Keep gaps* (lift), *Mute*, or *Keep*.
5. **Remove Silences**. Undo restores the timeline.

## Use it: Retakes (transcript-based)

1. **Load segments**: transcribes the timeline (ElevenLabs Scribe, cached; only the source ranges actually used on the timeline are billed) and lists indexed spoken segments, each starting as Keep. Clips with no speech are auto-marked Cut.
2. **Analyze w/ Claude**: Claude reads the transcript and marks duplicate takes, false starts and filler as Cut (keeping the most complete pass of each beat). Long timelines are analyzed in overlapping chunks for reliability.
3. **Review**: click a segment to expand; flip **Keep ⇄ Cut**, or **Protect** it so nothing ever cuts it. Overrides show a *Manual* badge. The list follows the playhead; clicking a segment's time seeks Premiere.
4. Optional extras before applying:
   - **Soft Apply** lays colored markers instead of deleting (green = suggested keeper); **Clear markers** removes only OpenCutAgent's markers.
   - **Remove excess (keep speech only)** also trims the dead air inside kept segments.
   - **Export transcript** saves the kept speech as an `.srt`.
5. **Apply All**. "Remove gaps when applying" picks ripple vs lift. Large ripple applies (100+ cuts) build a **new sequence named `<sequence> - tightened`** via XML round-trip (fast, effects preserved); the original sequence is untouched, so "undo" there is just deleting the new one. Smaller applies edit in place and support **Undo last apply** / Cmd+Z.

Or just ask in chat (Sync mode): *"analyze the retakes on my timeline and cut the duplicates"*, *"remove the silences"*, *"what's on the timeline?"*, *"trim V1.2 so it ends at 00:00:18:00"*. The `premiere-edit` skill runs a read → propose → confirm → execute → verify loop and previews destructive cuts before applying.

## The AI: Claude, two transports

The "Sync with Claude Code" toggle (in the panel's ✦ settings popover) picks who runs the analysis:

- **OFF (default, headless):** the AI buttons spawn `claude -p` in the background on your Claude subscription (keychain login; a stray `ANTHROPIC_API_KEY` is scrubbed so nothing silently bills). Model + effort come from the settings popover.
- **ON (Sync):** the buttons defer to your open Claude Code chat, where Claude drives the `ppro_*` MCP tools and pushes results into the panel live.

Both modes share the same server state and render identically. The headless call is a pure judgment oracle: it gets segment data and returns JSON decisions; it cannot touch Premiere, your files, or the network.

## MCP tools

| Tool | What it does |
|---|---|
| `ppro_get_timeline_state` | Read the sequence: clips (ids like `V1.2`), source paths, timecodes, gaps, `revision`. |
| `ppro_identify_segments` | Transcribe a clip's source (Scribe, cached) → phrases / silences / fillers at timeline timecodes. |
| `ppro_trim_clip` | Set absolute new edges for one clip (idempotent). |
| `ppro_remove_gaps` | Ripple-close empty gaps. |
| `ppro_remove_silences` | Transcribe → cut list (silences + fillers) → ripple-delete. Use `dry_run: true` first. |
| `ppro_analyze_audio_levels` | Measure timeline loudness (ffmpeg, no transcription) → noise-floor/speech stats + suggested threshold. |
| `ppro_remove_silences_by_level` | Loudness-based silence removal from chat: threshold → cut list → ripple/lift/mute. `dry_run` first. |
| `ppro_get_retake_segments` | Transcribe into indexed segments for Claude to analyze for retakes/duplicates. |
| `ppro_mark_retakes` | Record keep/cut decisions; pushes them live to the panel. |
| `ppro_apply_retakes` | Apply the current marks (ripple/lift-delete the Cut segments). |
| `ppro_run_script` | Escape hatch: run arbitrary ExtendScript. |

## Verify the install

```bash
cd /path/to/opencutagent/server
npm run check     # syntax-check every module
npm test          # unit + feature + smoke tests (no Premiere or API key needed)
npm run smoke     # start the server + list tools over stdio
```

Then open the panel (it should show **Connected**) and click **Scan Audio**, or ask Claude Code "what's on the timeline?".

## Troubleshooting

- **Panel says "Waiting for server…".** Nothing is listening on the port. Reopen the panel (it auto-starts the server), run `node server/index.js` yourself, or open a `claude` session in the project. If auto-start says "Node not found", install Node or start the server manually once.
- **Panel not in the Extensions menu.** macOS: re-check the `defaults write … PlayerDebugMode 1` commands and that the symlink points at `cep-panel/`. Windows: re-check the `CSXS.11`/`CSXS.12` registry keys and the junction/copy at `%APPDATA%\Adobe\CEP\extensions\com.opencutagent.panel`. Restart Premiere.
- **"Unknown RPC method …" after updating the code.** A server running the old code still owns the port (commonly from a second Claude Code window in the project). Keep one window, then `/mcp` → reconnect `premiere` (or restart the session). If a stray server lingers: find it with `lsof -nP -iTCP:3001 -sTCP:LISTEN` (Windows: `netstat -ano | findstr :3001`) and kill that PID.
- **"EvalScript error."** `premiere.jsx` didn't load; close and reopen the OpenCutAgent panel.
- **Port 3001 busy.** Set `PREMIERE_BRIDGE_PORT` in `.env`; the panel auto-reads the negotiated port from `~/.editagent/bridge-port`.
- **Transcription fails / Retakes tab errors.** Confirm `ELEVENLABS_API_KEY` is set, has the **speech_to_text** scope, and `ffmpeg -version` works. (The Remove Silences tab needs neither a key nor network.)
- **A "Translation Report" alert during a big apply.** Benign: Premiere logs source-interpretation entries it re-derives on import. The report file lands in `.cache/rebuild/` if you want to read it.

## Good to know

OpenCutAgent is built for the common case: talking-head footage on a normal A/V timeline. Two automatic behaviors worth knowing about:

- **Big applies build a new sequence.** Large ripple applies rebuild the tightened cut via Premiere's own XML round-trip (seconds instead of minutes, with your effects and transforms preserved); the original sequence is left untouched as a backup.
- **The fast path steps aside when it must.** Timelines with titles/graphics or speed-changed clips are applied by the (slower) in-place razor path instead. Everything still applies either way.

The transcription engine is pluggable (Scribe v2 today); the engine interface in `server/transcription/transcribe.js` accepts a Deepgram/Whisper drop-in.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces talk, the fast-apply ladder, the design rules.
- [CONTRIBUTING.md](CONTRIBUTING.md): dev setup, tests, reload matrix, platform gotchas.
- [cep-panel/DESIGN.md](cep-panel/DESIGN.md): the panel's design system.

## License

[MIT with Commons Clause](LICENSE). In short: free to use, modify, and share for yourself or your team, but you may not sell OpenCutAgent or offer it (or a product/service substantially built on it) commercially. That right is reserved by the author.
