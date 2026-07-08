// Smoke test: spawn the MCP server over stdio, list tools, and call one tool to
// confirm the protocol + error path work end-to-end. Does NOT require Premiere
// (the tool call is expected to come back as an actionable "panel not connected"
// error, which proves the whole chain is wired correctly).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "index.js");

function ok(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
}

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  // Use a likely-free port so the smoke test never collides with a real session.
  env: { ...process.env, PREMIERE_BRIDGE_PORT: "39517" },
});
const client = new Client({ name: "editagent-smoke", version: "0.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  // connect() resolving IS the assertion — a failure rejects into the catch below
  ok("server connects over stdio", client.getServerVersion() != null);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  console.log("   tools:", names.join(", "));
  const expected = [
    "ppro_get_timeline_state",
    "ppro_identify_segments",
    "ppro_trim_clip",
    "ppro_remove_gaps",
    "ppro_remove_silences",
    "ppro_analyze_audio_levels",
    "ppro_remove_silences_by_level",
    "ppro_get_retake_segments",
    "ppro_mark_retakes",
    "ppro_apply_retakes",
    "ppro_run_script",
  ];
  ok("advertises all expected tools", expected.every((n) => names.includes(n)));
  ok("tools carry inputSchema", tools.every((t) => t.inputSchema && t.inputSchema.type === "object"));

  const res = await client.callTool({ name: "ppro_get_timeline_state", arguments: {} });
  const text = (res.content && res.content[0] && res.content[0].text) || "";
  console.log("   get_timeline_state ->", text.slice(0, 120).replace(/\n/g, " "));
  ok("tool call returns the actionable not-connected error", res.isError === true && /not connected|panel|Premiere/i.test(text));
} catch (e) {
  ok(`no unexpected exceptions (${e.message})`, false);
} finally {
  await client.close().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 100);
}
