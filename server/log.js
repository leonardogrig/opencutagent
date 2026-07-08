// All logging MUST go to stderr — stdout is the MCP (JSON-RPC) channel and any
// stray write there corrupts the protocol and breaks the Claude Code connection.
export function log(...args) {
  console.error("[opencutagent]", ...args);
}
