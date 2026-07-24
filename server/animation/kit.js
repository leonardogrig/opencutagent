// Animation workspace management. The repo ships a Remotion project TEMPLATE at
// <root>/animation-kit; at runtime it is synced into a user-writable workspace
// OUTSIDE the repo (default ~/.opencutagent/animation-kit) and `npm install`ed
// once. Two reasons the workspace isn't the repo folder itself:
//  - the headless chat agent's cwd must NOT inherit this project's CLAUDE.md
//    (Claude Code loads ancestor CLAUDE.md files; the OpenCutAgent lessons file
//    would pollute and confuse every animation turn);
//  - the installed extension folder stays clean (no job churn, works even if
//    the extension dir is read-only).
import { spawn } from "node:child_process";
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync,
} from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { liveEnv } from "../config.js";
import { log } from "../log.js";

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // server/animation -> root
export const KIT_TEMPLATE_DIR = join(PROJECT_ROOT, "animation-kit");
const IS_WINDOWS = process.platform === "win32";

export function kitDir() {
  return liveEnv("EDITAGENT_ANIM_HOME") || join(homedir(), ".opencutagent", "animation-kit");
}

// Template files worth syncing. node_modules/lockfiles never ship in the repo
// template; job folders exist only in the workspace.
const SKIP_DIRS = new Set(["node_modules", ".remotion", "out", "build", ".git"]);
const SKIP_FILES = new Set(["package-lock.json", ".kit-version", ".deps-hash"]);

function walkTemplate(dir, base, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkTemplate(join(dir, e.name), base, out);
    } else if (!SKIP_FILES.has(e.name)) {
      out.push(relative(base, join(dir, e.name)).split(sep).join("/"));
    }
  }
  return out;
}

/** Content hash of the shipped template — changes when the kit is updated. */
export function templateSignature() {
  const files = walkTemplate(KIT_TEMPLATE_DIR, KIT_TEMPLATE_DIR, []).sort();
  const h = createHash("sha1");
  for (const f of files) {
    h.update(f);
    h.update(readFileSync(join(KIT_TEMPLATE_DIR, f)));
  }
  return h.digest("hex");
}

// Workspace files never clobbered once they exist: the style skills carry a
// user-grown Learnings Log the agent appends to — a template update must not
// erase it. (Genuinely new template guidance still lands via new files.)
const PRESERVE = [/^styles\/[^/]+\/SKILL\.md$/];

// The generated jobs manifest: the template's empty copy must never overwrite a
// workspace manifest that registers real jobs (regenerateManifest owns it).
const GENERATED = new Set(["src/jobs/manifest.ts"]);

function runNpmInstall(dir, token) {
  return new Promise((resolve, reject) => {
    const child = spawn(IS_WINDOWS ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: dir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: IS_WINDOWS, // spawn() can't exec a .cmd directly; args here are static, so a shell is safe
    });
    if (token) { token.child = child; if (token.children) token.children.add(child); }
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => reject(new Error(`Could not run npm install for the animation kit: ${e.message}. Is Node/npm installed?`)));
    child.on("close", (code) => {
      if (token) { if (token.child === child) token.child = null; if (token.children) token.children.delete(child); }
      if (token && token.aborted) return reject(new Error("Cancelled"));
      if (code === 0) return resolve();
      reject(new Error(`npm install failed for the animation kit (exit ${code}). ${err.slice(-400)}`));
    });
  });
}

/**
 * Make sure the runtime workspace exists, matches the shipped template, and has
 * its npm dependencies installed. Idempotent and cheap once set up (two small
 * stamp-file reads); the first run downloads a few hundred MB and is reported
 * through onProgress.
 * @returns {Promise<string>} the workspace path
 */
export async function ensureKit({ onProgress = () => {}, token } = {}) {
  if (!existsSync(KIT_TEMPLATE_DIR)) {
    throw new Error("The animation-kit template folder is missing from the OpenCutAgent install.");
  }
  const dir = kitDir();
  mkdirSync(dir, { recursive: true });

  const sig = templateSignature();
  const verFile = join(dir, ".kit-version");
  let cur = null;
  try { cur = readFileSync(verFile, "utf8").trim(); } catch { /* first run */ }
  if (cur !== sig) {
    onProgress("Preparing the animation workspace…");
    const files = walkTemplate(KIT_TEMPLATE_DIR, KIT_TEMPLATE_DIR, []);
    let copied = 0;
    for (const f of files) {
      const dest = join(dir, f);
      if (GENERATED.has(f) && existsSync(dest)) continue;
      if (PRESERVE.some((re) => re.test(f)) && existsSync(dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(KIT_TEMPLATE_DIR, f), dest);
      copied++;
    }
    writeFileSync(verFile, sig);
    log(`animation kit synced (${copied} file(s)) -> ${dir}`);
  }

  const pkgHash = createHash("sha1").update(readFileSync(join(dir, "package.json"))).digest("hex");
  const depsFile = join(dir, ".deps-hash");
  let depsCur = null;
  try { depsCur = readFileSync(depsFile, "utf8").trim(); } catch { /* not installed */ }
  const installed = existsSync(join(dir, "node_modules", "remotion"));
  if (!installed || depsCur !== pkgHash) {
    onProgress("Installing animation dependencies (first run only, this can take a few minutes)…");
    await runNpmInstall(dir, token);
    writeFileSync(depsFile, pkgHash);
    log("animation kit dependencies installed");
  }
  return dir;
}

/**
 * The available animation styles. Each style is a self-contained package at
 * styles/<id>/ (see animation-kit/styles/README.md). Shipped styles come from
 * the TEMPLATE (always current); the user can also drop their own package into
 * the WORKSPACE's styles/ folder — those show up flagged `custom` (the sync
 * only ever adds template files, so custom folders survive kit updates).
 */
export function listStyles() {
  const seen = new Map();
  for (const { base, custom } of [{ base: KIT_TEMPLATE_DIR, custom: false }, { base: kitDir(), custom: true }]) {
    const stylesDir = join(base, "styles");
    let entries = [];
    try { entries = readdirSync(stylesDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(stylesDir, e.name, "style.json"), "utf8"));
        if (manifest && manifest.id && !seen.has(manifest.id)) {
          seen.set(manifest.id, { id: manifest.id, name: manifest.name || manifest.id, description: manifest.description || "", default: !!manifest.default, custom });
        }
      } catch { /* not a valid style folder */ }
    }
  }
  const out = [...seen.values()];
  out.sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0) || a.name.localeCompare(b.name));
  return out;
}

/**
 * The style's design-guide skill text, read from the WORKSPACE copy when it
 * exists (it carries the growing Learnings Log) and the template otherwise.
 */
export function readStyleSkill(styleId) {
  const rel = join("styles", styleId, "SKILL.md");
  for (const base of [kitDir(), KIT_TEMPLATE_DIR]) {
    try {
      const p = join(base, rel);
      if (existsSync(p) && statSync(p).isFile()) return readFileSync(p, "utf8");
    } catch { /* try the next location */ }
  }
  return "";
}

/** Path to the Remotion CLI's JS entry inside the workspace (run with process.execPath — no .cmd shims). */
export function remotionCliEntry(dir) {
  const pkgPath = join(dir, "node_modules", "@remotion", "cli", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin && pkg.bin.remotion) || "remotion-cli.js";
    return join(dirname(pkgPath), bin);
  } catch {
    return join(dir, "node_modules", "@remotion", "cli", "remotion-cli.js");
  }
}
