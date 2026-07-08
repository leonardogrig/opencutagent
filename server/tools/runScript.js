export default {
  name: "ppro_run_script",
  description:
    "Escape hatch: run arbitrary ExtendScript inside Premiere and return its result. Use ONLY for operations the dedicated tools don't cover (the host exposes the standard `app`/`qe` DOMs). The script's final expression is the return value; return JSON-serializable data. Powerful and unguarded — prefer the specific tools.",
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      jsx: { type: "string", description: "ExtendScript source. Its last evaluated expression is returned (JSON-stringified)." },
    },
    required: ["jsx"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!args.jsx || !String(args.jsx).trim()) {
      return { error: "Provide non-empty jsx." };
    }
    const result = await ctx.bridge.callHost("runScript", { jsx: args.jsx }, { timeoutMs: 60000 });
    return { result };
  },
};
