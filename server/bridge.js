import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { log } from "./log.js";

/**
 * PremiereBridge — hosts a localhost WebSocket listener that the CEP panel
 * connects OUT to. Commands flow server -> panel -> ExtendScript and replies
 * flow back, correlated by requestId.
 *
 * Why the server is the listener (not the panel): a pure-client panel is the
 * shape UXP will also require, so a future UXP port keeps this transport intact.
 * The panel auto-reconnects, so it outlives the per-session stdio MCP server.
 *
 * Host calls are FIFO-serialized — only one is in flight at a time — because
 * CEP `evalScript` runs synchronously on macOS and would otherwise freeze the
 * panel UI if overlapped.
 */
export class PremiereBridge {
  constructor({ host = "127.0.0.1", port = 3001, maxPortTries = 20, portFile = null } = {}) {
    this.host = host;
    this.basePort = port;
    this.maxPortTries = maxPortTries;
    this.portFile = portFile;
    this.port = null;
    this.wss = null;
    this.socket = null; // the current panel connection
    this.pending = new Map(); // requestId -> { resolve, reject }
    this.queue = []; // jobs awaiting send
    this.inFlight = null; // requestId currently awaiting the panel
    this.rpcDispatcher = null; // (method, params, helpers) => Promise<result>
  }

  /**
   * Register the handler for panel-initiated RPC ({type:"rpc"} messages).
   * The handler receives ({ progress(message) }) to stream updates back.
   */
  setRpcDispatcher(fn) {
    this.rpcDispatcher = fn;
  }

  _send(obj) {
    if (this.isConnected()) {
      try {
        this.socket.send(JSON.stringify(obj));
      } catch (e) {
        log("send failed:", e.message);
      }
    }
  }

  /** Push an unsolicited message to the panel (e.g. live decision updates). */
  notifyPanel(obj) {
    this._send(obj);
  }

  async start() {
    this.port = await this._listen(this.basePort, this.maxPortTries);
    if (this.portFile) {
      try {
        writeFileSync(this.portFile, String(this.port));
      } catch (e) {
        log("could not write port file:", e.message);
      }
    }
    log(`bridge listening on ws://${this.host}:${this.port} (waiting for the Premiere panel to connect)`);
    return this.port;
  }

  _listen(port, triesLeft) {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.host, port });
      wss.on("listening", () => {
        this.wss = wss;
        this._wire(wss);
        resolve(port);
      });
      wss.on("error", (err) => {
        // Stay on the SAME port (the panel always looks here) and retry — a busy
        // port almost always means a previous server is still shutting down.
        if (err.code === "EADDRINUSE" && triesLeft > 1) {
          log(`port ${port} busy (a previous server is likely exiting), retrying in 300ms…`);
          setTimeout(() => this._listen(port, triesLeft - 1).then(resolve, reject), 300);
        } else {
          reject(err);
        }
      });
    });
  }

  _wire(wss) {
    wss.on("connection", (ws, req) => {
      // Web pages always send an http(s) Origin header; the CEP panel (file://
      // context) and local Node clients don't. Rejecting http(s) origins keeps
      // arbitrary websites from reaching the bridge from the user's browser
      // (a page can open ws://127.0.0.1 cross-origin), where they could pose
      // as the panel and drive transcription/AI calls on the user's keys.
      const origin = req && req.headers ? req.headers.origin : null;
      if (origin && /^https?:\/\//i.test(origin)) {
        log(`rejected bridge connection from browser origin ${origin}`);
        try {
          ws.close(1008, "origin not allowed");
        } catch {
          /* ignore */
        }
        return;
      }
      log("panel connected");
      // If a stale panel is already registered, drop it in favor of the newest.
      this.socket = ws;
      ws.on("message", (data) => this._onMessage(data));
      ws.on("close", () => {
        if (this.socket === ws) {
          this.socket = null;
          log("panel disconnected");
          this._failAll("the Premiere panel disconnected");
        }
      });
      ws.on("error", (e) => log("panel socket error:", e.message));
    });
  }

  isConnected() {
    return !!this.socket && this.socket.readyState === 1; // WebSocket.OPEN
  }

  /**
   * Call a host action defined in premiere.jsx (e.g. "getTimelineState").
   * Resolves with the action's `result`, or rejects with a BridgeError whose
   * message is written to be actionable for the agent.
   */
  callHost(action, params = {}, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(
          new BridgeError(
            "PANEL_NOT_CONNECTED",
            "Premiere isn't reachable: the OpenCutAgent panel isn't connected. In Premiere open Window > Extensions > OpenCutAgent, make sure a project is open, and confirm the panel shows \"connected\". (No state changed.)"
          )
        );
        return;
      }
      const requestId = randomUUID();
      this.queue.push({ requestId, action, params, resolve, reject, timeoutMs });
      this._drain();
    });
  }

  _drain() {
    if (this.inFlight || this.queue.length === 0) return;
    if (!this.isConnected()) {
      this._failAll("the Premiere panel disconnected");
      return;
    }
    const job = this.queue.shift();
    this.inFlight = job.requestId;

    const timer = setTimeout(() => {
      this.pending.delete(job.requestId);
      this.inFlight = null;
      job.reject(
        new BridgeError(
          "TIMEOUT",
          `Premiere did not respond within ${job.timeoutMs}ms for "${job.action}". The host may be busy, blocked by a modal dialog, or mid-render. (No state changed.)`
        )
      );
      this._drain();
    }, job.timeoutMs);

    this.pending.set(job.requestId, {
      resolve: (result) => {
        clearTimeout(timer);
        this.inFlight = null;
        job.resolve(result);
        this._drain();
      },
      reject: (err) => {
        clearTimeout(timer);
        this.inFlight = null;
        job.reject(err);
        this._drain();
      },
    });

    const payload = JSON.stringify({ requestId: job.requestId, action: job.action, params: job.params });
    try {
      this.socket.send(payload);
    } catch (e) {
      const p = this.pending.get(job.requestId);
      this.pending.delete(job.requestId);
      if (p) p.reject(new BridgeError("SEND_FAILED", `Failed to send command to the panel: ${e.message}`));
    }
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log("ignored non-JSON message from panel");
      return;
    }
    if (msg && msg.type === "hello") {
      log("panel hello:", msg.app || "", msg.version || "");
      return;
    }
    if (msg && msg.type === "rpc") {
      this._handleRpc(msg);
      return;
    }
    const requestId = msg && msg.requestId;
    if (!requestId || !this.pending.has(requestId)) return;
    const p = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (msg.status === "OK") {
      p.resolve(msg.result);
    } else {
      p.reject(new BridgeError("HOST_ERROR", msg.error || "Unknown error inside Premiere (ExtendScript)."));
    }
  }

  _handleRpc(msg) {
    const { id, method, params } = msg;
    const helpers = { progress: (message) => this._send({ type: "rpcProgress", id, message }) };
    Promise.resolve()
      .then(() => {
        if (!this.rpcDispatcher) throw new Error("Server has no RPC dispatcher configured.");
        return this.rpcDispatcher(method, params || {}, helpers);
      })
      .then((result) => this._send({ type: "rpcResult", id, status: "OK", result }))
      .catch((err) => {
        log(`rpc ${method} error:`, err && err.stack ? err.stack : err);
        this._send({ type: "rpcResult", id, status: "FAILURE", error: err && err.message ? err.message : String(err) });
      });
  }

  _failAll(reason) {
    for (const [, p] of this.pending) {
      p.reject(new BridgeError("DISCONNECTED", `Bridge error: ${reason}. (No state changed.)`));
    }
    this.pending.clear();
    const queued = this.queue;
    this.queue = [];
    this.inFlight = null;
    for (const job of queued) {
      job.reject(new BridgeError("DISCONNECTED", `Bridge error: ${reason}. (No state changed.)`));
    }
  }

  async close() {
    if (this.wss) {
      // Terminate any attached panel FIRST — otherwise wss.close() waits forever
      // for the client to disconnect and the process never exits (stale server).
      for (const client of this.wss.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 500);
        this.wss.close(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (this.portFile) {
      try {
        unlinkSync(this.portFile);
      } catch {
        /* ignore */
      }
    }
  }
}

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}
