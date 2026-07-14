# Excalidraw style — design guide and living learnings

The aesthetic for this animation: **someone sketching an idea on a dark whiteboard.** Hand-drawn
sketchy shapes that draw themselves on, Excalifont handwriting, a violet accent, everything on a
near-black dot-grid canvas (or floating over the footage in transparent jobs). Motion is draw-on,
rise, pop, and camera moves across a shared board. Never fades-as-transitions, never clean HTML,
never a pixel-clone of a real UI.

## Non-negotiables
1. **Hand-drawn, always.** Everything is built from the sketch primitives (rough.js + Excalifont)
   with skeletons on: outline first, then body. If the user shows a screenshot of a real app,
   redraw the CONCEPT sketchy and simplified, structurally recognizable but never cloned.
2. **Normalize colors to the tokens.** Subject/highlight = `tokens.color.accent` (violet
   `#a8a5ff`); neutrals = the ink grays; extra color-coding = the support hues (red/orange/
   yellow/green/blue/purple). Never copy arbitrary colors from a source image.
3. **Ruthlessly minimal.** One main element per moment. Strip noise: no toolbars, chips, or
   every-button. A few strong beats beat many rushed ones. Less text is always better.
4. **Sync to the narration.** The brief gives word-level timings for the selected range. Anchor
   each visual beat to the words it illustrates using real frames (`SEC()`), so the animation
   lands on the voiceover. Do not pad or trim the total: duration is fixed.
5. **Keep holds alive.** While a composed tableau holds, keep something subtly moving: a data
   pulse traveling a connector, bars breathing, a gentle radar ping on the accent element.

## Look and feel defaults
- Canvas: `#121212` + fine dot-grid (gap ~30, r ~1.1) via `<Canvas>`; transparent jobs use
  `<Canvas transparent>` and skip the grid.
- Ink `#cdcdcd` for structure, `inkWhite` for the key line, `inkMuted/inkFaint` for secondary.
- Accent violet for the subject, what is highlighted, and interactions (re-ink an already-drawn
  shape by overlaying the SAME geometry and seed in accent with a slow progress ramp).
- Text in Excalifont via `SketchText`; sizes from `tokens.fontSize`; keep content inside the
  safe margin (`tokens.safeMarginPct`).
- Entrances: skeleton draw-on for shapes, rise/pop for text and small elements, staggered a few
  frames apart in a believable authoring order.
- Comparisons: contrast ONE visual property side by side and let shapes carry the message; a one
  line caption per side is enough.
- Quantities: tiny hand-drawn bar charts or relative sizes, not floating numbers.

## Learnings log (append here; newest wins)
When the user corrects a general pattern (not a one-off tweak for this job), append a terse
entry: the rule, why, how to apply. Future animations read this log, so a lesson written once is
never re-learned.

(none yet)
