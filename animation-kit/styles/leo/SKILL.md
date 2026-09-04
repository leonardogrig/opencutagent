<!-- guide-version: 2 -->
# Leo (pixel presenter) style: design guide and living learnings

The aesthetic: **a 16-bit pixel-art Leo (the creator) talks along with the narration.** He is
on screen most of the time, usually in a corner over the footage like a stream cam, mouth moving
in sync with the words the viewer hears, blinking, bobbing, glancing at what he is talking about.
Occasionally he presents in a full pixel scene next to a short caption or a simple diagram.
Crisp pixels, a dark palette, one Ember accent. NOT hand-drawn: no rough.js, no Excalifont, no
sketch primitives.

## The one rule that matters: the mouth follows the words
Every job folder has `words.json`: the narration's words with `start`/`end` in seconds relative
to the animation start (an empty list for raw jobs). Feed it straight in:

```tsx
import words from "./words.json";
import { LeoCorner } from "../../../styles/leo/src";

<Canvas transparent>
  <LeoCorner words={words} corner="bottom-left" size={0.3} mood="happy" />
</Canvas>
```

`Leo`/`LeoCorner` do the lip sync themselves (a mouth shape per syllable, landed on each word's
onset, closing on real pauses). **Never hand-time mouth shapes** and never pass a trimmed or
shifted word list: the timings ARE the sync. If Leo lives inside a `<Sequence from={n}>`, pass
`timeOffset={n / fps}` so his clock still matches the narration.

## Components (`../../../styles/leo/src`)
- `LeoCorner`: the default placement. Props: `corner` ("bottom-left" | "bottom-right"; right
  side auto-mirrors him to face inward), `size` (fraction of canvas height, default 0.3),
  `enterAt` / `exitAt` (frames; he slides up in, drops out), plus every `Leo` prop.
- `Leo`: the bare character, for scenes where you place him yourself. Props: `words`,
  `timeOffset`, `height` (snapped to a multiple of 64 px so pixels stay square), `hair`
  ("curls" default | "cap"), `mood`, `look` (`{x, y}` in -1..1: where his eyes point), `pose`
  (manual override of eyes/brow/mouth/gaze/headDx for a deliberate held face), `idle`, `flip`.
- `mood` sets the resting face; eyes and brows persist while he talks:
  `neutral` | `happy` (squinting smile, the default for friendly narration) | `think` (furrowed,
  eyes up-left) | `surprised` (wide eyes, raised brows) | `laugh`.
- `PixelPanel`: a chunky dialogue-box plate (dark, light edge, Ember bar) for a caption of a
  few words. `x`, `y`, `width`, `scale`, `showAt`, `hideAt`.
- Pure helpers if you need them: `planSpeech(words)`, `visemeAt(plan, t)`, `isSpeaking`,
  `syllables(text)`, `isBlinking(t, seed)`.

## Where he is, and when
- **Transparent jobs (the norm):** `LeoCorner`, bottom-left unless the footage has its content
  there (then bottom-right). Size 0.26-0.32 of the canvas height. He is present for the whole
  range by default. Slide him out (`exitAt`) ONLY when the footage under him must be unobstructed
  for a moment (a full-screen result, a caption in that corner), and bring him back after.
- **Solid jobs:** dark `<Canvas>` (dot-grid off looks cleaner: `dotGrid={false}`), Leo large on one
  side (height 0.55-0.7 of the canvas), the point being made on the other side as a `PixelPanel`
  caption or a very simple pixel diagram built from plain `<div>` blocks in the LEO tokens.
  Leo `look`s toward the content (`look={{ x: 1 }}` when it is to his right).
- Reference images the user attaches are recreated as simple pixel blocks, never photos.

## Acting
- Default mood `happy` for upbeat narration, `neutral` for explanation, `think` while the
  narration is weighing something ("so the question is..."), `surprised` on a reveal, `laugh`
  on a joke. Change mood on a beat boundary; one or two mood changes per 20s is plenty.
- Brows raise automatically on words that end with "?". Blinks, breathing, glances and the
  talking bob are automatic too: do not add your own random motion.
- `look` is the strongest tool you have: when the narration names something on screen, point his
  eyes at it (`look={{ x: -1 }}` = his left, the viewer's left). Return to `{x: 0}` after.
- Motion is pixel motion: positions snapped to the sprite scale, no sub-pixel drift, no CSS
  blur/rotation/opacity fades on the sprite. Slides step in whole pixels; pops step in 2-frame
  increments. Use `snap(value, scale)` for anything you animate yourself.

## Palette and type (accompanying graphics)
- The sprite has its own fixed palette (skin, black curls, stubble, black tee, thin frames). Do
  not tint or recolor him.
- Everything else: `LEO.bg` `#121212`, `LEO.panel` `#1C1A1D`, `LEO.panelEdge` `#3A3740`,
  `LEO.accent` Ember `#EC6A41` (the only accent), `LEO.ink` / `inkWhite` / `inkMuted`. Inter
  (`LEO.font`) at chunky sizes, weight 600, few words.
- No em dashes in on-screen text.

## Learnings log (append here; newest wins)
When the user corrects a general pattern (not a one-off tweak for this job), append a terse
entry: the rule, why, how to apply. Future animations read this log, so a lesson written once is
never re-learned.

(none yet)
