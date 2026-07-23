// Unit checks for the cloud-mode client (server/cloud.js) pure parts: the
// cloud.json config store (defaults, round-trip, corrupt-file resilience,
// mode switching), the panel-alias -> cloud model mapping, and the WAV
// duration estimator used for transcription metering. No network.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCloudConfig, writeCloudConfig, cloudModelFor, wavDurationSec } from "../cloud.js";

let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

const dir = mkdtempSync(join(tmpdir(), "editagent-cloud-"));
const cfgPath = join(dir, "cloud.json");

// defaults: no file -> cloud mode, signed out
{
  const c = readCloudConfig(cfgPath);
  check("missing file defaults to cloud mode, no token", c.mode === "cloud" && c.token === null && c.email === null, c);
}

// write + read round-trip
{
  writeCloudConfig({ token: "oca_abc", email: "a@b.c", plan: "pro" }, cfgPath);
  const c = readCloudConfig(cfgPath);
  check("token/email/plan persist", c.token === "oca_abc" && c.email === "a@b.c" && c.plan === "pro", c);
  check("mode stays cloud after partial patch", c.mode === "cloud", c.mode);
}

// mode switch preserves the token (self-hosted must not sign the user out)
{
  writeCloudConfig({ mode: "self" }, cfgPath);
  const c = readCloudConfig(cfgPath);
  check("self mode persists", c.mode === "self", c.mode);
  check("token survives the mode switch", c.token === "oca_abc", c.token);
  writeCloudConfig({ mode: "cloud" }, cfgPath);
  check("back to cloud mode", readCloudConfig(cfgPath).mode === "cloud", readCloudConfig(cfgPath));
}

// unknown mode strings normalize to cloud; corrupt file falls back to defaults
{
  writeFileSync(cfgPath, JSON.stringify({ mode: "banana", token: 42 }));
  const c = readCloudConfig(cfgPath);
  check("unknown mode -> cloud, non-string token -> null", c.mode === "cloud" && c.token === null, c);
  writeFileSync(cfgPath, "{not json");
  const c2 = readCloudConfig(cfgPath);
  check("corrupt file -> defaults", c2.mode === "cloud" && c2.token === null, c2);
}

// sign-out shape: clearing token via patch
{
  writeCloudConfig({ token: "oca_x", email: "x@y.z" }, cfgPath);
  writeCloudConfig({ token: null, email: null, plan: null }, cfgPath);
  const c = readCloudConfig(cfgPath);
  check("clearing token/email works", c.token === null && c.email === null, c);
}

// model alias mapping (panel sends claude CLI aliases)
{
  check("haiku stays haiku", cloudModelFor("haiku") === "haiku", cloudModelFor("haiku"));
  check("sonnet -> sonnet", cloudModelFor("sonnet") === "sonnet", cloudModelFor("sonnet"));
  check("opus -> sonnet (cloud cost policy)", cloudModelFor("opus") === "sonnet", cloudModelFor("opus"));
  check("latest -> sonnet", cloudModelFor("latest") === "sonnet", cloudModelFor("latest"));
  check("empty -> sonnet", cloudModelFor("") === "sonnet", cloudModelFor(""));
}

// WAV duration estimate from a synthetic header: 16kHz mono 16-bit, 2s of data
{
  const rate = 16000, channels = 1, bps = 2, seconds = 2;
  const data = Buffer.alloc(rate * channels * bps * seconds);
  const buf = Buffer.alloc(44 + data.length);
  buf.write("RIFF", 0, "ascii");
  buf.write("WAVE", 8, "ascii");
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt16LE(16, 34); // bits per sample
  const d = wavDurationSec(buf);
  check("wav duration ~2s", Math.abs(d - 2) < 0.01, d);
  check("non-wav buffer -> 0", wavDurationSec(Buffer.from("nope")) === 0, wavDurationSec(Buffer.from("nope")));
}

rmSync(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll cloud checks passed");
