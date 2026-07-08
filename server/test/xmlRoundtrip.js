// Checks for the ROUND-TRIP XML rebuild (no Premiere): identity-preserving
// parse/serialize, timing surgery on an exported-style xmeml (split/trim/delete,
// pproTicks recompute, filter passthrough, link re-suffixing, file-def rescue,
// transitions, markers), and the applyRangesBatched routing (round-trip first).
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseXml, serializeXml, transformXmeml, ticksPerFrame } from "../roundtrip.js";
import { applyRangesBatched } from "../silences.js";

let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

// An exported-style document: uuid, markers, a keyframed-ish filter, pproTicks,
// full <file> def + ref, links, a comment — the stuff Premiere's export carries
// and our generated rebuild does not.
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
<sequence id="sequence-1" explodedTracks="true">
<uuid>aaaa-bbbb-cccc</uuid>
<name>My Seq</name>
<duration>900</duration>
<rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
<marker><name>m1</name><in>100</in><out>-1</out></marker>
<marker><name>m2</name><in>180</in><out>-1</out></marker>
<marker><name>m3</name><in>700</in><out>-1</out></marker>
<media>
<video>
<format><samplecharacteristics><width>2560</width><height>1440</height></samplecharacteristics></format>
<track>
<!-- exported by Premiere -->
<clipitem id="clipitem-1">
<name>rec.mp4</name>
<enabled>TRUE</enabled>
<duration>3600</duration>
<start>0</start><end>900</end><in>300</in><out>1200</out>
<pproTicksIn>2540160000000</pproTicksIn><pproTicksOut>10160640000000</pproTicksOut>
<file id="file-1"><name>rec.mp4</name><pathurl>file://localhost/x/rec.mp4</pathurl></file>
<filter><effect><name>Basic Motion</name><parameter><parameterid>scale</parameterid><value>133</value></parameter></effect></filter>
<link><linkclipref>clipitem-1</linkclipref><mediatype>video</mediatype></link>
<link><linkclipref>clipitem-2</linkclipref><mediatype>audio</mediatype></link>
</clipitem>
</track>
</video>
<audio>
<track>
<clipitem id="clipitem-2">
<name>rec.mp4</name>
<start>0</start><end>900</end><in>300</in><out>1200</out>
<file id="file-1"/>
<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
<filter><effect><name>Audio Levels</name><parameter><parameterid>level</parameterid><value>0.7</value></parameter></effect></filter>
<link><linkclipref>clipitem-1</linkclipref><mediatype>video</mediatype></link>
<link><linkclipref>clipitem-2</linkclipref><mediatype>audio</mediatype></link>
</clipitem>
</track>
</audio>
</media>
</sequence>
</xmeml>
`;

// --- parse/serialize identity ---
check("serialize(parse(x)) === x", serializeXml(parseXml(FIXTURE)) === FIXTURE, null);
const oddball = `<?xml version="1.0"?><!DOCTYPE xmeml><a b="c>d" e='f'><!-- <not a tag> --><![CDATA[ <raw> & stuff ]]><empty/>text &amp; entity</a>`;
check("identity through comments/CDATA/quoted '>' in attrs", serializeXml(parseXml(oddball)) === oddball, serializeXml(parseXml(oddball)));

// --- ticksPerFrame ---
check("tpf 30 non-ntsc = 8467200000", ticksPerFrame(30, false) === 8467200000n, ticksPerFrame(30, false));
check("tpf 30 ntsc (29.97) = 8475667200", ticksPerFrame(30, true) === 8475667200n, ticksPerFrame(30, true));

// --- the transform: cuts [150,210) + [600,660) on a [0,900) clip ---
const CUTS = [
  { startFrame: 150, endFrame: 210 },
  { startFrame: 600, endFrame: 660 },
];
const { xml, stats } = transformXmeml(FIXTURE, CUTS, { sequenceName: "My Seq - tightened" });

check("renamed + uuid removed", /<name>My Seq - tightened<\/name>/.test(xml) && !/uuid/.test(xml), xml.match(/<name>[^<]*/g));
check("stats: 6 clipitems (3 per track), 2 splits", stats.clipitems === 6 && stats.splitClips === 2 && stats.removedClips === 0, stats);
check("sequence duration → 780", /<duration>780<\/duration>/.test(xml.match(/<sequence[\s\S]*?<media>/)[0]), null);

// piece timing: [0,150) stays; [210,600)→150 src 510; [660,900)→540 src 960
check("piece 1 unchanged", /<start>0<\/start><end>150<\/end><in>300<\/in><out>450<\/out>/.test(xml), null);
check("piece 2 compacted", /<start>150<\/start><end>540<\/end><in>510<\/in><out>900<\/out>/.test(xml), null);
check("piece 3 compacted", /<start>540<\/start><end>780<\/end><in>960<\/in><out>1200<\/out>/.test(xml), null);

// clone ids + symmetric link rewrite (V piece2 ↔ A piece2)
check("clone ids suffixed", /<clipitem id="clipitem-1-p2">/.test(xml) && /<clipitem id="clipitem-2-p3">/.test(xml), xml.match(/<clipitem id="[^"]*"/g));
const vP2 = xml.match(/<clipitem id="clipitem-1-p2">[\s\S]*?<\/clipitem>/)[0];
check("clone links re-suffixed to partner clone", /<linkclipref>clipitem-2-p2<\/linkclipref>/.test(vP2) && /<linkclipref>clipitem-1-p2<\/linkclipref>/.test(vP2), vP2.match(/<linkclipref>[^<]*/g));

// effects survive on every piece — the whole point of the round-trip
check("Motion filter on all 3 video pieces", (xml.match(/<parameterid>scale<\/parameterid><value>133<\/value>/g) || []).length === 3, null);
check("audio level filter on all 3 audio pieces", (xml.match(/<parameterid>level<\/parameterid><value>0\.7<\/value>/g) || []).length === 3, null);
check("comment preserved verbatim", /<!-- exported by Premiere -->/.test(xml), null);

// pproTicks recomputed from the new in/out (stale ticks would win on import)
check("pproTicksIn piece 2 = 510 frames", /<pproTicksIn>4318272000000<\/pproTicksIn>/.test(xml), xml.match(/<pproTicksIn>[^<]*/g));
check("pproTicksOut piece 3 = 1200 frames", /<pproTicksOut>10160640000000<\/pproTicksOut>/.test(xml), xml.match(/<pproTicksOut>[^<]*/g));

// file def: first surviving occurrence keeps the full def, every later one is a ref
check("one full file def, rest refs", (xml.match(/<file id="file-1"><name>/g) || []).length === 1 && (xml.match(/<file id="file-1"\/>/g) || []).length === 5, xml.match(/<file[^>]*>/g));

// markers: inside-a-cut dropped, others shifted
check("marker in cut dropped, m3 shifted 700→580, m1 stays", !/m2/.test(xml) && /<name>m3<\/name><in>580<\/in>/.test(xml) && /<name>m1<\/name><in>100<\/in>/.test(xml), xml.match(/<marker>[\s\S]*?<\/marker>/g));
check("stats counts dropped marker", stats.markersDropped === 1, stats);

// --- file-def rescue: the clip HOLDING the def is fully cut, a ref survives ---
const RESCUE = `<xmeml version="4"><sequence><name>S</name><duration>200</duration><rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate><media><video><track><clipitem id="c1"><start>0</start><end>100</end><in>0</in><out>100</out><file id="f1"><name>a.mp4</name><pathurl>file://localhost/a.mp4</pathurl></file></clipitem><clipitem id="c2"><start>100</start><end>200</end><in>100</in><out>200</out><file id="f1"/></clipitem></track></video></media></sequence></xmeml>`;
const rescue = transformXmeml(RESCUE, [{ startFrame: 0, endFrame: 100 }], {});
check("deleted clip's file def rescued into the survivor", /<clipitem id="c2">.*<file id="f1"><name>a\.mp4<\/name>/.test(rescue.xml) && rescue.stats.removedClips === 1, rescue.xml);
check("survivor compacted to 0", /<start>0<\/start><end>100<\/end><in>100<\/in><out>200<\/out>/.test(rescue.xml), rescue.xml);

// --- transitions: overlapping a cut → dropped; clear of cuts → shifted ---
const TRANS = `<xmeml version="4"><sequence><name>S</name><duration>900</duration><rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate><media><video><track><clipitem id="c1"><start>0</start><end>300</end><in>0</in><out>300</out><file id="f1"><name>a</name></file></clipitem><transitionitem><start>290</start><end>310</end><alignment>center</alignment></transitionitem><clipitem id="c2"><start>310</start><end>900</end><in>310</in><out>900</out><file id="f1"/></clipitem></track></video></media></sequence></xmeml>`;
const tShift = transformXmeml(TRANS, [{ startFrame: 0, endFrame: 60 }], {});
check("transition clear of cut shifts with the ripple", /<transitionitem><start>230<\/start><end>250<\/end>/.test(tShift.xml) && tShift.stats.transitionsDropped === 0, tShift.xml.match(/<transitionitem>[\s\S]*?<\/transitionitem>/));
const tDrop = transformXmeml(TRANS, [{ startFrame: 300, endFrame: 400 }], {});
check("transition overlapping a cut is dropped", !/transitionitem/.test(tDrop.xml) && tDrop.stats.transitionsDropped === 1, tDrop.stats);

// --- v1 refusals throw (caller falls back) ---
let threw = "";
const NEG = TRANS.replace("<start>0</start><end>300</end>", "<start>-1</start><end>-1</end>");
try { transformXmeml(NEG, [{ startFrame: 0, endFrame: 60 }], {}); } catch (e) { threw = e.message; }
check("transition-relative (-1) clipitem rejected", /transition-relative/.test(threw), threw);
threw = "";
try { transformXmeml("<xmeml><foo/></xmeml>", CUTS, {}); } catch (e) { threw = e.message; }
check("no <sequence> rejected", /no <sequence>/.test(threw), threw);

// --- routing: round-trip is the preferred fast path ---
const TIMELINE = {
  sequence: { name: "My Seq", frameRate: 30, dropFrame: false, videoTrackCount: 1, audioTrackCount: 1, frameSize: { width: 2560, height: 1440 } },
  clips: [],
  gaps: [],
};
function makeCtx(onCall) {
  const calls = [];
  return {
    calls,
    cacheDir: mkdtempSync(join(tmpdir(), "ea-roundtrip-")),
    bridge: {
      callHost: async (action, params) => {
        calls.push({ action, ...params });
        if (onCall) { const r = onCall(action, params); if (r) return r; }
        if (action === "exportXmlSequence") { writeFileSync(params.path, FIXTURE); return { ok: true, path: params.path }; }
        if (action === "importXmlSequence") return { ok: true, sequenceName: params.sequenceName, opened: true, imported: 1 };
        return { ok: true };
      },
      notifyPanel: () => {},
    },
    state: { revision: 0 },
  };
}

const ctxR = makeCtx();
const rr = await applyRangesBatched(ctxR, CUTS.map((c) => ({ ...c })), { ripple: true, fps: 30, timeline: TIMELINE, rebuildMin: 1 });
check("routed export → import, no razor ops", ctxR.calls.map((c) => c.action).join(",") === "exportXmlSequence,importXmlSequence", ctxR.calls.map((c) => c.action));
check("result: roundtrip rebuild, applied 2, ~4s", rr.rebuild === true && rr.roundtrip === true && rr.applied === 2 && Math.abs(rr.appliedSec - 4) < 1e-6, rr);
const imp = ctxR.calls.find((c) => c.action === "importXmlSequence");
check("transformed xml written: renamed, effects intact", existsSync(imp.path) && /My Seq - tightened/.test(readFileSync(imp.path, "utf8")) && /<value>133<\/value>/.test(readFileSync(imp.path, "utf8")), imp.path);

// export failure → falls back to the GENERATED rebuild (which needs timeline clips → none here → razor)
const ctxF = makeCtx((action) => { if (action === "exportXmlSequence") throw new Error("export blew up"); });
const rf = await applyRangesBatched(ctxF, CUTS.map((c) => ({ ...c })), { ripple: true, fps: 30, timeline: TIMELINE, rebuildMin: 1 });
check("export failure falls through (no roundtrip result)", !rf.roundtrip, rf);
check("fallback chain reached the razor path", ctxF.calls.some((c) => c.action === "removeRangesBatch"), ctxF.calls.map((c) => c.action));

console.log(failures === 0 ? "\nAll xml-roundtrip checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
