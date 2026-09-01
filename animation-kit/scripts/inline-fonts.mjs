// Regenerates the inlined font modules (src/theme/fontdata/*.ts and any
// style package's src/fontdata/*.ts) from their .woff2 sources.
//
// The renders inline their fonts as data: URIs instead of fetching them,
// because a font REQUEST is the single most common way a long render dies: the
// @remotion/fonts loader blocks the frame with delayRender(), and a request
// that stalls (a recycled browser tab, Remotion's static server under six
// concurrent 4K tabs, or an offline machine reaching fonts.gstatic.com) trips
// the frame timeout and kills the whole render thousands of frames in.
// A data: URI cannot stall.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// { file, module, name, note, srcDir?, outDir? } — srcDir/outDir default to the
// engine's public/fonts and src/theme/fontdata. Style packages keep their own
// sources under styles/<id>/fonts and generate into styles/<id>/src/fontdata.
const FONTS = [
  { file: "Excalifont-Regular.woff2", module: "excalifont.ts", name: "EXCALIFONT_WOFF2", note: "Excalifont Regular (OFL-1.1), inlined so a render never makes a font request." },
  { file: "InterVariable.woff2", module: "inter.ts", name: "INTER_WOFF2", note: "Inter Variable (OFL-1.1), inlined so a render never reaches fonts.gstatic.com." },
  {
    file: "InterTight-latin.woff2", module: "interTight.ts", name: "INTER_TIGHT_WOFF2",
    note: "Inter Tight Variable, latin subset (OFL-1.1). Stand-in for EK Baumer Grotesk in the n8n brand style; inlined so a render never makes a font request.",
    srcDir: join("styles", "n8n-brand", "fonts"), outDir: join("styles", "n8n-brand", "src", "fontdata"),
  },
  {
    file: "GeistMono-latin.woff2", module: "geistMono.ts", name: "GEIST_MONO_WOFF2",
    note: "Geist Mono Variable, latin subset (OFL-1.1). Stand-in for EK Baumer Mono in the n8n brand style; inlined so a render never makes a font request.",
    srcDir: join("styles", "n8n-brand", "fonts"), outDir: join("styles", "n8n-brand", "src", "fontdata"),
  },
];

for (const f of FONTS) {
  const srcDir = join(root, f.srcDir ?? join("public", "fonts"));
  const outDir = join(root, f.outDir ?? join("src", "theme", "fontdata"));
  mkdirSync(outDir, { recursive: true });
  const b64 = readFileSync(join(srcDir, f.file)).toString("base64");
  writeFileSync(
    join(outDir, f.module),
    `// GENERATED - do not edit by hand.\n// ${f.note}\n// Regenerate: node scripts/inline-fonts.mjs\nexport const ${f.name} = "data:font/woff2;base64,${b64}";\n`
  );
  console.log(`${f.module}: ${(b64.length / 1024).toFixed(1)} KB`);
}
