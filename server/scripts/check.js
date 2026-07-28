// Syntax-check every .js/.mjs file in server/ (recursively, skipping
// node_modules) with `node --check`, then scan for calls to helpers that are
// exported somewhere in the tree but never imported or declared in the file
// doing the calling. Self-maintaining replacement for a hand-listed chain in
// package.json: new files are covered automatically.
//
// The second pass exists because `node --check` only parses: a dropped import
// is perfectly valid syntax and only blows up as a ReferenceError at runtime,
// on whichever line happens to use it (shipped once already: render.js kept
// calling liveEnv() after its import was removed, so every animation render
// died at the timeout lookup).
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".cache", "out"]);

function collect(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) collect(full, files);
    } else if (/\.(js|mjs)$/.test(name)) {
      files.push(full);
    }
  }
  return files;
}

const files = collect(root);
let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (res.status !== 0) {
    failed++;
    console.error(`FAIL ${file}\n${res.stderr.trim()}`);
  }
}
console.log(`${files.length - failed}/${files.length} files pass syntax check`);

/* ---------- missing-import scan ---------- */

// Comments and string/template literals are stripped first so prose like
// "see tools/util.js getTimeline()" can't look like a call.
function stripNonCode(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) { if (src[i] === "\\") i++; i++; }
      i++;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const sources = new Map(files.map((f) => [f, stripNonCode(readFileSync(f, "utf8"))]));

const exported = new Set();
for (const src of sources.values()) {
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) exported.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g)) exported.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) exported.add(name);
    }
  }
}

let missing = 0;
for (const [file, src] of sources) {
  const known = new Set();
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s*""/g)) {
    for (const part of m[1].replace(/[{}]/g, " ").split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name && name !== "*") known.add(name);
    }
  }
  // dynamic imports: const { setEnvKey } = await import("...")
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\s*\(/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s*:\s*/).pop().trim();
      if (name) known.add(name);
    }
  }
  for (const m of src.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
  for (const name of exported) {
    if (known.has(name)) continue;
    if (!new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(src)) continue;
    missing++;
    console.error(`FAIL ${file}: calls ${name}() but never imports or declares it`);
  }
}
console.log(missing ? `${missing} missing import(s)` : "no missing imports");

process.exit(failed || missing ? 1 : 0);
