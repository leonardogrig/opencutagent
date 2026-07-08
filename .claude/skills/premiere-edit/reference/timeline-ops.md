# Timeline ops — detailed reference

Load this when a tool errors, when you need exact parameters, or when an operation isn't covered by the six tools.

## Time values

Anywhere a time is accepted you may pass:
- **seconds** — `12.5`
- **timecode** — `00:01:23:10` (non-drop) or `00:01:23;10` (drop-frame)
- **frames** — `370f`

Returned timecodes already include the sequence's start timecode (they match Premiere's ruler), and timecode INPUTS are read the same way — echoing a returned TC back into `ppro_trim_clip` lands on the same ruler position (the start TC is subtracted; drop-frame `;` is counted as SMPTE drop-frame). Plain seconds and `Nf` frames stay timeline-relative (0 = sequence start).

## ppro_get_timeline_state

- `response_format`: `"concise"` (default) or `"detailed"` (adds source in/out, media paths, raw ticks/frames).
- `track_filter`: `"video"`, `"audio"`, or a track like `"V1"`/`"A2"`.
- Each clip: `id`, `track`, `name`, `start`, `end`, `durationSeconds`; detailed adds `sourceIn`, `sourceOut`, `mediaPath`.
- Clips flagged `speed` are NOT 100% — transcript/cut tools refuse them in v1.
- Clips flagged `note: no source media` are titles/graphics/offline — can't be transcribed.
- `revision` increments on every successful edit; use it to confirm a change happened.

## ppro_identify_segments

- `clip_id`: a clip id, or `"all"` (default → every video clip with media).
- `language`: ISO code to skip auto-detect; `num_speakers`: known speaker count.
- `refresh: true`: re-transcribe even if cached (only if the source file changed).
- Returns phrases (timeline tc + text + speaker), counts of silences/fillers, a fillers preview, and `transcriptPath` (full word-level JSON on disk for deep inspection).
- Long phrase lists are truncated in the response; the full data is at `transcriptPath`.

## ppro_trim_clip

- Absolute edges; provide any of `source_in`, `source_out`, `timeline_start`, `timeline_end`.
- Idempotent — re-issuing the same call is a no-op.
- To shorten a tail: set `source_out` earlier (or `timeline_end` earlier). To shorten a head: set `source_in` later.
- Returns before/after edges. If `after` is missing, the clip's index shifted — re-read state.

## ppro_remove_gaps

- `track_filter` and `min_gap_frames` (default 1).
- Ripple-closes empty space; downstream clips slide left.
- v1 closes gaps **per track**. On a simple A/V-linked talking head this keeps sync (gaps are aligned). If tracks have independent gaps, restrict with `track_filter` and verify.

## ppro_remove_silences

- Targets: `clip_id` or `"all"` (default, video clips with media).
- `dry_run: true` → returns the cut list (each: clip, from/to tc, seconds, reason `silence`/`filler`, and the filler text) and `totalRemovedSeconds`. **Nothing changes.** Always do this first and show the user.
- `dry_run: false` → applies the cuts right-to-left (so earlier positions stay valid), razoring all tracks at each edge and ripple-deleting the span (audio + video stay in sync).
- Tuning: `min_silence_ms` (default 400), `pad_ms` (air kept around speech, default 80), `remove_silences`, `remove_fillers`, `filler_list` (override the lexicon).
- The cut edges are padded and snapped to word boundaries so speech isn't clipped.

## ppro_run_script (escape hatch)

- `jsx`: ExtendScript source; the last evaluated expression is returned (JSON-serialized).
- The host exposes the standard `app` DOM and (after `app.enableQE()`) the `qe` DOM.
- Return JSON-serializable data (numbers/strings/arrays/plain objects). Don't return Premiere objects directly.
- Prefer the dedicated tools; use this only for coverage gaps.

## Recovery

| Symptom | Cause | Action |
|---|---|---|
| "panel isn't connected" | Premiere/panel not open, or server not running | Ask user to open Premiere + a project, open Window ▸ Extensions ▸ OpenCutAgent (must say Connected), confirm `claude` is running in the project. Don't retry-loop. |
| "No active sequence" | No sequence in the timeline | Ask the user to open/select a sequence. |
| "non-100% speed" / multicam | Out of v1 scope | Stop; tell the user. Don't force it. |
| "Premiere did not respond (timeout)" | Host busy, modal dialog, or mid-render | Ask the user to dismiss any Premiere dialog, then retry. |
| Cut landed a frame off | Drop-frame timecode edge case | Note it; for 29.97 sequences confirm drop-frame vs non-drop; adjust `pad_ms` or trim manually. |
| Edit didn't change anything | Stale ids after a prior ripple | Re-read `ppro_get_timeline_state`; ids/indexes may have shifted. |

## Known v1 limitations

- 100%-speed clips only; flat sequences (no multicam/nested).
- Drop-frame detection is best-effort (29.97/59.94 assumed drop). Verify on DF projects.
- `ppro_remove_gaps` / `ppro_remove_silences` ripple per track; designed for simple A/V talking-head layouts.
- Premiere's own transcript/captions aren't readable via API — transcription is done from the source media (ElevenLabs Scribe).
