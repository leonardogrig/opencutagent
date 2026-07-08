import { getTimeline, ToolError, round3 } from "./util.js";
import { transcribeSourceRanges } from "../transcription/transcribe.js";
import { buildSegmentSummary } from "../transcription/segments.js";
import { sourceRangeToTimelineFrames, formatTimecode } from "../transcription/timecode.js";

const MAX_PHRASES = 200;

function mapRange(srcStart, srcEnd, clip, seq) {
  const r = sourceRangeToTimelineFrames(srcStart, srcEnd, clip, seq.timebase);
  if (!r) return null;
  return {
    startTC: formatTimecode(r.startFrame, seq.frameRate, seq.dropFrame),
    endTC: formatTimecode(r.endFrame, seq.frameRate, seq.dropFrame),
  };
}

export default {
  name: "ppro_identify_segments",
  description:
    "Transcribe a timeline clip's source audio (ElevenLabs Scribe, cached per source file) and return its spoken segments — phrases, silent gaps, and filler words — each mapped to TIMELINE timecodes. This is how you 'read' what is on the timeline before deciding cuts. Runs ffmpeg + Scribe; first call on a source can take a while, later calls are cached.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      clip_id: {
        type: "string",
        description: 'Clip id from ppro_get_timeline_state (e.g. "V1.2"), or "all" for every media clip. Defaults to "all".',
      },
      language: { type: "string", description: "Optional ISO code (e.g. 'en'). Omit to auto-detect." },
      num_speakers: { type: "integer", description: "Optional known speaker count; improves diarization." },
      refresh: { type: "boolean", description: "Re-transcribe even if cached (use if the source file changed)." },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const timeline = await getTimeline(ctx);
    const seq = timeline.sequence;

    let targets;
    if (!args.clip_id || args.clip_id === "all") {
      targets = timeline.clips.filter((c) => c.hasMedia && c.trackType === "video");
      if (targets.length === 0) targets = timeline.clips.filter((c) => c.hasMedia);
    } else {
      const c = timeline.clips.find((x) => x.id === args.clip_id);
      if (!c) {
        const ids = timeline.clips.map((x) => x.id).join(", ") || "(none)";
        throw new ToolError(`No clip "${args.clip_id}". Valid ids: ${ids}.`);
      }
      targets = [c];
    }
    if (targets.length === 0) {
      throw new ToolError("No clips with source media to transcribe on the timeline.");
    }

    const results = [];
    for (const clip of targets) {
      if (!clip.speedIsNormal) {
        results.push({ clip: clip.id, skipped: `non-100% speed (${clip.speed}x) — not supported in v1` });
        continue;
      }
      const { payload, cached, path } = await transcribeSourceRanges(
        clip.mediaPath,
        [{ start: clip.sourceIn.seconds, end: clip.sourceOut.seconds }], // only this clip's on-timeline window
        {
          cacheDir: ctx.cacheDir,
          language: args.language,
          numSpeakers: args.num_speakers,
          refresh: !!args.refresh,
        }
      );
      const words = payload.words || [];
      const { phrases, silences, fillers } = buildSegmentSummary(words);

      const visiblePhrases = [];
      for (const p of phrases) {
        const tc = mapRange(p.start, p.end, clip, seq);
        if (!tc) continue; // phrase trimmed off the timeline by the clip's in/out
        visiblePhrases.push({
          start: tc.startTC,
          end: tc.endTC,
          speaker: p.speaker != null ? `S${p.speaker}` : undefined,
          text: p.text,
        });
      }
      const visibleFillers = fillers
        .map((f) => ({ ...mapRange(f.start, f.end, clip, seq), text: f.text }))
        .filter((f) => f.startTC);
      const visibleSilences = silences
        .map((s) => ({ ...mapRange(s.start, s.end, clip, seq), duration: round3(s.duration) }))
        .filter((s) => s.startTC);

      const truncated = visiblePhrases.length > MAX_PHRASES;
      results.push({
        clip: clip.id,
        mediaFile: clip.mediaPath.split(/[\\\/]/).pop(),
        transcriptCached: cached,
        transcriptPath: path,
        phraseCount: visiblePhrases.length,
        silenceCount: visibleSilences.length,
        fillerCount: visibleFillers.length,
        fillersPreview: visibleFillers.slice(0, 25),
        phrases: truncated ? visiblePhrases.slice(0, MAX_PHRASES) : visiblePhrases,
        ...(truncated
          ? { note: `Showing first ${MAX_PHRASES} of ${visiblePhrases.length} phrases. Full word-level JSON at transcriptPath.` }
          : {}),
      });
    }

    return { sequence: seq.name, revision: ctx.state.revision, clips: results };
  },
};
