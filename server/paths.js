// Where our helper binaries live when the server was NOT started from a shell.
//
// The panel auto-starts this server from Premiere, and macOS gives every
// GUI-launched process the bare launchd PATH `/usr/bin:/bin:/usr/sbin:/sbin` —
// no /opt/homebrew/bin, no /usr/local/bin, no nvm. Every spawn of a tool the
// user installed (ffmpeg, npm for the animation kit, claude) then dies with
// "spawn ffmpeg ENOENT" even though the tool is right there in the user's own
// terminal. Same story on Linux desktops; on Windows the launcher inherits a
// usable PATH but npm/node still live next to the node binary.
//
// So: at boot we widen PATH with the standard install locations that actually
// exist (augmentPath), and ffmpeg additionally resolves to an absolute path
// (ffmpegBin) so a missing-ffmpeg error can name what we looked for.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { liveEnv } from "./config.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * Standard bin directories for this platform, best-first. The node binary's own
 * directory comes first: whatever node runs this server (homebrew, nvm, the
 * system) ships npm/npx beside it, which is what the animation kit needs.
 */
export function commonBinDirs({ platform = process.platform, home = homedir(), execPath = process.execPath } = {}) {
  const dirs = [];
  if (execPath) dirs.push(dirname(execPath));
  if (platform === "win32") {
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps"));
    dirs.push("C:\\ffmpeg\\bin", "C:\\Program Files\\ffmpeg\\bin");
  } else {
    dirs.push(
      "/opt/homebrew/bin", // Apple Silicon homebrew
      "/opt/homebrew/sbin",
      "/usr/local/bin", // Intel homebrew / manual installs
      "/usr/local/sbin",
      "/opt/local/bin", // MacPorts
      "/snap/bin",
      join(home, ".local", "bin"),
      join(home, "bin")
    );
  }
  return dirs;
}

const exists = (p) => {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
};

/** Append `dirs` to a PATH string, skipping duplicates. Pure (unit-tested). */
export function mergePath(current, dirs) {
  const parts = String(current || "").split(delimiter).filter(Boolean);
  const seen = new Set(parts);
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    parts.push(d);
    seen.add(d);
  }
  return parts.join(delimiter);
}

/**
 * Widen `env.PATH` with the common bin directories that exist on this machine.
 * Existing entries keep their priority (we only append), so a user's own PATH
 * still wins. Returns the new PATH.
 */
export function augmentPath(env = process.env) {
  env.PATH = mergePath(env.PATH, commonBinDirs().filter(exists));
  return env.PATH;
}

let ffmpegMemo = null;

/**
 * How to invoke ffmpeg: the FFMPEG_BIN override (.env / panel Advanced
 * settings) -> an absolute path in a standard install location -> the bare
 * name, letting PATH resolve it.
 */
export function ffmpegBin() {
  const override = liveEnv("FFMPEG_BIN");
  if (override) return override;
  if (ffmpegMemo && exists(ffmpegMemo)) return ffmpegMemo;
  const name = IS_WINDOWS ? "ffmpeg.exe" : "ffmpeg";
  for (const dir of commonBinDirs()) {
    const p = join(dir, name);
    if (exists(p)) {
      ffmpegMemo = p;
      return p;
    }
  }
  return "ffmpeg";
}

/**
 * One shared explanation for "we could not launch ffmpeg", pointing at the two
 * ways to fix it. `bin` is whatever ffmpegBin() handed us.
 */
export function ffmpegMissingMessage(bin, detail) {
  return (
    `Could not run "${bin}"${detail ? `: ${detail}` : ""}. ` +
    "Install ffmpeg (macOS: brew install ffmpeg), or set FFMPEG_BIN to its full path " +
    "in the panel's settings (gear icon, Advanced) and restart the server."
  );
}
