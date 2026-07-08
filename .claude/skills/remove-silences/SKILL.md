---
name: remove-silences
description: Loudness-based silence removal on the live Adobe Premiere Pro timeline via the OpenCutAgent "Remove Silences" panel. Measure audio levels (ffmpeg, NO transcription/API), recommend or set the Noise Threshold ("Suggest threshold"), preview the silence/margin zones, and ripple/lift/mute-delete dead air. Use when the user wants to remove silences, cut dead air / pauses / gaps of quiet, tighten the pacing, set or auto-calculate a noise threshold, or asks about the Remove Silences tab / "Suggest threshold". Requires the OpenCutAgent panel open in Premiere and the `premiere` MCP server connected.
---

# Remove Silences (loudness-based)

The **Remove Silences** tab is the first thing most users reach for: it removes dead air by **audio loudness**, not transcription. The server measures each clip's source loudness with ffmpeg (cached, **no Scribe call, no API key, no credits**), the panel draws the dB envelope, and silences below the **Noise Threshold** are removed — ripple, lift, or mute. This is faster and cheaper than the transcript-based `ppro_remove_silences`; use it for "cut the silences / dead air / pauses". Use the transcript path only when the user specifically wants **filler words** ("um", "uh") cut, which need the words.

Edits land in the user's real sequence, non-destructively. Undo is always **Cmd+Z** in Premiere.

## The controls (mirror the panel)

- **Noise Threshold** (dB) — audio below this is silence. *The one knob that matters most.*
- **Remove Silences Longer Than** (ms) — only cut silences at least this long. Default 120.
- **Keep speech longer than** (ms) — speech islands shorter than this (pops, mic bumps, chatter bursts) are treated as silence, unconditionally (exact AutoCut/TimeBolt semantics — merges a stretch of sub-keepTalk chatter into one solid removable block). Values > ~750ms risk eating short connector words. Default 400.
- **Margin before / Margin after** (ms) — air kept before the next / after the previous speech (the green "Margins"). Default 120/120.
- **Silence Management** — `remove` (ripple, close gaps) · `keep_spaces` (lift, leave gaps) · `mute` (silence, keep the picture) · keep (no change).
- **Transitions** — recorded; **v1 applies clean cuts** (no auto-crossfade yet). Tell the user if they pick J/L-Cut etc.

## Tools

- **`ppro_analyze_audio_levels`** — measure loudness; returns per-clip and overall stats (min / median / **speechDb** / **noiseFloorDb**) and a suggested threshold. **This powers the panel's "Suggest threshold."** Pass `set_threshold_db` to push YOUR chosen dB live into the panel.
- **`ppro_remove_silences_by_level`** — the full cut: preview with `dry_run:true` (returns the cut list + total seconds), then `dry_run:false` to apply. Controls: `threshold_db`, `min_silence_ms`, `keep_talk_ms`, `margin_before_ms`, `margin_after_ms`, `mode` (`remove`/`keep_spaces`/`mute`).

Both default `clip_id:"all"` (every video clip with media). They share the same loudness engine as the panel, so chat and panel always agree.

## "Suggest threshold" — the flow the user expects

When the user clicks **Suggest threshold** in the panel, or asks you to "calculate / set the silence threshold with AI":

1. **`ppro_analyze_audio_levels`** — read `noiseFloorDb` and `speechDb` (overall and per clip).
2. **Reason about it.** Anchor to **speech**: a good threshold sits roughly **30 dB below the speech level** (90th percentile), never closer than 10 dB to it, and always above the noise floor — the generous drop keeps QUIET passages (speaker leaning back, trailing off; 15–25 dB under normal level) above the threshold so they don't get shredded. The meter is **peak-per-window, normalized to the recording's own peak, with a hard −60 dB floor** — −60 is the slider minimum and means "detect nothing", so never answer −60; stay within −55…−20. A wide noise↔speech gap allows an aggressive (higher) threshold; a narrow gap (noisy room, music bed) needs a conservative one and a note to the user. The auto `suggestedThresholdDb` is a fine starting point — adjust it with judgment, don't just echo it.
3. **Push your choice:** call `ppro_analyze_audio_levels` again with `set_threshold_db: <your dB>` (optionally also `min_silence_ms` etc.). It updates the panel **live** — the threshold line moves and the red zones recompute. Tell the user the value and why, and that they can fine-tune and hit **Remove Silences**, or ask you to apply.

## Headless flow (drive entirely from chat)

1. **`ppro_remove_silences_by_level` `dry_run:true`** — show the cut count, total seconds, and a few example timecodes. (Pass `threshold_db` if you've chosen one; otherwise it auto-estimates.)
2. **Confirm** the plan in plain English. Wait for a yes.
3. **`ppro_remove_silences_by_level` `dry_run:false`** with the agreed `mode`. Report applied count + seconds. Remind: **Cmd+Z** to undo.

## Hard rules (non-negotiable)

1. **Preview before cutting.** Always `dry_run:true` first (or have the user review the panel's red zones), get a yes, then apply.
2. **Threshold is content-specific.** Never invent a dB blindly — analyze first. Re-tune from feedback ("too aggressive → lower the threshold a few dB or raise *Remove Silences Longer Than*"; "clipping speech → raise *Margin* / *Keep speech longer than*").
3. **Respect the v1 envelope.** 100%-speed clips in flat sequences. Non-100%-speed / multicam clips are skipped — say so, don't force them.
4. **Transitions = clean cuts in v1.** If the user selects J-Cut/L-Cut/Overlap/Constant Power, note that the style is recorded but v1 ripple/lift-deletes cleanly.
5. **Undo:** after a cut the panel shows a one-click **↩ Undo** button that restores the timeline to exactly before the apply (snapshot reconstruction); **Cmd+Z** is the guaranteed fallback. Tell the user both. A long scan or cut can be halted with the panel's **Stop** button.

## Preconditions

If a tool returns "panel not connected" or "no active sequence": Premiere must be open with a project **and a sequence**, the **OpenCutAgent panel** open and **Connected**, and a `claude` session running in the project. Relay concisely; don't retry-loop.

## Relationship to the rest of OpenCutAgent

This is one of the `mcp__premiere__ppro_*` tools — see the **premiere-edit** skill for the full toolset (`ppro_get_timeline_state`, trim, gaps, transcript-based silence/filler, retake removal) and the read → propose → confirm → execute → verify discipline. For "tighten this / remove dead air" reach here first (loudness, free); for "cut the ums" or "remove duplicate takes" use the transcript/retake tools.
