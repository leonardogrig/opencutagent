# Frame-aware animation guide

This job is a TRANSPARENT overlay that draws ON the user's actual footage: circling the button
they are talking about, underlining on-screen text, an arrow to the panel they mention, a sketch
box around a UI region. The video plays UNDER your clip on the Premiere timeline, so everything
you draw must line up with what is really on screen, in position AND in time. This guide is the
workflow for seeing the footage and anchoring to it.

## What you have

- `src/jobs/<jobId>/frames-map.json` — the map between the animation's clock and the footage:
  - `spans`: which rel-time ranges have footage and where they live in the source. A rel time
    outside every span has no footage under it (already cut away).
  - `media`: each source's pixel size and its `fit` into the canvas (scale + letterbox offsets).
    You rarely need this: every extracted frame is ALREADY mapped into canvas space.
  - `black`: rel-time ranges where the screen is black (pre-scanned). Do not bother Reading
    frames there.
  - `canvas`: composition width/height/fps. `relSec * fps = frame number`.
- `public/frames/<jobId>/overview/` — small thumbnails every ~3s across the whole range,
  canvas-mapped. Cheap to Read in bulk; use them FIRST to learn what is on screen when.
- `scripts/grab-frames.mjs` — extracts more frames on demand (see workflow). All output is in
  canvas coordinate space.
- `<DebugFrame src="frames/<jobId>/t0012.40.png" />` (from `../../components`) — renders that
  footage frame under your overlay in stills so you can SEE whether a drawing lands on its
  target. It automatically renders nothing in the final delivered clip, so it can stay in the
  scene.

## Workflow

1. Read `frames-map.json` and the narration in `brief.md`. Note the `black` spans.
2. Read the overview thumbnails (all of them; they are tiny) to learn what is on screen when.
3. From the narration and the user's message, decide WHICH moments need anchored drawings:
   demonstratives and screen references ("this button", "click here", "as you can see", "over on
   the left") are your cues. Moments that are pure narration need no frames at all.
4. For each anchored moment, grab full-size frames only for that window:
   `node scripts/grab-frames.mjs <jobId> <from> <to> --every 1`
   Read them, find the target element, and note WHEN it appears and disappears (grab a couple of
   extra frames around a transition if you need to pin the exact moment).
5. Measure the target's position. Full frames are downscaled; the script prints the factor to
   multiply by. For precision, crop: `--crop x,y,w,h` (canvas pixels) gives a 1:1 canvas-scale
   cutout; a point at (px,py) inside it is canvas (x+px, y+py). Measure in the crop, then you
   have exact canvas coordinates.
6. Build the drawing, then VERIFY (mandatory, see below), then iterate until it lands.

## Positioning rules

- Every coordinate you use must come from a frame you actually looked at, never from memory of
  "roughly where buttons usually are".
- Never ship an anchored drawing you have not seen composited over the real frame. Put
  `<DebugFrame src="frames/<jobId>/<the frame near that beat>" />` as the FIRST child inside
  `<Canvas transparent>`, render a still at the matching frame number
  (`round(relSec * fps)`), Read the PNG, and check the drawing sits on its target. Off by more
  than a few pixels: fix and re-check. Do this for EVERY anchored element at least once.
- A circle/box around an element should breathe: pad ~8-16 canvas px around the element's true
  bounds so the sketch stroke doesn't cover what it points at.
- If the footage moves (scrolling, window dragged), re-grab frames inside that motion and either
  track the element with keyframed positions or keep the annotation to the still part of the
  shot.

## Timing rules

- An anchored drawing may only be visible while its target is on screen. Confirm the target
  exists in a frame near the drawing's first AND last visible frame; keep a safety margin of
  about one sampled interval inside both ends. Never let a highlight outlive the thing it
  highlights (screen changed, dialog closed, scrolled away).
- Sync beats to the word timings in brief.md like any other job; the anchor windows you found in
  step 4 CAP those beats.
- Rel time is the animation clock: t=0 is your first frame, and the same t in the frames is the
  same instant in the footage below.

## Black or empty screens

- Inside a `black` span (or when a frame shows nothing meaningful to anchor to: near-black,
  a blank desktop), animate exactly as a normal transparent job: free canvas, style rules apply,
  no frames needed.
- The moment real content is back on screen, anchor again. Do not keep free-floating layouts
  running over visible UI.
- If `frames-map.json` has no usable media or no spans, treat the ENTIRE job as a normal
  transparent animation and say nothing about frames to the user.

## Budget

- Overview thumbnails are cheap; full frames are not. Default to ~1 frame per second INSIDE the
  windows you decided to anchor, and only densify right around a transition you must pin down.
  Do not carpet-extract the whole range at high rate.

## Learnings Log

Append a dated one-liner here when the user corrects a reusable frame-anchoring pattern
(placement conventions, timing feel, verification tricks). Keep entries terse.
