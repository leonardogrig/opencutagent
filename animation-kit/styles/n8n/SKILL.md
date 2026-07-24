# n8n style — design guide and living learnings

The aesthetic for this animation: **n8n sketching an idea on a dark whiteboard.** The same
hand-drawn engine as the Excalidraw style (rough.js draw-on, Excalifont, dot-grid canvas), but
everything is normalized to **n8n's brand**: near-black `#131313` canvas, **n8n pink `#EA4B71`**
as the one accent, sketchy square workflow nodes with connectors and traveling data pulses.
Motion is draw-on, rise, pop, and camera moves across a shared board. Never fades-as-transitions,
never clean HTML, never a pixel-clone of the real n8n UI.

## Style components (this style ships its own, USE THEM)
Import from the style package (path is relative to your job folder):

```tsx
import { n8n, SketchNode, SketchConnector, ChatScene, chatTiming, N8nLogo } from "../../../styles/n8n/src";
```

- **`n8n`** — the theme. Use `n8n.color.*` INSTEAD of `tokens.color.*` for every color in this
  style (it inherits fonts/sizes/stroke tiers from the engine tokens, so `n8n.fontSize.h2` etc.
  also work). Key colors: `accent` (pink `#EA4B71`), `activeGreen` (executed), the support set
  (`blue/orange/purple/purpleSoft/green/red`), `surface` for cards, `bg` for the canvas
  (pass `bg={n8n.color.bg}` to `<Canvas>` on solid jobs).
- **`SketchNode`** — THE n8n node: sketchy tile, centered brand-colored dot (or `hollow` ring),
  name BELOW the tile, handles gated to appear with the body, optional `trigger` bolt.
  `activeDelay` turns on the "executed" green sketch border (no checkmark, that's n8n's real
  semantic). Props: `id x y title subtitle? accent? hollow? trigger? w? h? drawIn? activeDelay?`.
- **`SketchConnector`** — hand-drawn bezier between node handles: draws neutral, loops a pink
  data-pulse (keeps holds alive), turns green at `activeDelay`. Props:
  `id from to delay duration? activeDelay? pulse? label?`.
- **`ChatScene`** — the n8n AI-builder chat opener (input box skeletons on, prompt types fast,
  "Building your workflow…" row). `chatTiming(prompt)` gives you its beat frames so downstream
  choreography can sync. Authored at 1920x1080 and self-scales to the composition width.
- **`N8nLogo`** — the official logo. **Do NOT use it unless the user explicitly asks for the
  logo**; the default is no logo/watermark anywhere.

A minimal workflow build (node/edge tables + staggered delays + execute wave):

```tsx
const NODES = [
  { id: "trigger", x: 380, y: 520, title: "Telegram", subtitle: "Trigger", accent: n8n.color.blue, trigger: true, drawIn: { delay: 0, duration: 21 }, activeDelay: 80 },
  { id: "ai", x: 770, y: 520, w: 260, title: "AI Agent", accent: n8n.color.purpleSoft, hollow: true, drawIn: { delay: 18, duration: 21 }, activeDelay: 105 },
  { id: "send", x: 1150, y: 520, title: "Send reply", accent: n8n.color.blue, drawIn: { delay: 36, duration: 21 }, activeDelay: 130 },
];
// connectors go from [x + w/2, y] of one node to [x - w/2, y] of the next
```

## Non-negotiables
1. **Hand-drawn, always.** Everything from the sketch primitives + the style components, with
   skeletons on: outline first, then body. If the user shows a screenshot of the real n8n app
   (or any app), redraw the CONCEPT sketchy and simplified — structurally recognizable, never a
   clone, no real integration logos (brand-colored dots instead).
2. **Normalize colors to the n8n brand.** Subject/highlight = pink `n8n.color.accent`; neutrals =
   the ink grays; extra color-coding = the support palette (blue/orange/purple/green/red). Never
   copy arbitrary colors from a source image.
3. **The n8n node look.** Nodes are SQUARE tiles; the AI Agent is the only rectangular (wider)
   one. Dot centered, name BELOW. "Executed" = green sketch border only, NO checkmark. Data
   pulses travel connectors; connectors may turn green once traversed.
4. **Ruthlessly minimal.** One main element per moment. A workflow = 5 to 7 representative
   nodes, not all 20. A chat = the input box + a short greeting. Less text is always better.
5. **Sync to the narration.** The brief gives word-level timings; anchor each visual beat to the
   words it illustrates with real frames (`SEC()`). Duration is fixed: never pad or trim.
6. **Keep holds alive.** Loop the connector data pulses, breathe bars, ping the accent element.
   A composed tableau must never sit dead.

## Look and feel defaults
- Canvas: `n8n.color.bg` (`#131313`) + fine dot-grid via `<Canvas bg={n8n.color.bg}>`;
  transparent jobs use `<Canvas transparent>` and skip the grid.
- Ink `#cdcdcd` for structure, `inkWhite` for the key line, `inkMuted/inkFaint` for secondary.
- Pink for the subject, highlights, and interactions: re-ink an already-drawn shape by overlaying
  the SAME geometry and seed in `n8n.color.accent` with a slow progress ramp.
- Text in Excalifont via `SketchText`; sizes from `n8n.fontSize`; keep inside the safe margin.
- Entrances: skeleton draw-on for shapes, rise/pop for text, staggered a few frames apart in a
  believable authoring order. Section transitions = a camera move across ONE shared board
  (scenes take `bg={false}` and sit on one dot-grid), never a fade or slide.
- Chat openers type FAST (~110 cps) and hand off quickly: the opener is setup, not the show.
- Comparisons: contrast ONE visual property side by side (e.g. opaque single box vs transparent
  many-node graph); a one-line caption per side is enough. Quantities: tiny hand-drawn bar
  charts, not floating numbers.
- Gradients (`n8n.gradient.*`) are rare hero accents only, never body content.

## Learnings log (append here; newest wins)
When the user corrects a general pattern (not a one-off tweak for this job), append a terse
entry: the rule, why, how to apply. Future animations read this log, so a lesson written once is
never re-learned.

(none yet)
