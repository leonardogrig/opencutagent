---
name: premiere-edit
description: Edit a video on the live Adobe Premiere Pro timeline via the OpenCutAgent MCP bridge — transcribe clips, trim, close gaps, ripple-delete silences/filler, and remove duplicate RETAKES (you analyze the transcript yourself and mark keep/cut). Use when the user wants to cut, trim, tighten, or clean up a Premiere sequence, remove dead air or "um"/"uh", cut re-recorded takes / false starts / duplicate lines, see what is said on the timeline, or assemble a rough cut. Requires the OpenCutAgent panel open in Premiere and the `premiere` MCP server connected.
---

# Premiere Edit

Drive Adobe Premiere Pro's **live timeline** through the `mcp__premiere__ppro_*` tools. Edits land in the user's real sequence — non-destructively, so they keep editing in Premiere afterward. Undo is always `Cmd+Z` in Premiere.

This is the opposite of a render-a-new-file workflow: you change the actual timeline, you don't output an mp4.

## Principle

1. **Read before you cut.** Always `ppro_get_timeline_state` first. Address clips by their semantic ids (`V1.2` = 3rd item on video track 1).
2. **Audio is the map.** `ppro_identify_segments` transcribes a clip's source and returns phrases, silences, and fillers at **timeline timecodes**. That is how you "see" the sequence.
3. **Propose → confirm → execute → verify.** Never apply a destructive edit before the user has approved a plain-English plan. For silence/filler cuts, always preview with `dry_run` first.
4. **Generalize.** Don't assume the kind of video. Look at the transcript, ask, then edit.

## Hard rules (non-negotiable)

1. **Preview destructive cuts.** Call `ppro_remove_silences` with `dry_run: true`, show the cut list, get a yes, then call again with `dry_run: false`. Same discipline before any large `ppro_remove_gaps`.
2. **Confirm strategy before the first edit.** State what you'll cut/trim in plain English and wait.
3. **Verify after editing.** Re-read `ppro_get_timeline_state` and confirm clip count / positions changed as expected. Report the new revision.
4. **Never invent clip ids or timecodes.** Use the values the tools return.
5. **Respect the v1 envelope.** Tools operate on **100%-speed clips in flat sequences**. If a clip is flagged non-100% speed, or the sequence uses multicam/nested clips, say so and stop rather than producing a desynced edit.
6. **Tell the user undo is `Cmd+Z`** whenever you apply a destructive edit.

## Preconditions — check first

If any tool returns "panel not connected" or "no active sequence":
- Premiere must be open with a project **and a sequence in the timeline**.
- The **OpenCutAgent panel** must be open (Window ▸ Extensions ▸ OpenCutAgent) and showing **Connected**.
- The `premiere` MCP server must be loaded (it is registered in `.mcp.json`).
Relay this to the user concisely; don't loop retrying.

## Workflow

1. **Read the room.** `ppro_get_timeline_state`. Summarize the sequence in one or two sentences: tracks, clip count, total duration, frame rate, any gaps, any non-100%-speed or media-less clips.
2. **Read the content.** `ppro_identify_segments` (clip_id `"all"` or a specific clip). Skim the phrases; note long silences and filler density. First run on a source can take a while (ffmpeg + Scribe); later runs are cached.
3. **Propose.** In plain English: what you'll trim, which silences/fillers you'll cut, expected time removed. **Wait for confirmation.**
4. **Execute.**
   - Trim a clip's head/tail: `ppro_trim_clip` (absolute edges; seconds, timecode, or `370f` frames).
   - Tighten silences/fillers: `ppro_remove_silences` with `dry_run: true` → show the cut list and total seconds removed → on approval, `dry_run: false`.
   - Close leftover gaps: `ppro_remove_gaps`.
5. **Verify.** Re-read `ppro_get_timeline_state`; confirm the change; report the new clip count, duration, and revision. Remind: `Cmd+Z` to undo.
6. **Iterate.** Take natural-language feedback (looser/tighter, keep that filler, raise the silence threshold) and re-run. Tune with `min_silence_ms`, `pad_ms`, `remove_fillers`, `filler_list`.

## Retake / duplicate removal — YOU are the AI

When the user wants to cut re-recorded takes / false starts / duplicate lines (common in raw talking-head or voiceover recordings), **you do the reasoning yourself** — there is no external model. The loop:

1. **`ppro_get_retake_segments`** → transcribes the timeline into indexed segments. Returns a compact `segments` string, one line per segment: `[index] m:ss text`. **If the result exceeds the MCP output cap, it's auto-saved to a file** — read that file (e.g. with `jq -r '.segments[] | "[\(.index)] \(.time) \(.text)"'`) to get all of them. The server keeps the segments in memory, so you can mark by index even if you read them from the file.
2. **Analyze them yourself** (the judgment — see "How to judge retakes" below). Decide a **keep** or **cut** for every segment.
3. **`ppro_mark_retakes`** → send ALL decisions in **one** call: `[{index, decision:"cut", group, reason}]`. Use a shared `group` id per beat (colors the panel's retake clusters). Keepers stay keep by default — you only need to send the cuts. For hundreds of segments, **generate the cut list with a script** (define beats as `[start,end]`+keepers, emit every non-keeper) rather than hand-typing — it's accurate and fast. Marks appear live in the panel; nothing is edited yet.
4. **User reviews** the Keep/Cut marks in the panel and flips/Protects anything.
5. **Apply** — `ppro_apply_retakes` (confirm first) or the panel's **Apply All**. `remove_gaps:true` ripples (closes the gaps → tight cut); false lifts (leaves gaps). `trim_excess:true` ALSO cuts the non-speech air inside kept segments (leading/trailing dead air around the words, ~0.15s pad kept) so only the spoken spans survive — segments tile whole clips, so a keep can hide minutes of silence after its last word (panel equivalent: the "Remove excess" checkbox). `Cmd+Z` undoes.

Efficiency notes: one big `get` + one big `mark` beats many small calls. Don't re-transcribe (cached). Protected segments are never cut. Report the keep/cut/removed-seconds summary the tool returns.

### How to judge retakes (this is the whole game)

**The #1 pattern is the _serial restart_.** In a raw recording the speaker starts a line, stumbles or cuts off, and **restarts from the top** — getting a little further each time — until one clean pass. It looks like a staircase where each step repeats the opening words of the one before:

```
[2] n8n now has-                                              ← cut
[3] n8n now has a set of skills-                              ← cut
[4] n8n now has a set of skills that helps Claude-            ← cut
[5] n8n now has a set of skills that helps Claude understand… ← cut
 …(a dozen more restarts)…
[11] n8n now has a set of skills that instructs Codex how to use their MCP to-   ← KEEP (best/most-complete pass)
```

**Rule: of a run of restarts of the same line, keep only the single most complete, fluent pass — cut ALL the others.** A run can be 3 restarts or 35; cut every one but the keeper.

**Signals a segment is a discarded take (cut it):**
- ends mid-word or with a dash `-`, or trails off / trails into a `(clears throat)`;
- **is a prefix of, or repeats the opening words of, a nearby segment** (the staircase);
- is immediately followed by the same phrase started over;
- standalone filler / throat-clears / "testing testing" / "blah blah"; ambient-noise lines like `(traffic)`, `(mouse clicking)`, `(sigh)`.

**The critical distinction — restart vs. next point.** Do **not** cut a segment just because it sounds similar to its neighbour. A *restart* re-attempts the **same** words; a *next point* moves **forward** with **new** content. Adjacent segments that are each complete and fluent but say **different things** are **both keepers**:

```
[160] So this is my prompt: create a workflow, a webhook trigger…   ← KEEP
[161] It then goes through an AI agent using OpenRouter,            ← KEEP (new content)
[162] Gemini 2.5 Flash, to answer the question.                     ← KEEP (new content)
[163] They get a response back from the webhook. Simple…           ← KEEP (new content)
[164] but it sh- but it sh-                                         ← cut (restart begins)
 …                                                                  ← cut
[171] but it should be enough for Claude to understand…             ← KEEP (clean pass of that line)
```

So a region can have **several keepers** — one clean pass per distinct point. (It is **not** "exactly one keep per beat.") When **no** take of a line is clean on its own, keep the **fewest consecutive** takes that together read as one fluent line (a clean first half + a clean second half) and cut the rest.

**Calibration — this is where it usually goes wrong:**
- **Be decisive about obvious restarts.** A segment ending in `-`, or that is a strict prefix of the next one, is almost always a discarded take — cut it. Keeping two or three versions of the same sentence "to be safe" *is the bug the user is trying to fix* — it leaves the duplicates on the timeline. Don't do it.
- **Reserve "keep when unsure" for genuine _content_ ambiguity** (is this a distinct point or a duplicate?), **not** for plain restarts. If you genuinely can't tell whether a fluent line duplicates another, keep it — the user reviews every mark. But a line that plainly restarts its neighbour is never the "unsure" case.
- **Stay thorough on long runs.** One line can be restarted 20–40 times in a row; cut every restart, not just the first few. Don't get lazy and leave the back half of a long run kept.

## Tools (quick reference)

- `ppro_get_timeline_state` — sequence + clips (semantic ids) + gaps + revision. Read-only. Start here.
- `ppro_identify_segments` — transcribe a clip's source (Scribe, cached) → phrases / silences / fillers at timeline timecodes.
- `ppro_trim_clip` — set absolute new edges for one clip (idempotent).
- `ppro_remove_gaps` — ripple-close empty gaps.
- `ppro_remove_silences` — transcribe → cut list (silences + fillers) → ripple-delete. `dry_run` first, always.
- `ppro_analyze_audio_levels` / `ppro_remove_silences_by_level` — **loudness-based** silence removal (no transcription) for the Remove Silences panel + "Suggest threshold". See the **remove-silences** skill. Prefer these for "cut the dead air"; use `ppro_remove_silences` when the goal is filler words.
- `ppro_get_retake_segments` — transcribe → indexed segments for YOU to analyze for retakes/duplicates.
- `ppro_mark_retakes` — record your keep/cut decisions (one batch); pushes them live to the panel.
- `ppro_apply_retakes` — apply the current marks (ripple/lift-delete the Cut segments; `trim_excess` also trims non-speech inside keeps). Confirm first.
- `ppro_run_script` — escape hatch for raw ExtendScript. Last resort.

Detailed parameters, edge cases, and recovery steps are in `reference/timeline-ops.md` — read it when a tool errors or you need an operation the six tools don't cover.

## Anti-patterns

- Editing before confirming the strategy. Never.
- Applying `ppro_remove_silences` without a `dry_run` preview.
- Re-transcribing a source that hasn't changed (it's cached — don't pass `refresh` unless the file changed).
- Trusting a single tool result over the timeline: after a destructive edit, re-read state.
- Pushing through a non-100%-speed or multicam clip. Stop and tell the user it's out of v1 scope.
- Cutting on a raw silence boundary without the built-in padding — the tools already pad and snap; don't fight them by setting `pad_ms` to 0 unless asked.
