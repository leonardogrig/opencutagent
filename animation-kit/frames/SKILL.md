<!-- guide-version: 3 -->
# Frame-aware animation guide

This job is a TRANSPARENT overlay that draws ON the user's actual footage: circling the button
they are talking about, underlining on-screen text, an arrow to the panel they mention, a sketch
box around a UI region. The video plays UNDER your clip on the Premiere timeline, so everything
you draw must line up with what is really on screen, in position AND in time. This guide is the
workflow for seeing the footage, anchoring to it, and PROVING each anchor holds.

## What you have

- `public/frames/<jobId>/full/t0012.50.png` — a frame of the sequence every `step` seconds
  (0.5s by default) across the whole animation, at canvas resolution. These are Premiere's OWN
  render of what plays under your overlay (the animation track hidden): every transform, crop
  and punch-in is baked in. A pixel in these frames IS a canvas coordinate. Trust them over any
  memory of the source recording.
- `public/frames/<jobId>/sheets/sheet-....png` — contact sheets of those frames, 12 per sheet,
  row-major, in time order (the file name carries the first and last time; `sheets[].times` in
  the map lists every tile's time). Cheap to Read in bulk: your first survey of what is on
  screen WHEN.
- `src/jobs/<jobId>/frames-map.json` — the map of everything:
  - `frames`: `[{t, file}]` every exported frame (rel seconds -> file under `full/`).
  - `changes`: `[{t, score, kind}]` screen changes: at time `t` the frame differs from the one
    before it. `kind: "major"` = a new shot (a panel opened, a page changed, a window swapped);
    `"minor"` = something moved (typing, a list refresh, a hover). `score` = fraction of the
    screen that changed.
  - `shots`: `[{start, end, dur}]` the stable stretches between major changes. **An anchored
    drawing must live entirely inside ONE shot**, and `dur` is the most an annotation there can
    have (see the time budget below).
  - `black`: rel-time ranges where the screen is black (free canvas there).
  - `canvas`: width/height/fps. `relSec * fps = frame number`. `step`: seconds between frames.
  - `source`: `"sequence"` (Premiere's frames, exact) or `"media"` (a fallback decode of the
    V1 source file: positions and timing are a GUESS there, so keep margins generous and say
    so in your reply if something depends on it).
- `scripts/grab-frames.mjs` — cuts readable frames out of `full/` (downscaled full frames, or
  1:1 crops for measuring). Instant, no Premiere involved.
- `scripts/check-anchors.mjs` — checks every anchor you declared against the frames and writes
  a sheet per anchor (just before / start / middle / end / just after, target outlined).
- `<DebugFrame src="frames/<jobId>/full/t0012.50.png" />` (from `../../components`) — renders a
  footage frame under your overlay in stills so you SEE a drawing on its target. It renders
  nothing in the final delivered clip, so it can stay in the scene.

## Workflow

1. Read `frames-map.json` and the narration in `brief.md`. Note `shots`, `changes`, `black`.
2. Read ALL the contact sheets (they are small). Now you know what is on screen when, and where
   the screen changes. Cross-check the `changes` times with what you see.
3. From the narration and the user's message, decide WHICH moments need anchored drawings:
   demonstratives and screen references ("this button", "click here", "as you can see", "over
   on the left") are your cues. Moments that are pure narration need no anchor at all.
4. For each anchored moment, find its shot (`shots`) and confirm the target in the full frames:
   `node scripts/grab-frames.mjs <jobId> <from> <to>` then Read the frames. Note the FIRST and
   LAST frame the target is visible in; the shot boundaries cap those.
5. Measure the target: `--crop x,y,w,h` (canvas pixels) gives a 1:1 cutout; a point at (px,py)
   inside it is canvas (x+px, y+py). Downscaled full frames print the factor to multiply by.
6. Declare every anchored drawing in `src/jobs/<jobId>/anchors.json` (format below), build
   the drawing, run `node scripts/check-anchors.mjs <jobId>`, Read the sheets it wrote, fix
   anything that FAILs, and only then write `render.json`.

## Match the annotation to the time it has (the most common mistake)

Screen recordings move fast: a panel can be on screen for one second before the next click.
The viewer must be able to SEE and READ whatever you draw before the target is gone, so the
length of the target's window (its shot in `shots`, or the anchor window you found) decides how
much you may draw. The budget, with `visible` = how long the target is on screen inside your
drawing's span:

| target visible for | what you may draw                                                        |
|--------------------|--------------------------------------------------------------------------|
| under 0.7s         | nothing anchored. Let the footage speak; the narration carries it.       |
| 0.7s to 1.5s       | ONE bare stroke: a border, an underline, an arrow, a circle. NO text.    |
| 1.5s to 3s         | the stroke + at most one short label (1 to 3 words) that appears WITH    |
|                    | the stroke, not after it. No second element, no staggered reveal.        |
| over 3s            | a label of up to ~6 words per line and one supporting element. Everything|
|                    | must be fully drawn with at least 1s left to read it.                    |

Rules of thumb:
- Text needs about **0.6s + 0.25s per word AFTER it finishes drawing**. The check enforces this:
  declare the label in `anchors.json` (`text` or `words`) and it FAILs when the target's window
  can't fit it. Fix by dropping the text, not by stretching the drawing over the next screen.
- Draw-in time counts against the window: on a short window use a fast draw-in (a few frames),
  never a slow reveal. Declare it as `drawIn` so the check can account for it.
- The narration often keeps talking about something after the screen moved on ("your alert, or
  an email, or a ticket" while the Slack panel is already gone). Do NOT carry the words over to
  the next screen. End the drawing with its target; if the next screen is the new subject,
  anchor a new, simpler drawing to it.
- A single quiet border on the right thing beats a beautiful three-line label nobody can read.

## anchors.json (mandatory for every anchored drawing)

```json
{ "anchors": [
  { "id": "title-box", "what": "the workflow title", "rect": { "x": 466, "y": 646, "w": 218, "h": 56 },
    "from": 1.78, "to": 3.10, "text": "a new workflow", "drawIn": 0.4 },
  { "id": "slack-node", "what": "the Slack node panel header", "rect": { "x": 2160, "y": 240, "w": 620, "h": 120 },
    "from": 8.55, "to": 8.95 }
] }
```

- `rect`: canvas pixels around the on-screen TARGET (the thing you point at, not your stroke).
- `from` / `to`: rel seconds the drawing is VISIBLE, first frame to last frame (fade-outs
  included). Use the same numbers your scene uses.
- `text`: the label drawn with this anchor (or `words`: its word count). Omit for a bare stroke.
- `drawIn`: seconds the drawing takes to fully appear (default 0).
- `expectMotion: true` only for a target that legitimately animates (a spinner, a scrolling
  list); its region changes are then reported but not failed.
- Free-canvas elements (a stopwatch in empty space, text on a black screen) are not anchors;
  leave them out. A job with no anchored drawings at all needs no anchors.json.

The check samples the frames from one step before `from` to one step after `to`, compares the
rect across them, and reports: **FAIL** when the region changes inside the span (the target is
not there yet at the start, or gone before the end, or replaced mid-way) or when the declared
text can't be read in the time the target is visible, **WARN** for small changes (a cursor pass,
a caret), **OK** when the region holds. The server runs the SAME check when you signal
render.json; a FAIL comes back to you as an automatic message and the render waits for your fix.
Run it yourself first and save the round trip.

## Positioning rules

- Every coordinate you use must come from a frame you actually looked at, never from memory of
  "roughly where buttons usually are".
- Never ship an anchored drawing you have not seen composited over the real frame. Put
  `<DebugFrame src="frames/<jobId>/full/<the frame at that beat>" />` as the FIRST child inside
  `<Canvas transparent>`, render a still at the matching frame number (`round(relSec * fps)`),
  Read the PNG, and check the drawing sits on its target. Off by more than a few pixels: fix and
  re-check. Do this at the START and the END of each anchored drawing (two stills), not just
  once in the middle: the two failure modes that reach the user are a drawing that starts before
  its target appears and one that stays after the screen changed.
- A circle/box around an element should breathe: pad ~8-16 canvas px around the element's true
  bounds so the sketch stroke doesn't cover what it points at.
- If the footage moves (scrolling, window dragged), the region will not be stable: either track
  the element with keyframed positions (declare `expectMotion`) or keep the annotation to the
  still part of the shot.

## Timing rules

- An anchored drawing may only be visible while its target is on screen. Confirm the target in
  the frame at the drawing's first AND last visible frame; keep a safety margin of at least one
  `step` inside both ends (the exported frames are `step` apart, so the true transition can be
  anywhere inside that interval). Never let a highlight outlive the thing it highlights (screen
  changed, dialog closed, scrolled away), and never start it before the thing is there.
- A drawing never straddles a `major` change. If the narration keeps talking about something
  after the screen moved on, end the drawing at the change and, if useful, start a NEW drawing
  anchored to the new screen.
- Sync beats to the word timings in brief.md like any other job; the shot and the anchor
  windows CAP those beats.
- Rel time is the animation clock: t=0 is your first frame, and the same t in the frames is the
  same instant in the footage below.

## Black or empty screens

- Inside a `black` span (or when a frame shows nothing meaningful to anchor to: near-black,
  a blank desktop), animate exactly as a normal transparent job: free canvas, style rules apply,
  no anchors needed.
- The moment real content is back on screen, anchor again. Do not keep free-floating layouts
  running over visible UI.
- If `frames-map.json` has no frames, treat the ENTIRE job as a normal transparent animation
  and say nothing about frames to the user.

## Budget

- Sheets are cheap; full frames cost more. Read full frames only inside the windows you decided
  to anchor, plus the frames right around a `change` you must pin down.

## Learnings Log

Append a dated one-liner here when the user corrects a reusable frame-anchoring pattern
(placement conventions, timing feel, verification tricks). Keep entries terse.
