// Round-trip XML rebuild: instead of GENERATING a bare-bones xmeml from our own
// bookkeeping (rebuild.js — drops every effect/transform/level, the "my configs
// are gone" problem), have Premiere EXPORT the real sequence as FCP7 XML
// (exportXmlSequence host op → sequence.exportAsFinalCutProXML), surgically
// remove the cut ranges + shift everything left in that document, and reimport.
// Premiere is the author of the XML; we only edit timing numbers — every node
// we don't understand (Motion/opacity/volume <filter>s, transitions, labels,
// third-party metadata) passes through VERBATIM, so whatever FCP7 XML can carry
// survives the apply. Known ceiling: whatever Premiere itself cannot express in
// FCP7 XML (Lumetri, Essential Graphics, masks) is lossy in the EXPORT step —
// round-trip raises the floor from "nothing survives" to "everything the format
// carries survives", not to "everything survives".
//
// parseXml/serializeXml/transformXmeml are PURE (unit-tested in
// test/xmlRoundtrip.js); roundtripViaXml drives the export → transform → import.
//
// Known v1 limits (they throw; caller falls back to the generated rebuild, then razor):
//  - clipitems with transition-relative timing (<start>/<end> = -1 next to a transition)
//  - clipitems missing <start>/<end>/<in>
// Caveats accepted in v1: keyframe <when> values inside filters are passed
// through untouched (static values — the common case — are always correct;
// keyframed params on a clip that gets trimmed/split may land shifted),
// transitions overlapping a cut are dropped, and split clips re-link by a
// deterministic id suffix (an L-cut pair that splits unevenly may import unlinked).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { round3, callHostHealing } from "./tools/util.js";
import { makeRemovedBefore, keepSpans } from "./rebuild.js";

// ---------- minimal identity-preserving XML tree ----------
// Non-validating: elements keep their attribute string RAW; everything that is
// not an element (text, comments, CDATA, DOCTYPE, <?xml?>) is a raw node kept
// byte-for-byte. serialize(parse(x)) === x for well-formed machine output.

export function parseXml(str) {
  const root = { type: "el", tag: null, attrs: "", children: [], selfClosing: false };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const pushRaw = (text) => { if (text) top().children.push({ type: "raw", text }); };
  let i = 0;
  const n = str.length;
  while (i < n) {
    const lt = str.indexOf("<", i);
    if (lt === -1) { pushRaw(str.slice(i)); break; }
    if (lt > i) pushRaw(str.slice(i, lt));
    if (str.startsWith("<!--", lt)) {
      const end = str.indexOf("-->", lt);
      const stop = end === -1 ? n : end + 3;
      pushRaw(str.slice(lt, stop)); i = stop; continue;
    }
    if (str.startsWith("<![CDATA[", lt)) {
      const end = str.indexOf("]]>", lt);
      const stop = end === -1 ? n : end + 3;
      pushRaw(str.slice(lt, stop)); i = stop; continue;
    }
    if (str.startsWith("<!", lt) || str.startsWith("<?", lt)) {
      const end = str.indexOf(">", lt);
      const stop = end === -1 ? n : end + 1;
      pushRaw(str.slice(lt, stop)); i = stop; continue;
    }
    if (str[lt + 1] === "/") {
      const end = str.indexOf(">", lt);
      if (stack.length > 1) stack.pop();
      i = (end === -1 ? n : end + 1); continue;
    }
    // open tag — scan for '>' respecting quoted attribute values
    let j = lt + 1;
    let quote = null;
    while (j < n) {
      const ch = str[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      j++;
    }
    const selfClosing = str[j - 1] === "/";
    const inner = str.slice(lt + 1, selfClosing ? j - 1 : j);
    const m = inner.match(/^([^\s/>]+)([\s\S]*)$/);
    const el = { type: "el", tag: m ? m[1] : inner, attrs: m && m[2] ? m[2] : "", children: [], selfClosing };
    top().children.push(el);
    if (!selfClosing) stack.push(el);
    i = j + 1;
  }
  return root;
}

export function serializeXml(node) {
  if (node.type === "raw") return node.text;
  const inner = node.children.map(serializeXml).join("");
  if (node.tag == null) return inner;
  if (node.selfClosing && node.children.length === 0) return `<${node.tag}${node.attrs}/>`;
  return `<${node.tag}${node.attrs}>${inner}</${node.tag}>`;
}

const isEl = (n, tag) => n.type === "el" && n.tag === tag;
const childEl = (node, tag) => node.children.find((c) => isEl(c, tag)) || null;
const textOf = (el) => el.children.filter((c) => c.type === "raw").map((c) => c.text).join("");

function getNum(node, tag) {
  const el = childEl(node, tag);
  if (!el) return null;
  const v = parseInt(textOf(el).trim(), 10);
  return Number.isFinite(v) ? v : null;
}

function setText(node, tag, value) {
  const el = childEl(node, tag);
  if (!el) return false;
  el.children = [{ type: "raw", text: String(value) }];
  el.selfClosing = false;
  return true;
}

function cloneNode(n) {
  if (n.type === "raw") return { type: "raw", text: n.text };
  return { type: "el", tag: n.tag, attrs: n.attrs, children: n.children.map(cloneNode), selfClosing: n.selfClosing };
}

function getAttr(el, name) {
  const m = el.attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

function walkEls(node, cb) {
  for (const c of node.children) {
    if (c.type !== "el") continue;
    cb(c);
    walkEls(c, cb);
  }
}

/** First <tag> element in document order (outermost sequence beats nested ones). */
function findFirst(node, tag) {
  for (const c of node.children) {
    if (c.type !== "el") continue;
    if (c.tag === tag) return c;
    const hit = findFirst(c, tag);
    if (hit) return hit;
  }
  return null;
}

function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ---------- timing surgery ----------

const TICKS_PER_SEC = 254016000000n;

/** Integer ticks per frame for the sequence rate, or null (then pproTicks* are stripped). */
export function ticksPerFrame(timebase, ntsc) {
  if (!timebase || timebase <= 0) return null;
  const num = ntsc ? TICKS_PER_SEC * 1001n : TICKS_PER_SEC;
  const den = ntsc ? BigInt(timebase) * 1000n : BigInt(timebase);
  return num % den === 0n ? num / den : null;
}

// Premiere's export carries pproTicksIn/Out alongside <in>/<out>; a stale ticks
// value would win over our edited frames on import, so recompute or REMOVE.
function setTicks(el, tag, frames, tpf) {
  const t = childEl(el, tag);
  if (!t) return;
  if (tpf != null) setText(el, tag, (BigInt(frames) * tpf).toString());
  else el.children = el.children.filter((c) => c !== t);
}

/** Append a deterministic suffix to the clone's own id and every linkclipref it
 *  carries: linked V/A partners split identically (cuts are timeline-global),
 *  so piece k of each re-links to piece k of the other. */
function suffixIds(el, suffix) {
  if (getAttr(el, "id") != null) {
    el.attrs = el.attrs.replace(/((?:^|\s)id\s*=\s*")([^"]*)(")/, (_, a, id, b) => `${a}${id}${suffix}${b}`);
  }
  walkEls(el, (d) => {
    if (d.tag === "linkclipref") d.children = [{ type: "raw", text: textOf(d) + suffix }];
  });
}

function retimeClipitem(node, cuts, removedBefore, tpf, stats, seqTimebase) {
  const id = getAttr(node, "id") || "?";
  const cs = getNum(node, "start");
  const ce = getNum(node, "end");
  const cin = getNum(node, "in");
  if (cs == null || ce == null || cin == null) {
    throw new Error(`clipitem ${id} is missing start/end/in — cannot retime`);
  }
  if (cs < 0 || ce < 0) {
    throw new Error(`clipitem ${id} has transition-relative timing (start/end = -1) — not supported`);
  }
  // <in>/<out> count frames in the clipitem's OWN rate while <start>/<end> are
  // sequence frames; the surgery below assumes the two match. A mixed-rate
  // item would be silently mis-retimed, so refuse like the other v1 limits
  // (the caller falls back down the apply ladder).
  const ownRate = childEl(node, "rate");
  const ownTimebase = ownRate ? getNum(ownRate, "timebase") : null;
  if (ownTimebase != null && seqTimebase != null && ownTimebase !== seqTimebase) {
    throw new Error(`clipitem ${id} rate (timebase ${ownTimebase}) differs from the sequence (${seqTimebase}); not supported`);
  }
  const spans = keepSpans(cs, ce, cuts);
  if (spans.length === 0) { stats.removedClips++; return []; }
  if (spans.length > 1) stats.splitClips++;
  else if (spans[0][0] !== cs || spans[0][1] !== ce) stats.trimmedClips++;

  const out = [];
  spans.forEach(([a, b], k) => {
    const el = k === 0 ? node : cloneNode(node);
    if (k > 0) suffixIds(el, `-p${k + 1}`);
    const newStart = a - removedBefore(a);
    const newIn = cin + (a - cs);
    const newOut = cin + (b - cs);
    setText(el, "start", newStart);
    setText(el, "end", newStart + (b - a));
    setText(el, "in", newIn);
    setText(el, "out", newOut);
    setTicks(el, "pproTicksIn", newIn, tpf);
    setTicks(el, "pproTicksOut", newOut, tpf);
    stats.clipitems++;
    out.push({ node: el, end: newStart + (b - a) });
  });
  return out;
}

/** Shift a transition clear of any cut; drop it when a cut overlaps its span. */
function retimeTransition(node, cuts, removedBefore, stats) {
  const ts = getNum(node, "start");
  const te = getNum(node, "end");
  if (ts == null || te == null) return true; // malformed — pass through untouched
  for (const c of cuts) {
    if (c.startFrame < te && c.endFrame > ts) { stats.transitionsDropped++; return false; }
  }
  const shift = removedBefore(ts);
  setText(node, "start", ts - shift);
  setText(node, "end", te - shift);
  return true;
}

// Full <file> defs appear once, later refs are <file id="x"/>. Deleting the
// clipitem that held the only full def would leave dangling refs → the first
// SURVIVING occurrence of each id gets the full def, all later ones become refs.
function normalizeFileDefs(root, defs) {
  const seen = new Set();
  walkEls(root, (el) => {
    if (el.tag !== "file") return;
    const id = getAttr(el, "id");
    if (!id) return;
    if (!seen.has(id)) {
      seen.add(id);
      const hasDef = el.children.some((c) => c.type === "el");
      const def = defs.get(id);
      if (!hasDef && def) {
        el.attrs = def.attrs;
        el.children = def.children.map(cloneNode);
        el.selfClosing = false;
      }
    } else {
      el.children = [];
      el.selfClosing = true;
    }
  });
}

/**
 * Remove the merged, ascending cut ranges (frames, sequence timebase) from an
 * exported xmeml document and compact everything left — the round-trip core.
 * Pure. Returns { xml, stats }.
 */
export function transformXmeml(xmlString, cuts, { sequenceName } = {}) {
  const doc = parseXml(xmlString);
  const seq = findFirst(doc, "sequence");
  if (!seq) throw new Error("Exported XML has no <sequence>.");

  if (sequenceName) setText(seq, "name", escXml(sequenceName));
  // A duplicated uuid would collide with the source sequence on import.
  seq.children = seq.children.filter((c) => !isEl(c, "uuid"));

  const rate = childEl(seq, "rate");
  const timebase = rate ? getNum(rate, "timebase") : null;
  const ntscEl = rate ? childEl(rate, "ntsc") : null;
  const tpf = ticksPerFrame(timebase, ntscEl ? /TRUE/i.test(textOf(ntscEl)) : false);

  // collect full <file> defs BEFORE any clipitem (and its def) is deleted
  const defs = new Map();
  walkEls(doc, (el) => {
    const id = el.tag === "file" ? getAttr(el, "id") : null;
    if (id && !defs.has(id) && el.children.some((c) => c.type === "el")) defs.set(id, el);
  });

  const removedBefore = makeRemovedBefore(cuts);
  const stats = { clipitems: 0, removedClips: 0, splitClips: 0, trimmedClips: 0, transitionsDropped: 0, markersDropped: 0 };
  let maxEnd = 0;

  const media = childEl(seq, "media");
  if (!media) throw new Error("Exported XML has no <media>.");
  for (const mt of ["video", "audio"]) {
    const group = childEl(media, mt);
    if (!group) continue;
    const tracks = [];
    (function collect(node) {
      for (const c of node.children) {
        if (isEl(c, "track")) tracks.push(c);
      }
    })(group);
    for (const track of tracks) {
      const next = [];
      for (const node of track.children) {
        if (isEl(node, "clipitem")) {
          for (const piece of retimeClipitem(node, cuts, removedBefore, tpf, stats, timebase)) {
            next.push(piece.node);
            if (piece.end > maxEnd) maxEnd = piece.end;
          }
        } else if (isEl(node, "transitionitem")) {
          if (retimeTransition(node, cuts, removedBefore, stats)) next.push(node);
        } else {
          next.push(node);
        }
      }
      track.children = next;
    }
  }

  // sequence markers: drop the ones inside a cut, shift the rest
  seq.children = seq.children.filter((c) => {
    if (!isEl(c, "marker")) return true;
    const min = getNum(c, "in");
    if (min == null) return true;
    if (cuts.some((cut) => min >= cut.startFrame && min < cut.endFrame)) { stats.markersDropped++; return false; }
    const shift = removedBefore(min);
    setText(c, "in", min - shift);
    const mout = getNum(c, "out");
    if (mout != null && mout >= 0) setText(c, "out", Math.max(min - shift, mout - removedBefore(mout)));
    return true;
  });

  setText(seq, "duration", maxEnd);
  normalizeFileDefs(doc, defs);

  const removedFrames = cuts.reduce((s, c) => s + (c.endFrame - c.startFrame), 0);
  return { xml: serializeXml(doc), stats: { ...stats, removedFrames, durationFrames: maxEnd } };
}

/**
 * Export the live sequence via Premiere, transform, reimport. Same contract as
 * rebuildViaXml (throws → caller falls back); preserves everything FCP7 XML carries.
 */
export async function roundtripViaXml(ctx, timeline, cuts, { onProgress = () => {} } = {}) {
  const seq = timeline.sequence;
  const sequenceName = `${seq.name} - tightened`;
  const dir = join(ctx.cacheDir, "rebuild");
  mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const exportPath = join(dir, `export-${stamp}.xml`);

  onProgress("Exporting the sequence as XML…");
  const ex = await callHostHealing(ctx, "exportXmlSequence", { path: exportPath }, { timeoutMs: 300000 });
  if (!ex || !ex.ok) throw new Error(`Premiere did not export the sequence XML${ex && ex.error ? `: ${ex.error}` : "."}`);

  onProgress("Removing the cuts from the XML…");
  const source = readFileSync(exportPath, "utf8");
  const { xml, stats } = transformXmeml(source, cuts, { sequenceName });
  if (stats.clipitems === 0) throw new Error("Round-trip rebuild produced an empty sequence.");
  const file = join(dir, `${sequenceName.replace(/[^\w.-]+/g, "_")}-rt-${stamp}.xml`);
  writeFileSync(file, xml);

  onProgress("Importing tightened sequence into Premiere…");
  const r = await callHostHealing(ctx, "importXmlSequence", { path: file, sequenceName }, { timeoutMs: 300000 });
  if (!r || !r.ok) throw new Error(`Premiere did not import the round-trip XML${r && r.error ? `: ${r.error}` : "."}`);
  return {
    sequenceName: r.sequenceName || sequenceName,
    opened: !!r.opened,
    clipitems: stats.clipitems,
    removedSec: round3(stats.removedFrames / seq.frameRate),
    xmlPath: file,
    roundtrip: true,
    stats,
  };
}
