// Regenerates src/theme/fontdata/*.ts from public/fonts/*.woff2.
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
const out = join(root, "src", "theme", "fontdata");
mkdirSync(out, { recursive: true });

const FONTS = [
  { file: "Excalifont-Regular.woff2", module: "excalifont.ts", name: "EXCALIFONT_WOFF2", note: "Excalifont Regular (OFL-1.1), inlined so a render never makes a font request." },
  { file: "InterVariable.woff2", module: "inter.ts", name: "INTER_WOFF2", note: "Inter Variable (OFL-1.1), inlined so a render never reaches fonts.gstatic.com." },
];

for (const f of FONTS) {
  const b64 = readFileSync(join(root, "public", "fonts", f.file)).toString("base64");
  writeFileSync(
    join(out, f.module),
    `// GENERATED - do not edit by hand.\n// ${f.note}\n// Regenerate: node scripts/inline-fonts.mjs\nexport const ${f.name} = "data:font/woff2;base64,${b64}";\n`
  );
  console.log(`${f.module}: ${(b64.length / 1024).toFixed(1)} KB`);
}
