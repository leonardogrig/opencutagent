# Contributing to OpenCutAgent

Thanks for helping! This page covers the repo layout, how to run and test each part, and the conventions that keep the project healthy.

## Repo layout

```
opencutagent/
├── server/                  Node MCP server + WebSocket bridge (the brain)
│   ├── index.js             entry point: MCP stdio server + bridge startup
│   ├── bridge.js            WebSocket bridge the CEP panel connects to (port 3001)
│   ├── rpc/index.js         RPCs the panel calls (load/apply/AI/cache/…)
│   ├── tools/               one file per MCP tool (ppro_*)
│   ├── review.js            retake segmentation, reconcile, markers, transcript export
│   ├── silences.js          silence cut-list building + batched apply
│   ├── rebuild.js           fast apply: generated FCP7 XML sequence rebuild
│   ├── roundtrip.js         fast apply: round-trip of Premiere's own XML export
│   ├── ai.js                headless `claude -p` calls for the panel's AI buttons
│   ├── audio/               ffmpeg loudness envelope + silence detection
│   ├── transcription/       ElevenLabs Scribe client, caching, word/segment math
│   ├── undo.js              apply-undo snapshot bookkeeping
│   └── test/                unit + feature + smoke tests (no Premiere needed)
├── cep-panel/               Adobe CEP extension (the face)
│   ├── CSXS/manifest.xml    extension manifest (CEP 11/12)
│   ├── client/              panel UI: index.html, main.js, styles.css, preview.html
│   └── host/premiere.jsx    ALL ExtendScript; the only file that touches Premiere APIs
├── .claude/skills/          skills that teach Claude the editing workflows
├── docs/ARCHITECTURE.md     how the pieces talk + why the big design decisions
└── CLAUDE.md                working notes + hard-won lessons (read before touching MCP flows)
```

## Setup

```bash
git clone <repo> opencutagent
cd opencutagent/server && npm install
```

See the README for the full install (CEP developer mode, panel symlink, `.mcp.json`).

## Running the pieces

- **Server only (no Premiere):** `cd server && npm run smoke` boots the MCP server over stdio and lists the tools.
- **Panel UI outside Premiere:** `python3 -m http.server --directory cep-panel/client` then open `index.html` (renders with "Not in Premiere" status; layout and interactions work) or `preview.html` (component gallery showing every widget/state).
- **Panel UI debug handle:** in a browser, `window.__editagent` exposes `Retake`, `Silence`, and `AI`. For example `__editagent.Retake.applyReviewUpdate([...])` injects fake segments to exercise list rendering with no server or Premiere.
- **Full stack:** open the panel in Premiere (it auto-starts the server), or run a Claude Code session in the repo so its MCP server owns port 3001.

## Tests

```bash
cd server
npm test        # unit + feature + smoke tests, no Premiere or API key needed
npm run check   # syntax-checks every .js file in server/
```

From the repo root, `npm test` / `npm run check` forward to the same scripts.

`npm run eval:retakes` (root) scores the headless retake analysis against a human-labeled 412-segment fixture. It makes real `claude -p` calls, so it needs a logged-in `claude` CLI and takes several minutes.

**Every pure function belongs in a test.** The project's edit math (interval merging, frame conversion, XML surgery, cut-list building) is deliberately kept in pure functions precisely so it can be tested without Premiere. If you add logic, add a test in `server/test/`.

## Reloading after changes (nothing hot-reloads)

| You changed | Reload by |
|---|---|
| `server/*` | restart the Claude Code session (or the standalone server process) |
| `cep-panel/host/premiere.jsx` | reopen the panel, or hot-patch the live engine with `$.evalFile("<repo>/cep-panel/host/premiere.jsx")` via `ppro_run_script` |
| `cep-panel/client/*` | reopen the panel |

## Platform gotchas (these have bitten before)

- **`premiere.jsx` is ExtendScript (ES3).** No `let`/`const`, arrow functions, `Array.prototype.map`, or built-in `JSON` guarantees. Keep everything ES3 and route all Premiere API access through this one file.
- **CEP's Chromium is old.** No `:has()` selector (silently renders nothing in Premiere while working in your desktop browser). Drive state styling with JS-set classes. Browser QA cannot catch engine gaps, so verify CSS in the real panel.
- **Canvas colors are hex literals** in `main.js` draw functions (canvas can't read CSS variables). Keep them in sync with `cep-panel/DESIGN.md`.
- **evalScript is a single engine.** Host operations are serialized; long ones block the playhead poll. The `hostOpsInFlight` counter in `main.js` gates polling for this reason.
- **Version-sensitive Premiere APIs** (`seq.insertClip`, marker color forms, XML export signatures) are wrapped in try-ladders in `premiere.jsx`. Probe with `ppro_run_script` before trusting a new API form.

## UI conventions

- The design system lives in `cep-panel/client/styles.css` (token variables) and is specced in `cep-panel/DESIGN.md`. One accent color: Ember `#EC6A41`.
- QA visual changes against `cep-panel/client/preview.html` (the component gallery) and keep it in sync with new components.
- No em dashes in user-visible copy (UI strings, server messages shown in the panel).

## Recording lessons

When you hit a new failure mode and find the fix, append a terse "symptom, cause, fix" entry to the **Lessons learned** section of `CLAUDE.md`. Future contributors (and Claude sessions) read it first; a lesson written once is never re-learned the hard way.

## Pull requests

- Keep `npm test` and `npm run check` green.
- Behavior-affecting changes to the apply paths (razor, XML rebuild, round-trip) need a test that pins the new behavior.
- Note in the PR whether the change was verified in live Premiere or only via tests/browser QA; timeline-touching changes should be verified live before release.
