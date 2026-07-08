import { existsSync, readFileSync } from "node:fs";

// Minimal .env loader (mirrors the precedence used by the video-use skill:
// existing process.env always wins; first file to define a key wins after that).
// Avoids a dotenv dependency.
export function loadEnv(paths = []) {
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}
