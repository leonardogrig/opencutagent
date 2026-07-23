// Cloud mode: the panel talks to the OpenCutAgent backend (a metered proxy
// holding OUR Anthropic + ElevenLabs keys) instead of the user's own keys and
// `claude -p` subscription auth. This module owns:
//   - the cloud config file (~/.opencutagent/cloud.json): mode + auth token
//   - the Google device-link flow (start / poll; sign-in happens in the user's
//     REAL browser — Google blocks OAuth inside CEP's embedded Chromium)
//   - askCloud(): the judgment-oracle path (threshold / retakes) via the proxy
//   - cloudTranscribe(): Scribe via the proxy (no ElevenLabs key needed)
//   - cloudChatEnv(): env overrides so the animation agent's `claude` CLI
//     bills through the proxy (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)
//
// Self-hosted mode ("self") bypasses all of this and uses the original paths.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { liveEnv } from "./config.js";
import { log } from "./log.js";

const CONFIG_DIR = join(homedir(), ".opencutagent");
const CONFIG_PATH = join(CONFIG_DIR, "cloud.json");

// Default backend URL; override with EDITAGENT_CLOUD_URL in .env (points at
// http://localhost:3000 while developing the backend).
const DEFAULT_CLOUD_URL = "https://cloud.opencutagent.com";

export class CloudError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CloudError";
    this.code = code || "cloud_error";
  }
}

/* ------------------------------ config ------------------------------ */

/** Read cloud.json; missing/corrupt file yields defaults (mode "cloud"). */
export function readCloudConfig(configPath = CONFIG_PATH) {
  const def = { mode: "cloud", token: null, email: null, plan: null };
  try {
    if (!existsSync(configPath)) return def;
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return {
      mode: parsed.mode === "self" ? "self" : "cloud",
      token: typeof parsed.token === "string" && parsed.token ? parsed.token : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
      plan: typeof parsed.plan === "string" ? parsed.plan : null,
    };
  } catch {
    return def;
  }
}

export function writeCloudConfig(patch, configPath = CONFIG_PATH) {
  const next = { ...readCloudConfig(configPath), ...patch };
  mkdirSync(dirname(configPath), { recursive: true });
  // The file holds the account bearer token: owner-only permissions. mode on
  // writeFileSync only applies at creation, so chmod fixes pre-existing files
  // (best-effort; Windows ACLs don't map onto POSIX modes).
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(configPath, 0o600); } catch { /* Windows / exotic fs */ }
  return next;
}

export function cloudUrl() {
  const u = liveEnv("EDITAGENT_CLOUD_URL") || DEFAULT_CLOUD_URL;
  return u.replace(/\/+$/, "");
}

/** True when the AI/transcription paths should go through the proxy. */
export function cloudEnabled() {
  return readCloudConfig().mode === "cloud";
}

export function cloudToken() {
  return readCloudConfig().token;
}

function requireToken() {
  const token = cloudToken();
  if (!token) {
    throw new CloudError(
      "You're in cloud mode but not signed in. Open the panel settings (gear icon) and click Sign in with Google — or turn on Self-hosted to use your own keys.",
      "cloud_unauthenticated"
    );
  }
  return token;
}

/* --------------------------- error mapping --------------------------- */

async function readError(resp) {
  let message = `Cloud service returned ${resp.status}.`;
  let code = "cloud_error";
  try {
    const json = await resp.json();
    if (json?.error?.message) message = json.error.message;
    if (json?.error?.type) code = json.error.type;
  } catch { /* non-JSON error body */ }
  if (resp.status === 401) {
    // Token revoked/expired: forget it so the panel prompts a fresh sign-in.
    writeCloudConfig({ token: null });
    code = "cloud_unauthenticated";
  }
  const err = new CloudError(message, code);
  err.status = resp.status;
  return err;
}

async function postJson(path, body, { token, timeoutMs = 30000 } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let resp;
  try {
    resp = await fetch(cloudUrl() + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new CloudError(
      `Couldn't reach the OpenCutAgent cloud (${e.name === "TimeoutError" ? "timed out" : e.message}). Check your internet connection, or turn on Self-hosted mode in settings.`,
      "cloud_unreachable"
    );
  }
  if (!resp.ok) throw await readError(resp);
  return resp.json();
}

/* --------------------------- device linking --------------------------- */

/** Begin the Google sign-in device link. Returns {deviceCode, userCode, verificationUrl, intervalSec, expiresInSec}. */
export async function cloudLinkStart() {
  return postJson("/api/device/start", { deviceName: `OpenCutAgent on ${hostname()}` });
}

/**
 * One poll step. Returns {status} and, on "approved", persists the token +
 * account into cloud.json (and returns {email, plan}).
 */
export async function cloudLinkPoll(deviceCode) {
  const r = await postJson("/api/device/poll", { deviceCode });
  if (r.status === "approved" && r.token) {
    writeCloudConfig({ token: r.token, email: r.email || null, plan: r.plan || null, mode: "cloud" });
  }
  return r;
}

/** Revoke the token server-side (best-effort) and forget it locally. */
export async function cloudSignOut() {
  const token = cloudToken();
  if (token) {
    try { await postJson("/api/v1/signout", {}, { token }); } catch (e) { log("cloud signout:", e.message); }
  }
  writeCloudConfig({ token: null, email: null, plan: null });
}

/** Account + month usage for the panel's Account section. */
export async function cloudMe() {
  const token = requireToken();
  let resp;
  try {
    resp = await fetch(cloudUrl() + "/api/v1/me", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new CloudError(`Couldn't reach the OpenCutAgent cloud (${e.message}).`, "cloud_unreachable");
  }
  if (!resp.ok) throw await readError(resp);
  return resp.json();
}

/* ----------------------------- AI oracle ----------------------------- */

/**
 * Map the panel's model choice (claude CLI aliases) onto a cloud request
 * model. The backend enforces its own policy; this just forwards intent.
 */
export function cloudModelFor(alias) {
  const a = String(alias || "").toLowerCase();
  if (a.includes("haiku")) return "haiku";
  return "sonnet";
}

/**
 * Cloud counterpart of ai.js askClaude(): one non-streaming structured
 * judgment call through the proxy. Same shape: resolves {data, raw} where
 * raw.usage has input_tokens/output_tokens (so analyzeRetakes' stats work).
 */
export async function askCloud({ prompt, system, schema, model, token: cancelToken } = {}) {
  const token = requireToken();
  const body = {
    model: cloudModelFor(model),
    max_tokens: 8192,
    system: system || undefined,
    messages: [{ role: "user", content: prompt || "" }],
  };
  if (schema) {
    body.output_config = { format: { type: "json_schema", schema } };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600000);
  // Several chunked calls can be in flight at once — track EVERY abort, not
  // just the newest (mirrors token.children for CLI child processes).
  const abort = () => controller.abort();
  if (cancelToken) {
    if (!cancelToken.cloudAborts) cancelToken.cloudAborts = new Set();
    cancelToken.cloudAborts.add(abort);
  }
  let resp;
  try {
    resp = await fetch(cloudUrl() + "/api/ai/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (cancelToken && cancelToken.aborted) throw new CloudError("Cancelled", "cancelled");
    throw new CloudError(
      `Couldn't reach the OpenCutAgent cloud (${e.name === "AbortError" ? "timed out" : e.message}). Check your connection, or switch to Self-hosted mode.`,
      "cloud_unreachable"
    );
  } finally {
    clearTimeout(timeout);
    if (cancelToken && cancelToken.cloudAborts) cancelToken.cloudAborts.delete(abort);
  }
  if (!resp.ok) throw await readError(resp);
  const json = await resp.json();
  if (json.stop_reason === "refusal") {
    throw new CloudError("The AI declined this request. Try again with different content.", "refusal");
  }
  const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let data = null;
  try { data = JSON.parse(text); } catch { /* fall through */ }
  if (data == null && schema) {
    throw new CloudError("The AI didn't return a usable answer. Try again, or a stronger model.");
  }
  return {
    data: data != null ? data : text,
    raw: { usage: json.usage || {}, model: json.model, stop_reason: json.stop_reason },
  };
}

/* --------------------------- transcription --------------------------- */

/**
 * Cloud counterpart of callScribe(): upload one WAV to the proxy, get the
 * Scribe payload back. Field names mirror the direct ElevenLabs call so the
 * transcription pipeline is unchanged.
 */
/** Rough duration of a PCM WAV from its header (metering hint for the proxy). */
export function wavDurationSec(buf) {
  try {
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return 0;
    const channels = buf.readUInt16LE(22) || 1;
    const rate = buf.readUInt32LE(24) || 16000;
    const bytesPerSample = (buf.readUInt16LE(34) || 16) / 8;
    return (buf.length - 44) / (rate * channels * bytesPerSample);
  } catch {
    return 0;
  }
}

export async function cloudTranscribe(wavPath, { model, language, numSpeakers, durationSec } = {}) {
  const token = requireToken();
  const buf = await readFile(wavPath);
  if (!durationSec) durationSec = wavDurationSec(buf);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), basename(wavPath));
  form.append("model_id", model || "scribe_v2");
  form.append("diarize", "true");
  form.append("tag_audio_events", "true");
  form.append("timestamps_granularity", "word");
  if (language) form.append("language_code", language);
  if (numSpeakers) form.append("num_speakers", String(numSpeakers));
  if (durationSec) form.append("duration_seconds", String(Math.round(durationSec)));

  let resp;
  try {
    resp = await fetch(cloudUrl() + "/api/v1/transcribe", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(600000),
    });
  } catch (e) {
    throw new CloudError(
      `Couldn't reach the OpenCutAgent cloud for transcription (${e.name === "TimeoutError" ? "timed out" : e.message}).`,
      "cloud_unreachable"
    );
  }
  if (!resp.ok) throw await readError(resp);
  return resp.json();
}

/* ------------------------- animation chat env ------------------------- */

/**
 * Env overrides for the animation agent's `claude` CLI in cloud mode: the CLI
 * authenticates to OUR proxy with the account token instead of the user's
 * subscription. The CLI hits ${ANTHROPIC_BASE_URL}/v1/messages, which the
 * backend serves at /api/ai/v1/messages (proxied to OpenRouter).
 */
export function cloudChatEnv() {
  const token = requireToken();
  return {
    ANTHROPIC_BASE_URL: cloudUrl() + "/api/ai",
    ANTHROPIC_AUTH_TOKEN: token,
    // Belt and suspenders: some CLI builds check for ANY auth env before
    // falling back to stored OAuth; the pair above is the supported gateway
    // override (same mechanism LLM gateways document for Claude Code).
  };
}
