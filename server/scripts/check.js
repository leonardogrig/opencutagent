// Syntax-check every .js/.mjs file in server/ (recursively, skipping
// node_modules) with `node --check`. Self-maintaining replacement for a
// hand-listed chain in package.json: new files are covered automatically.
import { readdirSync, statSync } from "node:fs";
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
process.exit(failed ? 1 : 0);
