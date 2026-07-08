import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Project .env path (server/ -> project root).
const ENV_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");

/**
 * Read a config value FRESH from the project .env on every call (falling back
 * to process.env). This lets the user change keys/models in .env and have it
 * take effect on the next action — no server restart. Keep it for small,
 * occasionally-read values (API keys, model id), not hot loops.
 */
export function liveEnv(key) {
  try {
    if (existsSync(ENV_PATH)) {
      for (const raw of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) continue;
        const eq = line.indexOf("=");
        if (line.slice(0, eq).trim() !== key) continue;
        let v = line.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (v) return v;
      }
    }
  } catch {
    /* fall through to process.env */
  }
  return process.env[key];
}

/**
 * Write (or replace) one KEY=value line in the project .env, preserving every
 * other line (comments, other keys, blank spacing). Creates the file if it
 * doesn't exist. Pairs with liveEnv: the next read picks the new value up with
 * no restart. Used by the panel's API-key modal so non-developers never have
 * to open .env by hand. `envPath` is injectable for tests.
 */
export function setEnvKey(key, value, envPath = ENV_PATH) {
  const line = `${key}=${value}`;
  let lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  let found = false;
  lines = lines.map((raw) => {
    const t = raw.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) return raw;
    if (t.slice(0, t.indexOf("=")).trim() !== key) return raw;
    found = true;
    return line;
  });
  if (!found) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(line);
  }
  writeFileSync(envPath, lines.join("\n") + "\n");
}
