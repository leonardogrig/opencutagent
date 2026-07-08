#!/bin/bash
# OpenCutAgent server launcher (double-clickable on macOS).
# Starts the Node bridge the Premiere panel connects to. Leave this window open
# while you use the panel; close it (or Ctrl+C) to stop the server.
# You normally DON'T need this — the extension auto-starts the server when you
# open it. Use this only if auto-start fails or you prefer a visible server log.
cd "$(dirname "$0")" || exit 1
echo "Starting OpenCutAgent server on ws://127.0.0.1:3001  (Ctrl+C to stop)…"
exec node server/index.js
