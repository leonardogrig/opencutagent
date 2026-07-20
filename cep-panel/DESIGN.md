# OpenCutAgent — Design System

> "Claude in the cutting room": a warm, focused, professional dark theme for the
> Premiere Pro panel, anchored by the **Ember** coral. Single source of truth is
> [`client/styles.css`](client/styles.css); this file documents the decisions.
> Verify visually with [`client/preview.html`](client/preview.html) (a component
> gallery — open it in a browser; serve the dir with `python3 -m http.server`).

## Identity

- **Ember `#EC6A41`** is the single primary/accent — primary buttons, active tab,
  focus rings, selection, the threshold line, "Claude is working" moments.
- It's a distinct, more-saturated coral (its own color — *not* Anthropic's
  `#D97757`), in the warm "AI" lane that sets OpenCutAgent apart from the blue/teal
  of other editors while feeling native to Premiere's dark UI.
- Before: blue `#5a8cff` **and** orange `#e8693a` competed as two primaries, with
  ~30 hardcoded one-off colors. Now: one primary; every other hue is semantic.

## Tokens (see `:root` in styles.css)

| Group | Tokens |
|---|---|
| Surfaces (elevate by lightness) | `--surface-0` #1A1715 → `--surface-4` #3E3935 |
| Text | `--text-primary` #F3EEE8 · secondary #B4ADA3 · tertiary #837C71 · disabled #5B554D · on-accent #20140E |
| Borders (translucent white) | `--border-subtle/-default/-strong` |
| Accent (Ember) | `--accent` #EC6A41 · hover #F47E58 · press #D2592F · `-bg` / `-border` / `-text` / `--focus` |
| Semantic | `--success` #4FB477 · `--danger` #E14B4B · `--warning` #E0A23A (+ `-bg`/`-text`) |
| Legacy aliases (used by main.js inline) | `--bad`→danger, `--ok`→success, `--wait`→warning |
| Viz | `--viz-bg` #141110 (canvas colors mirrored as literals in main.js draw()) |
| Spacing | `--sp-1..6` = 4/8/12/16/24/32 |
| Radius | `--r-sm` 4 · `--r-md` 8 · `--r-lg` 12 · `--r-pill` 999 |
| Type | `--fs-xs..lg` = 10/11/12/13/15; family `InterVariable` (bundled) + system fallback |
| Motion | `--dur-fast/`/`--dur`/`--dur-slow` = 120/180/240ms; `--ease` cubic-bezier(.2,0,0,1) |

**Contrast:** dark text on Ember (`--text-on-accent`) is ~5.7:1 → passes AA, so
primary buttons keep crisp dark labels (white-on-Ember is only ~3.1:1).

## Components

- **Buttons** — one system: `.primary` (Ember, dark text) · default (secondary) ·
  `.ghost` (quiet) · `.danger` (outline red, used by Stop) · `.danger-text` (quiet
  destructive, used by Clear cache) · `.icon-btn` (header chip). `.sm` size. States:
  hover (lighter), active (scale .97), `:disabled:not(.loading)`, `:focus-visible`
  (Ember ring), and **`.loading`** (CSS spinner replaces the leading `.ic`).
- **Dynamic-label buttons** carry `<svg class="ic">` + `<span class="lbl">` so the
  label can change without wiping the icon. JS uses `setLoading()` / `setLabel()`.
- **Settings popover** (`.pop`, anchored under the header's gear `.icon-btn`;
  scrolls internally past viewport height) — replaced the old always-visible AI
  bar. Sections (`.pop-sec` + `.pop-title`): **Config** (Claude model/effort
  selects + Sync switch + mode hint), **Transcription** (ElevenLabs model select,
  persisted, sent as `transcribe_model` on Load), **Storage** (cache size via the
  `cacheInfo` RPC + a two-step-confirm Clear cache button → `clearCache` RPC),
  **ElevenLabs** (API-key status row `keyStatus` RPC, never the key itself, +
  Add/Change key button → key modal), **Usage** (opens the AI usage modal), and
  **Advanced** (`.adv-toggle` accordion, collapsed by default: every server
  tunable from the `envList` RPC as `.adv-var` rows — key, input with the default
  as placeholder, description; saves on blur/Enter via `setEnv`; topped by an
  "if unsure, don't change" `.adv-warn` hint). Click-away/Esc close it.
  Rationale: model choice atop a tab read as "this whole tab is AI" when only
  the two explicit AI actions use it.
- **ElevenLabs key modal** (`.modal.modal-sm`, ~400px) — opened from the
  popover, and AUTOMATICALLY whenever a transcription action needs a key that
  isn't set (pre-check via `keyStatus` on connect) or the server reports a
  missing/rejected key (`AI.handleKeyError`). Optional `.key-reason` warning
  banner explains why it appeared; `.key-input` (type=password) + inline
  `.key-error`; Save verifies against ElevenLabs then writes .env via the
  `setApiKey` RPC. Esc order: key modal → usage modal → popover.
- **AI usage modal** (`.modal-backdrop` > `.modal`, z-index 80, opened from the
  popover's "View AI usage log") — head (title +
  `.modal-close`), scrollable `.modal-body` with a `.usage-table` (sticky
  uppercase headers; `.when`/`.action`/`.num` cells, cost column `.paid` = warning
  text for real Scribe spend, `.free` = "included" for subscription Claude runs),
  foot with `.usage-totals` + hint. Data = `usageLog` RPC (`.cache/usage-log.json`,
  written by the server; survives Clear cache). Esc, ×, and backdrop click close;
  Esc prefers the modal over the popover.
- **Inputs** — unified surface-1 + border + Ember focus ring; custom `<select>`
  chevron (data-URI; needs `img-src data:` in the CSP); range slider with Ember
  thumb + filled track (`--fill` % set by JS); switch (`input.switch`), custom
  checkbox. **Gotcha:** the `.chk` checkbox selectors carry `:not(.switch)` — a
  switch inside a `.chk` label (both Follow toggles) otherwise inherits the square
  checkbox base + checkmark ::after (equal specificity, later source order) and
  renders as a blob. Keep the `:not()` if you touch these rules.
- **Segmented control** (`.segctl` > `.segopt` labels with hidden radios) — replaced
  the AutoCut-style radio lists for Silence Management and Transitions; the selected
  pill is solid Ember via a **JS-set `.on` class** (`syncSegCtl`). **Never style
  selection with `:has()` — CEP's Chromium predates it, so a `:has(input:checked)`
  style silently renders as nothing in live Premiere** (that shipped once; the user
  couldn't tell which option was chosen). A `.segctl-cap` line under the group
  describes the selection. **Transitions** additionally render `.trans-viz`:
  inline SVG track diagrams (`.tvz-*` classes; V/A rows, warm block = next clip)
  switched by hover (preview) or selection, + caption and a "v1 cuts clean" note.
- **Param diagram** (`.param-viz`) — one shared SVG under the four ms fields
  (speech blocks around a silence: green kept margins, red removed span, a short
  pop). Hover/focus on a `[data-param]` field sets `data-hl` on the box, which
  brightens that field's zones + annotation (`.pv-*`) and swaps the caption.
- **Tooltips** — controls that need a real explanation carry **`data-tip`** (not
  `title`): a shared fixed-position `.tipbox` (styled, wrapping, ~400ms delay,
  flips above when cramped) shows on hover. Native titles remain only on trivial
  controls (zoom, selects).
- **Copy rules** — no em dashes anywhere in UI text (user preference; use periods,
  colons or commas). Tooltips explain what the control does AND its consequence.
- **Tabs** — icon + label, sliding Ember underline on `.active`.
- **Badges** — semantic tokens: keep/cut/removed/short/protected(lock)/manual.
- **Feedback** — slim global indeterminate `#topbar` (driven by `setBusyBar`),
  typed toasts (`success`/`error`/`info`, colored bar + icon, via `toast(msg,type)`),
  skeleton shimmer rows during transcribe (`skeletonRows()`), richer empty states,
  pulsing connection dot.
- **Layout compaction** — Remove Silences has ONE toolbar row (`.sil-bar`:
  Scan/Rescan + truncating status + `.viewctl` Follow/zoom); the legend keeps
  swatches + a "drag to pan · scroll to zoom" hint. The threshold block is a
  `.thr-head` row (label + live value + `a.calc-ai`) over the slider. Retakes puts
  status + Follow on one `.statusrow`. Waveform canvas: click = seek, drag = pan,
  drag near the line = threshold, wheel = zoom, trackpad deltaX = pan.
- **Segment rows** — expanding a row adds `.seg.open`: the SAME `.seg-text`
  un-truncates (white-space normal); the detail pane holds only meta + actions,
  never a second copy of the text. Custom presets show a hover × (`[data-custom]`
  attr, not a class — `highlightActivePreset()` rewrites className). Runs (≥2) of
  consecutive "Removed" segments AND of auto-cut no-speech clips collapse into
  `.seg-group` accordions (`runGroupHtml`), closed by default. The ripple
  checkbox ("Remove gaps when applying") defaults to ON. A second `.chk`,
  **"Remove excess (keep speech only)"** (`#trimExcess`, default OFF), makes
  Apply All also trim the non-speech air inside kept segments (server
  `computeExcessRanges`); when checked the footer summary appends a live
  "~Xs excess" estimate and Apply enables even with zero cuts. Row times and
  the footer count only PENDING cuts (`isPendingCut` = cut, unprotected, still
  on the timeline); already-applied cuts show as "N removed" instead.

- **Animation tab** — third tab (`data-tab="anim"`), two stacked modes inside one
  pane swapped via `.hidden`: **picker** (`#animSelect`: existing animations as
  `.anim-job` rows — meta includes a relative age ("14 min ago") and a hover
  `.anim-job-x` delete with an inline two-step "Sure?" (`.confirm`) — plus a
  `.anim-segrow` segment list with `.anim-check` boxes; a selection must be one
  contiguous run, `.sel` = accent tint + inset accent bar). Inside a chat the
  Style select + bg toggle HIDE (fixed at creation) and the header gains a
  `.anim-folder` icon button that reveals the job's folder in Finder/Explorer.
  and **chat** (`.anim-chatwrap`: `.anim-jobinfo` header, `.anim-chat` scroll of
  `.anim-msg` bubbles — user right/accent-tinted, assistant left/surface-2,
  `.system` centered notices). The audience is a VIDEO EDITOR: tool calls and
  intermediate agent narration are NEVER rendered — they collapse into ONE
  self-replacing **activity bubble** pinned last in the log
  (`.anim-msg.assistant.activity`: dashed bubble + `.anim-activity-dot` pulse)
  with friendly verbs ("Reading the brief…", "Sketching the animation…",
  "Rendering v2: 47%") that replace in place and never stack; real messages
  insert above it and it disappears when the turn ends. Only the turn's FINAL
  reply becomes a normal bubble. `.anim-msg.system.placed` ("Animation v1
  placed on V2 at 10:50. Click to view.", success-green, underline on hover)
  and the job-header `.badge.seekable` carry `data-seek` → clicking moves
  Premiere's playhead to the animation's start. Composer `.anim-inputbox`:
  attach pills (`.anim-pill` + ×), textarea (Enter sends, Shift+Enter newline),
  single-primary Send that swaps to a danger Stop while the agent works. Top `.anim-bar`: Style select + a
  `.segctl-sm` Solid bg / No bg control (both freeze once a job is open — they
  are fixed at creation). Drag-drop images onto the chat = `.dragging` dashed
  outline. Selected `.segctl` pills are a JS-set `.on` class (no `:has()`).

## Constraints / gotchas

- **Client-first.** All UI lives in `cep-panel/client/` (styles.css, index.html,
  main.js, fonts/, preview.html). The only server surface the UI added later:
  `cacheInfo` / `clearCache` RPCs (`server/rpc/index.js`) for the Storage section —
  they touch ONLY `.cache/{transcripts,levels,rebuild}` (never decisions files).
- **CSP** (index.html `<meta>`) must keep `font-src 'self'` (bundled Inter) and
  `img-src 'self' data:` (select chevron). `style-src` already allows the linked sheet.
- **Canvas colors** can't read CSS vars cheaply, so `main.js` `draw()`/`drawOverview()`
  hold the viz palette as hex literals — keep them in sync with the tokens here.
- **Soft Apply markers** (Retakes): Premiere can't recolor timeline clips, so "Soft Apply"
  drops colored **sequence markers** instead. Their colors are Premiere's **fixed** marker
  indices, NOT our tokens: `0 Green`=keeper · `1 Red`=no-speech · group hues cycle
  `2 Purple, 3 Orange, 4 Yellow, 6 Blue, 5 White` (`MARKER_COLORS` in `server/review.js`).
  The button is a **secondary** (left of the single-primary **Apply All**); a `.ghost`
  **Clear markers** lives in the footer's `.row2`.
- **No `window.prompt` in CEP** (returns null instantly). Saving a custom preset
  uses an inline pill input (`.presets input.preset-name`) that temporarily
  replaces the "+" button: Enter saves, Escape cancels, blur saves a non-empty
  name. Same class of engine gap as `:has()` — verify dialogs/selectors in the
  real panel, not just a desktop browser.
- **Reduced motion** is honored (`prefers-reduced-motion`).
- Reload after edits: styles/markup → reopen panel; main.js → reopen panel.
