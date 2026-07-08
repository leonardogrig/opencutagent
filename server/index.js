#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { loadEnv } from "./env.js";
import { log } from "./log.js";
import { PremiereBridge } from "./bridge.js";
import { tools, toolsByName } from "./tools/index.js";
import { createRpcDispatcher } from "./rpc/index.js";
import { initUsage } from "./usage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

// Load env: project .env first, then cwd .env (process.env always wins).
loadEnv([join(projectRoot, ".env"), join(process.cwd(), ".env")]);

const cacheDir = process.env.EDITAGENT_CACHE_DIR || join(projectRoot, ".cache");
mkdirSync(cacheDir, { recursive: true });
initUsage(cacheDir);

// A fixed well-known port file both the server and the panel can find,
// independent of where the user's project lives.
const sharedDir = join(homedir(), ".editagent");
mkdirSync(sharedDir, { recursive: true });
const portFile = join(sharedDir, "bridge-port");
const basePort = parseInt(process.env.PREMIERE_BRIDGE_PORT || "3001", 10);

const bridge = new PremiereBridge({ port: basePort, portFile });
const ctx = { bridge, cacheDir, state: { revision: 0 } };
bridge.setRpcDispatcher(createRpcDispatcher(ctx));

const server = new Server(
  { name: "opencutagent-premiere", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = toolsByName.get(name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const value = await tool.handler(args || {}, ctx);
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    log(`tool ${name} error:`, err && err.stack ? err.stack : err);
    return { content: [{ type: "text", text: err && err.message ? err.message : String(err) }], isError: true };
  }
});

async function main() {
  try {
    await bridge.start();
  } catch (e) {
    log(`WARNING: bridge failed to listen (${e.message}). Tools will report 'panel not connected' until this is fixed. Set PREMIERE_BRIDGE_PORT to a free port.`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready on stdio.");

  const shutdown = () => {
    log("shutting down");
    // Hard backstop: always exit within 1.5s even if close() stalls, so the
    // process never lingers holding the port across restarts.
    setTimeout(() => process.exit(0), 1500).unref();
    bridge
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log("fatal:", e && e.stack ? e.stack : e);
  process.exit(1);
});
