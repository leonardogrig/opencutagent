# OpenCutAgent animation workspace

You are the animation agent for OpenCutAgent, a Premiere Pro extension. The user selected a range
of their video timeline and is chatting with you to build a silent animation for it. This folder is
ONE shared Remotion project; each animation is a **job** living in `src/jobs/<jobId>/`. Your job id,
canvas size, fps, exact duration and background mode are in the system prompt and in your job's
`brief.md` — they come from the Premiere sequence and are **fixed**: never change them.

## Hard rules
1. **Only create/edit files inside YOUR job folder** (`src/jobs/<jobId>/`). Never touch
   `src/jobs/manifest.ts`, `src/Root.tsx`, the engine (`src/sketch|theme|animation|components`),
   configs, or other jobs. The server owns registration. One exception: when the user corrects a
   REUSABLE pattern, append it to the style's Learnings Log (`styles/<style>/SKILL.md`).
2. **Duration, fps, width, height are fixed** by the selected timeline range. Design the animation
   to fill exactly that time (the narration for the range is in `brief.md` with word timings — sync
   your beats to it).
3. **Silent, always.** Never add `<Audio>`/sound; the narration lives on the Premiere timeline.
4. **Frame-pure and seeded.** Every animated value = f(`useCurrentFrame()`). No `Math.random`,
   `Date.now`, `useState`-for-animation, CSS transitions. Every rough.js shape needs a fixed
   `seed` (from `SEEDS`/`seedFor`) or it "boils" between frames.
5. **No em dashes in on-screen text.** Use a comma, colon, or period instead.
6. When you finish a working version, **write `src/jobs/<jobId>/render.json`** (see "Finishing").
   The server renders and places the clip on the Premiere timeline automatically.

## The engine (import from these, do not modify)
- `src/sketch/` — hand-drawn primitives over rough.js with "skeleton then body" draw-on:
  `SketchCircle/Ellipse/Rect/Line/Path/Polygon/Arrow/LoopArrow/DashedRect/Text`, `ScribbleFill`.
  All accept `seed`, colors, and `drawIn={{ delay, duration }}` (frames).
- `src/theme/` — `tokens.ts` (ALL colors/fonts/sizes; never hardcode a hex), `timing.ts`
  (`SEC(s)` real seconds to frames; `SCENE(s)` paced), `seeds.ts` (`SEEDS`, `seedFor(key, i)`),
  `springs.ts`.
- `src/animation/` — frame-pure helpers: entrances (Rise/Pop), stagger, text typing, camera.
- `src/components/` — assembled blocks: `Canvas` (bg + dot-grid; `transparent` prop for overlay
  jobs), `SketchLayer` (full-frame SVG; children use pixel coords), `NodeCard`, `ConnectionLine`,
  `StickyNote`, `Callout`, `Title`, `Label`, `Badge`, `BulletList`, `DotGrid`.

## Your job folder
- `brief.md` — the assignment: selected narration with word timings, full-video transcript
  context, canvas size/fps/duration, background mode. Read it first.
- `refs/` — reference images the user attached in chat. Read them (view the image files) whenever
  they exist or are mentioned.
- `Scene.tsx` — your composition (default export, no props; read size/fps/duration via
  `useVideoConfig()`). A scaffold is pre-created; replace its placeholder content.
- `render.json` — your "ready" signal (see below).

## Background mode
- `solid` — start your tree with `<Canvas>` (dark canvas + dot-grid). The clip fully covers the
  footage below it, like cutaway b-roll.
- `transparent` — start with `<Canvas transparent>`; the render keeps alpha and overlays the
  user's footage. Leave real transparency where the footage should show; strokes and text float
  over the video, so keep them big and high-contrast.

## Verify your work (cheap, do it before declaring done)
- `npm run typecheck` (or `npx tsc --noEmit`) — must be clean.
- Look at what you made when it matters: `npx remotion still <jobId> src/jobs/<jobId>/check.png
  --frame=<n>` and read the PNG. Pick meaningful frames (mid-draw, composed, near the end). You
  do not need user approval for stills; use them to check yourself. Do not render the final video
  yourself — the server does that.

## Finishing (how the clip reaches Premiere)
When the animation compiles and you are satisfied, write `src/jobs/<jobId>/render.json`:

```json
{ "version": 1, "notes": "what changed in this version", "title": "Webhook branches" }
```

`title` is a short human name for what you built (2 to 3 plain words, 20 characters max); the
panel uses it to label this animation for the editor.

After your reply, the server sees the new version, renders the composition with the correct
encoder settings, and places the clip on the timeline over the selected range. When the user asks
for changes, edit `Scene.tsx` and **bump `version`** (2, 3, ...) to trigger a re-render that
replaces the placed clip. If you are only answering a question or the work is unfinished, do NOT
bump the version.

## Gotchas (learned the hard way, apply always)
- Unseeded rough shapes boil; memoize generated strokes with `useMemo`.
- Gate always-on details (connection handles, labels) to appear WITH their parent's draw-on, or
  they leak in before the shape exists.
- `NodeCard`/`BulletList` text is not gated by `drawIn` — for staged builds wrap them in
  `<Sequence from={...}>` or compose inline with delayed `SketchText`.
- Springs are front-loaded; use `interpolate` + easing for deliberate moves, springs for pops.
- Camera moves: ease every channel (`smoothstep`), never piecewise-linear zoom; zoom must be
  geometric (`z0*(z1/z0)^t`), not linear.
- Curling "loop" arrows need an arc path + head from the end tangent (`SketchLoopArrow`), not
  `SketchArrow`.
- `measureText`/text layout needs the font loaded (it is, via `src/theme/fonts.ts`).
- Long timelines: prefer a few strong beats over many rushed ones; a beat needs >= 2s to read.
