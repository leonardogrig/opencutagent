// TimeBolt-style fast apply: instead of razoring the LIVE timeline (thousands
// of per-item DOM ops — O(cuts × clips), minutes to hours), build the FINISHED
// tightened sequence as FCP7 XML (xmeml) and let Premiere import it in ONE
// native operation (seconds, regardless of cut count). The original sequence
// is never touched — "undo" is simply deleting the imported sequence.
//
// computeKeepLayout + buildXmeml are PURE (unit-tested in test/xmlRebuild.js);
// rebuildViaXml writes the file and drives the importXmlSequence host op.
//
// Known v1 limits (they throw, and the caller falls back to the razor path):
//  - any timeline item without source media (titles/graphics/adjustment layers)
//  - any non-100%-speed clip (xmeml speed filters aren't emitted)
// Effects/grades on timeline clips do NOT travel through xmeml by design.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { round3, callHostHealing } from "./tools/util.js";

/** Frames removed strictly before timeline frame f (cuts ascending, merged). */
export function makeRemovedBefore(cuts) {
  const n = cuts.length;
  const prefix = new Array(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + (cuts[i].endFrame - cuts[i].startFrame);
  return function removedBefore(f) {
    let lo = 0,
      hi = n; // first cut with endFrame > f
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cuts[mid].endFrame <= f) lo = mid + 1;
      else hi = mid;
    }
    let rem = prefix[lo];
    if (lo < n && cuts[lo].startFrame < f) rem += f - cuts[lo].startFrame; // straddling cut counts partially
    return rem;
  };
}

/** Subtract cuts from [cs,ce) → kept sub-spans (frames). */
export function keepSpans(cs, ce, cuts) {
  const spans = [];
  let cur = cs;
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    if (c.endFrame <= cs) continue;
    if (c.startFrame >= ce) break;
    if (c.startFrame > cur) spans.push([cur, Math.min(c.startFrame, ce)]);
    cur = Math.max(cur, Math.min(c.endFrame, ce));
  }
  if (cur < ce) spans.push([cur, ce]);
  return spans;
}

/**
 * Compute the tightened layout: every clip minus the cut ranges, compacted
 * left by the cut time removed before it. Cuts span ALL tracks (that is what
 * both the silence and retake flows produce), so the shift is global and
 * audio/video stay in sync by construction. Pre-existing gaps are preserved.
 * Pure; frames throughout (ints from getTimeline's BigInt-exact conversion).
 */
export function computeKeepLayout(timeline, cuts) {
  const unsupported = [];
  for (const clip of timeline.clips) {
    if (!clip.hasMedia) unsupported.push(`${clip.id} "${clip.name}" has no source media (title/graphic?)`);
    else if (!clip.speedIsNormal) unsupported.push(`${clip.id} "${clip.name}" is ${clip.speed}x speed`);
  }
  if (unsupported.length) {
    throw new Error(`XML rebuild can't represent: ${unsupported.slice(0, 3).join("; ")}${unsupported.length > 3 ? ` (+${unsupported.length - 3} more)` : ""}`);
  }

  const removedBefore = makeRemovedBefore(cuts);
  const items = [];
  let durationFrames = 0;
  for (const clip of timeline.clips) {
    const cs = clip.start.frame;
    const ce = clip.end.frame;
    for (const [a, b] of keepSpans(cs, ce, cuts)) {
      const newStart = a - removedBefore(a);
      const len = b - a;
      items.push({
        trackType: clip.trackType,
        trackIndex: clip.trackIndex,
        name: clip.name,
        mediaPath: clip.mediaPath,
        srcIn: clip.sourceIn.frame + (a - cs),
        srcOut: clip.sourceIn.frame + (a - cs) + len,
        start: newStart,
        end: newStart + len,
        origStart: a,
        origEnd: b,
      });
      if (newStart + len > durationFrames) durationFrames = newStart + len;
    }
  }
  const removedFrames = cuts.reduce((s, c) => s + (c.endFrame - c.startFrame), 0);
  return { items, durationFrames, removedFrames };
}

function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function pathUrl(p) {
  // file://localhost + percent-encoded POSIX path (xmeml convention)
  return "file://localhost" + encodeURI(p).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

/**
 * Emit FCP7 XML (xmeml v4) for the tightened sequence. Ints throughout; rate =
 * integer timebase + ntsc flag (TRUE only for true /1.001 rates — a 30.00003
 * "30fps" sequence is timebase 30, ntsc FALSE, matching detectDropFrame).
 * Video/audio clipitems cut from the same source span are <link>ed so they
 * move together when hand-edited afterward.
 */
export function buildXmeml({ sequenceName, fps, width, height, layout, videoTrackCount, audioTrackCount }) {
  const nominal = Math.round(fps);
  const ntsc = Math.abs(fps * 1.001 - nominal) < 0.01 ? "TRUE" : "FALSE";
  const RATE = `<rate><timebase>${nominal}</timebase><ntsc>${ntsc}</ntsc></rate>`;

  // Widen the track counts to cover every item: an undercounted host value
  // would otherwise silently drop the clips on the missing tracks from the
  // emitted sequence (the empty-sequence guard checks layout items, not
  // emitted clipitems, so nothing would throw).
  for (const it of layout.items) {
    if (it.trackType === "video") videoTrackCount = Math.max(videoTrackCount, it.trackIndex + 1);
    else if (it.trackType === "audio") audioTrackCount = Math.max(audioTrackCount, it.trackIndex + 1);
  }

  // stable ids + per-track order
  const fileIds = new Map(); // mediaPath -> file-N
  const byTrack = new Map(); // "video:0" -> items
  for (const it of layout.items) {
    const key = `${it.trackType}:${it.trackIndex}`;
    if (!byTrack.has(key)) byTrack.set(key, []);
    byTrack.get(key).push(it);
  }
  let clipSeq = 0;
  const groups = new Map(); // mediaPath|origStart|origEnd -> members (for <link>)
  for (const [, items] of byTrack) {
    items.sort((x, y) => x.start - y.start);
    items.forEach((it, i) => {
      it.id = `clipitem-${++clipSeq}`;
      it.clipindex = i + 1;
      const gk = `${it.mediaPath}|${it.origStart}|${it.origEnd}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(it);
    });
  }

  const fileDef = (mediaPath) => {
    if (fileIds.has(mediaPath)) return `<file id="${fileIds.get(mediaPath)}"/>`;
    const id = `file-${fileIds.size + 1}`;
    fileIds.set(mediaPath, id);
    const base = mediaPath.split(/[\\\/]/).pop();
    return (
      `<file id="${id}"><name>${escXml(base)}</name><pathurl>${escXml(pathUrl(mediaPath))}</pathurl>${RATE}` +
      `<media><video><samplecharacteristics><width>${width}</width><height>${height}</height></samplecharacteristics></video>` +
      `<audio><channelcount>2</channelcount></audio></media></file>`
    );
  };

  const linkBlock = (it) => {
    const gk = `${it.mediaPath}|${it.origStart}|${it.origEnd}`;
    const members = groups.get(gk) || [];
    if (members.length < 2) return "";
    return members
      .map(
        (m) =>
          `<link><linkclipref>${m.id}</linkclipref><mediatype>${m.trackType}</mediatype>` +
          `<trackindex>${m.trackIndex + 1}</trackindex><clipindex>${m.clipindex}</clipindex></link>`
      )
      .join("");
  };

  const clipitem = (it) => {
    const source = it.trackType === "audio" ? `<sourcetrack><mediatype>audio</mediatype><trackindex>${it.trackIndex + 1}</trackindex></sourcetrack>` : "";
    return (
      `<clipitem id="${it.id}"><name>${escXml(it.name)}</name><enabled>TRUE</enabled>` +
      `<duration>${it.end - it.start}</duration>${RATE}` +
      `<start>${it.start}</start><end>${it.end}</end><in>${it.srcIn}</in><out>${it.srcOut}</out>` +
      fileDef(it.mediaPath) +
      source +
      linkBlock(it) +
      `</clipitem>`
    );
  };

  const tracks = (type, count) => {
    let out = "";
    for (let i = 0; i < count; i++) {
      const items = byTrack.get(`${type}:${i}`) || [];
      out += `<track>${items.map(clipitem).join("")}</track>`;
    }
    return out;
  };

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">` +
    `<sequence id="sequence-1"><name>${escXml(sequenceName)}</name>` +
    `<duration>${layout.durationFrames}</duration>${RATE}` +
    `<media><video><format><samplecharacteristics>${RATE}<width>${width}</width><height>${height}</height></samplecharacteristics></format>` +
    tracks("video", videoTrackCount) +
    `</video><audio>` +
    tracks("audio", audioTrackCount) +
    `</audio></media></sequence></xmeml>\n`
  );
}

/**
 * Build + write the xmeml and have Premiere import/open it. Throws on any
 * unsupported timeline (caller falls back to the razor path).
 */
export async function rebuildViaXml(ctx, timeline, cuts, { onProgress = () => {} } = {}) {
  const seq = timeline.sequence;
  onProgress("Building tightened sequence…");
  const layout = computeKeepLayout(timeline, cuts);
  if (layout.items.length === 0) throw new Error("Rebuild produced an empty sequence.");
  const sequenceName = `${seq.name} - tightened`;
  const size = seq.frameSize || { width: 1920, height: 1080 };
  const xml = buildXmeml({
    sequenceName,
    fps: seq.frameRate,
    width: size.width,
    height: size.height,
    layout,
    videoTrackCount: seq.videoTrackCount || 1,
    audioTrackCount: seq.audioTrackCount || 1,
  });

  const dir = join(ctx.cacheDir, "rebuild");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sequenceName.replace(/[^\w.-]+/g, "_")}-${Date.now()}.xml`);
  writeFileSync(file, xml);

  onProgress("Importing tightened sequence into Premiere…");
  const r = await callHostHealing(ctx, "importXmlSequence", { path: file, sequenceName }, { timeoutMs: 300000 });
  if (!r || !r.ok) throw new Error(`Premiere did not import the generated XML${r && r.error ? `: ${r.error}` : "."}`);
  return {
    sequenceName: r.sequenceName || sequenceName,
    opened: !!r.opened,
    clipitems: layout.items.length,
    removedSec: round3(layout.removedFrames / seq.frameRate),
    xmlPath: file,
  };
}
