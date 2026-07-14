/*
 * main.js — OpenCutAgent panel (two tabs).
 *
 * Channels over one WebSocket to the MCP server:
 *  - host ops   (server -> panel): {requestId, action, params}  -> run in premiere.jsx
 *  - panel RPC  (panel -> server): {type:'rpc', id, method, ...} -> server handlers
 *  - reviewUpdate  (server -> panel): Claude's retake Keep/Cut marks, pushed live
 *  - silenceConfig (server -> panel): AI-suggested silence settings, pushed live
 *
 * TAB 1 "Remove Silences" (loudness-based): the server measures the timeline's
 * audio loudness with ffmpeg (no transcription); the panel draws the dB envelope
 * and computes the red "Silence" / green "Margin" zones LIVE in JS as you drag
 * the controls. "Remove Silences" sends the ranges to the server, which
 * maps them to exact frames and ripple/lift/mute-deletes them.
 * computeSilenceRanges() MIRRORS the server's audio/silence.js — keep them in
 * sync (server/test/silence.js pins it).
 *
 * TAB 2 "Retakes": load the transcript, then mark Keep/Cut and Apply All.
 *
 * The header's settings popover (sparkle button: model/effort + "Sync with
 * Claude Code" + cache management) controls both tabs' AI actions. Default
 * (sync OFF): "Suggest threshold" and "Analyze w/ Claude" call the server's
 * aiThreshold / aiRetakes RPCs, which run `claude` headlessly and apply the
 * result here. Sync ON: they defer to the Claude Code chat, which drives the
 * same result via MCP tools and pushes silenceConfig / reviewUpdate.
 */
(function () {
  "use strict";

  var DEFAULT_PORT = 3001;
  var cep = window.__adobe_cep__;
  var ws = null;
  var reconnectTimer = null;

  var rpcSeq = 0;
  var pendingRpc = {};
  // Count of server-driven host ops currently running through cep.evalScript. The
  // Retakes playhead poll skips its tick while this is >0 so its own evalScript
  // doesn't pile up behind a long host op on the single ExtendScript engine.
  var hostOpsInFlight = 0;
  function hostBusy() { return hostOpsInFlight > 0; }

  /* ---------- small helpers ---------- */
  function pad2(n) { return (n < 10 ? "0" : "") + Math.floor(n); }
  function mmss(sec) { return Math.floor(sec / 60) + ":" + pad2(sec % 60); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function $(id) { return document.getElementById(id); }

  function setConn(kind, text) {
    var dot = $("dot");
    dot.className = "dot" + (kind === "ok" ? " ok" : kind === "bad" ? " bad" : "");
    $("connText").textContent = text;
  }
  /* ---------- UI feedback helpers (loading buttons, global busy bar, typed toast) ----------
   * Dynamic-label buttons carry a <span class="lbl"> so we can swap the label WITHOUT
   * wiping the inline <svg class="ic"> icon. setLoading() adds .loading (CSS draws a
   * spinner in place of the icon) and flips aria-busy. setBusyBar() drives the slim
   * indeterminate progress bar under the header from any number of concurrent ops. */
  function lblText(elm) { if (!elm) return ""; var l = elm.querySelector(".lbl"); return l ? l.textContent : elm.textContent; }
  function setLabel(elm, text) { if (!elm || text == null) return; var l = elm.querySelector(".lbl"); if (l) l.textContent = text; else elm.textContent = text; }
  function setLoading(elm, on, label) {
    if (!elm) return;
    elm.classList.toggle("loading", !!on);
    elm.setAttribute("aria-busy", on ? "true" : "false");
    if (label != null) setLabel(elm, label);
  }
  var busySources = {};
  function setBusyBar(key, on) {
    if (on) busySources[key] = 1; else delete busySources[key];
    var bar = $("topbar"); if (!bar) return;
    var any = false, k; for (k in busySources) if (busySources.hasOwnProperty(k)) { any = true; break; }
    bar.className = "topbar" + (any ? " active" : "");
  }
  // Deterministic-width shimmer rows (no Math.random — keep renders stable).
  function skeletonRows(n) {
    n = n || 7; var h = "", i;
    for (i = 0; i < n; i++) {
      var w = 45 + ((i * 23) % 45);
      h += '<div class="skel-row"><span class="skeleton skel-dot"></span><span class="skeleton skel-time"></span>' +
        '<span class="skeleton skel-text" style="max-width:' + w + '%"></span><span class="skeleton skel-badge"></span></div>';
    }
    return h;
  }

  var TOAST_IC = {
    success: '<svg viewBox="0 0 24 24" class="ic" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" class="ic" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    info: '<svg viewBox="0 0 24 24" class="ic" fill="currentColor"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/></svg>'
  };
  /* Save `text` to a file the user chooses. Prefers CEP's native Save dialog + fs;
   * falls back to writing to the Desktop (Node fs), then to a browser Blob download.
   * cb(ok, path, err) — err === "cancelled" when the user dismissed the dialog. */
  function saveTextFile(defaultName, ext, text, cb) {
    var wcep = window.cep;
    // 1) Native "Save As" dialog (best UX in a CEP panel).
    if (wcep && wcep.fs && typeof wcep.fs.showSaveDialogEx === "function") {
      var initial = "";
      try { initial = require("path").join(require("os").homedir(), defaultName); } catch (e) {}
      var res;
      try { res = wcep.fs.showSaveDialogEx("Save transcript", initial, [ext], defaultName); } catch (e) { res = null; }
      var p = res && res.data ? String(res.data) : "";
      if (!p) { cb(false, null, "cancelled"); return; }
      try {
        var w = wcep.fs.writeFile(p, text);
        if (w && w.err) { cb(false, p, "write error " + w.err); return; }
        cb(true, p, null); return;
      } catch (e) { cb(false, p, e.message); return; }
    }
    // 2) Node fs -> Desktop.
    try {
      var fs = require("fs"), path = require("path"), os = require("os");
      var dest = path.join(os.homedir(), "Desktop", defaultName);
      fs.writeFileSync(dest, text, "utf8");
      cb(true, dest, null); return;
    } catch (e) {}
    // 3) Browser download (last resort).
    try {
      var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = defaultName;
      document.body.appendChild(a); a.click();
      setTimeout(function () { a.remove(); }, 0);
      cb(true, defaultName, null);
    } catch (e) { cb(false, null, e.message); }
  }

  var toastTimer = null;
  function toast(text, type) {
    var t = $("toast"); if (!t) return;
    type = type || "info";
    t.innerHTML = '<span class="toast-ic">' + (TOAST_IC[type] || TOAST_IC.info) + '</span><span class="toast-msg">' + esc(text) + "</span>";
    t.className = "toast show " + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast " + type; }, 5000);
  }

  /* ---------- rich hover tooltips ([data-tip]) ----------
   * Styled, wrapping explanations for buttons and controls. Native title tooltips
   * are slow, unstyled and easy to miss in CEP, so anything that needs a real
   * explanation carries data-tip instead. One shared fixed-position box. */
  var tipEl = null, tipTimer = null, tipTarget = null;
  function hideTip() {
    clearTimeout(tipTimer); tipTimer = null; tipTarget = null;
    if (tipEl) tipEl.className = "tipbox";
  }
  function showTipFor(t) {
    var text = t.getAttribute("data-tip");
    if (!text) return;
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "tipbox"; document.body.appendChild(tipEl); }
    tipEl.textContent = text;
    tipEl.style.left = "0px"; tipEl.style.top = "0px"; // reset so the size measures clean
    tipEl.className = "tipbox show";
    var r = t.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    var x = clamp(r.left + r.width / 2 - tw / 2, 6, Math.max(6, window.innerWidth - tw - 6));
    var y = r.bottom + 8;
    if (y + th > window.innerHeight - 6) y = r.top - th - 8; // flip above when cramped
    tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
  }
  document.addEventListener("mouseover", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
    if (t === tipTarget) return;
    hideTip();
    if (!t) return;
    tipTarget = t;
    tipTimer = setTimeout(function () { if (tipTarget === t) showTipFor(t); }, 400);
  });
  document.addEventListener("mousedown", hideTip, true);
  document.addEventListener("wheel", hideTip, true);
  window.addEventListener("blur", hideTip);
  // Leaving the panel entirely (into Premiere) fires none of the above and
  // would leave the tip floating; relatedTarget null = pointer left the page.
  document.addEventListener("mouseout", function (e) { if (!e.relatedTarget) hideTip(); });

  /* ---------- WebSocket + message routing ---------- */
  function readPort() {
    try {
      var os = require("os"), fs = require("fs"), path = require("path");
      var p = path.join(os.homedir(), ".editagent", "bridge-port");
      if (fs.existsSync(p)) { var v = parseInt(String(fs.readFileSync(p, "utf8")).replace(/\s+/g, ""), 10); if (v) return v; }
    } catch (e) {}
    return DEFAULT_PORT;
  }

  function connect() {
    if (!cep) { setConn("bad", "Not in Premiere"); return; }
    var port = readPort();
    setConn("wait", "Connecting…");
    try { ws = new WebSocket("ws://127.0.0.1:" + port); } catch (e) { tryAutostartServer(); scheduleReconnect(); return; }
    ws.onopen = function () {
      setConn("ok", "Connected");
      ws.send(JSON.stringify({ type: "hello", app: "premiere" }));
      updateAllButtons();
      // Ask the server whether a prior apply is still undoable (survives reloads).
      callServer("undoStatus", {}).then(function (r) {
        if (r && r.undoable) { Silence.markUndoable(r.kind); Retake.markUndoable(r.kind); }
      }, function () {});
      // Learn whether an ElevenLabs key is configured, so a transcription
      // attempt without one opens the key modal instead of failing.
      AI.refreshKey();
      if (activeTab === "retake") Retake.onShow(); // resume playhead sync after a reconnect
      else if (activeTab === "silence") Silence.onShow();
      else if (activeTab === "anim") Anim.onShow();
    };
    ws.onmessage = handleMessage;
    ws.onclose = function () {
      failRpc("Disconnected from server.");
      Retake.onHide(); // stop the playhead poll while offline
      Silence.onHide();
      updateAllButtons();
      // The panel is just a client — if nothing is serving the port, start the
      // Node server ourselves so "open the extension" is all the user needs.
      if (tryAutostartServer()) setConn("wait", "Starting server…");
      else setConn("bad", "Waiting for server…");
      scheduleReconnect();
    };
    ws.onerror = function () {};
  }
  function scheduleReconnect() { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 2000); }
  function connected() { return ws && ws.readyState === 1; }

  /* ---------- auto-start the Node server (so the extension is self-sufficient) ----------
   * The server (server/index.js) is what serves this panel AND runs the headless
   * `claude` calls. It can be started by Claude Code (MCP, for "Sync" mode) OR
   * stand alone. If nothing is on the port when we can't connect, we spawn it
   * ourselves. Check-first (we only spawn after a failed connect) means we never
   * fight a server that Claude Code already started. The unload hook below kills
   * OUR child when the panel closes (a dying CEF process reparents children
   * rather than killing them); servers started by Claude Code or by hand are
   * never ours to stop. */
  var serverChild = null;
  var lastSpawnAt = 0;

  window.addEventListener("unload", function () {
    if (serverChild && serverChild.pid && !serverChild.killed) {
      try { serverChild.kill(); } catch (e) {}
    }
  });

  function resolveNodeBin(fs, path) {
    var os = require("os");
    var isWin = os.platform() === "win32";
    var list, i;
    if (isWin) {
      var env = (typeof process !== "undefined" && process.env) || {};
      list = [
        path.join(env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
        path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe"),
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "nodejs", "node.exe") : null,
        env.NVM_SYMLINK ? path.join(env.NVM_SYMLINK, "node.exe") : null, // nvm-windows
      ];
    } else {
      list = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
      try {
        var nvm = path.join(os.homedir(), ".nvm", "versions", "node");
        if (fs.existsSync(nvm)) {
          // numeric semver sort — a lexicographic sort would rank v9 above v18
          var vs = fs.readdirSync(nvm).sort(function (a, b) {
            var pa = a.replace(/^v/, "").split("."), pb = b.replace(/^v/, "").split(".");
            return (parseInt(pb[0], 10) - parseInt(pa[0], 10)) || (parseInt(pb[1], 10) - parseInt(pa[1], 10)) || (parseInt(pb[2], 10) - parseInt(pa[2], 10)) || 0;
          });
          for (i = 0; i < vs.length; i++) list.push(path.join(nvm, vs[i], "bin", "node"));
        }
      } catch (e) {}
    }
    for (i = 0; i < list.length; i++) { try { if (list[i] && fs.existsSync(list[i])) return list[i]; } catch (e) {} }
    try {
      var cp = require("child_process");
      var w = isWin
        ? cp.execSync("where node", { encoding: "utf8" }).trim()
        : cp.execSync("command -v node", { encoding: "utf8", shell: "/bin/bash" }).trim();
      if (w) return w.split(/\r?\n/)[0];
    } catch (e) {}
    return null;
  }

  // Returns true if it attempted to start the server this call.
  function tryAutostartServer() {
    if (!cep) return false;
    if (serverChild && serverChild.pid && !serverChild.killed) return false; // already started one
    var now = Date.now();
    if (now - lastSpawnAt < 8000) return false; // throttle (don't spawn-storm while reconnecting)
    lastSpawnAt = now;
    try {
      var fs = require("fs"), path = require("path"), cp = require("child_process");
      var extPath = cep.getSystemPath("extension");          // <project>/cep-panel (may be a symlink)
      try { extPath = fs.realpathSync(extPath); } catch (e) {} // CEP installs are often symlinked into .../CEP/extensions
      var root = path.dirname(extPath);                        // <project>
      var serverJs = path.join(root, "server", "index.js");
      if (!fs.existsSync(serverJs)) { setConn("bad", "Server not found. Run: node server/index.js"); return false; }
      var nodeBin = resolveNodeBin(fs, path);
      if (!nodeBin) { setConn("bad", "Node not found. Run: node server/index.js"); return false; }
      serverChild = cp.spawn(nodeBin, [serverJs], { cwd: root, stdio: "ignore" });
      serverChild.on("error", function () { serverChild = null; });
      serverChild.on("exit", function () { serverChild = null; });
      return true;
    } catch (e) {
      serverChild = null;
      return false;
    }
  }

  function handleMessage(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg) return;
    if (msg.type === "rpcResult") {
      var p = pendingRpc[msg.id]; if (!p) return; delete pendingRpc[msg.id];
      if (msg.status === "OK") p.resolve(msg.result); else p.reject(new Error(msg.error || "Server error"));
      return;
    }
    if (msg.type === "rpcProgress") { var pp = pendingRpc[msg.id]; if (pp && pp.onProgress) pp.onProgress(msg.message); return; }
    if (msg.type === "reviewUpdate") { Retake.applyReviewUpdate(msg.segments); Anim.onSegments(); return; }
    if (msg.type === "silenceConfig") { Silence.applyPushedConfig(msg); return; }
    if (msg.type === "animEvent") { Anim.onEvent(msg); return; }
    if (msg.requestId && msg.action) { dispatchHostOp(msg); return; }
  }

  // server -> host op (used by MCP tools and the apply RPCs)
  function dispatchHostOp(msg) {
    var code = "$.editagent.dispatch(" + JSON.stringify(msg.action) + "," + JSON.stringify(msg.params || {}) + ")";
    hostOpsInFlight++;
    cep.evalScript(code, function (res) {
      hostOpsInFlight--;
      if (res === "EvalScript error." || res == null || res === "undefined") {
        send({ requestId: msg.requestId, status: "FAILURE", error: "Host script error (reopen the panel)." });
        return;
      }
      try { var parsed = JSON.parse(res); send({ requestId: msg.requestId, status: parsed.status, result: parsed.result, error: parsed.error }); }
      catch (e) { send({ requestId: msg.requestId, status: "FAILURE", error: "Bad host response." }); }
    });
  }

  // panel -> host op directly (no server round-trip; e.g. seek the playhead)
  function callHostDirect(action, params, cb) {
    if (!cep) { if (cb) cb(null); return; }
    var code = "$.editagent.dispatch(" + JSON.stringify(action) + "," + JSON.stringify(params || {}) + ")";
    cep.evalScript(code, function (res) {
      try { cb && cb(JSON.parse(res)); } catch (e) { cb && cb(null); }
    });
  }

  function send(obj) { if (connected()) ws.send(JSON.stringify(obj)); }

  function callServer(method, params, onProgress) {
    return new Promise(function (resolve, reject) {
      if (!connected()) { reject(new Error("Not connected. Make sure `claude` is running in the editagent project.")); return; }
      var id = "r" + ++rpcSeq;
      pendingRpc[id] = { resolve: resolve, reject: reject, onProgress: onProgress };
      send({ type: "rpc", id: id, method: method, params: params || {} });
    });
  }
  function failRpc(reason) { for (var id in pendingRpc) { try { pendingRpc[id].reject(new Error(reason)); } catch (e) {} } pendingRpc = {}; }

  function updateAllButtons() { Retake.updateButtons(); Silence.updateButtons(); Anim.updateButtons(); }

  /* ================================================================
   *  SETTINGS POPOVER — Claude (model/effort/sync) + storage (cache).
   *  Lives behind the header's sparkle button so the two explicit AI
   *  actions ("Suggest threshold", "Analyze w/ Claude") don't read as
   *  "this whole tab is AI". Sync OFF (default): those buttons run
   *  `claude` headlessly on the server (subscription). ON: they defer
   *  to the Claude Code chat (MCP). Choices persist in localStorage.
   * ================================================================ */
  var AI = (function () {
    var st = { sync: false, model: "latest", effort: "high" };
    var el = {};
    var confirmingClear = false;
    function load() {
      try {
        st.sync = window.localStorage.getItem("editagent.ai.sync") === "1";
        st.model = window.localStorage.getItem("editagent.ai.model") || "latest";
        st.effort = window.localStorage.getItem("editagent.ai.effort") || "high";
        st.sttModel = window.localStorage.getItem("editagent.sttModel") || "scribe_v2";
      } catch (e) {}
    }
    function persist() {
      try {
        window.localStorage.setItem("editagent.ai.sync", st.sync ? "1" : "0");
        window.localStorage.setItem("editagent.ai.model", st.model);
        window.localStorage.setItem("editagent.ai.effort", st.effort);
        window.localStorage.setItem("editagent.sttModel", st.sttModel);
      } catch (e) {}
    }
    function reflect() {
      if (!el.syncToggle) return;
      el.syncToggle.checked = st.sync;
      // A persisted value no current <option> carries would silently no-op the
      // assignment: the select would SHOW one model while params() sends the
      // stale string. Re-sync state to what the select actually displays.
      el.aiModel.value = st.model;
      if (el.aiModel.value !== st.model) { st.model = el.aiModel.value || "latest"; persist(); el.aiModel.value = st.model; }
      el.aiEffort.value = st.effort;
      if (el.aiEffort.value !== st.effort) { st.effort = el.aiEffort.value || "high"; persist(); el.aiEffort.value = st.effort; }
      el.sttModel.value = st.sttModel;
      if (el.sttModel.value !== st.sttModel) { st.sttModel = el.sttModel.value || "scribe_v2"; persist(); el.sttModel.value = st.sttModel; }
      el.aiCtls.className = "pop-group" + (st.sync ? " off" : ""); // model/effort irrelevant in sync mode
      if (el.aiHint) el.aiHint.textContent = st.sync
        ? "Paired with your Claude Code chat over MCP. Ask Claude to edit the timeline in chat (for example “cut the retakes”) and the results appear here for review."
        : "The “Suggest threshold” and “Analyze w/ Claude” buttons run Claude headlessly here, on your Claude subscription. Turn on Sync to drive OpenCutAgent from a Claude Code chat instead.";
    }
    function fmtBytes(n) {
      if (!n) return "0 MB";
      var mb = n / (1024 * 1024);
      return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb >= 10 ? Math.round(mb) + " MB" : mb >= 0.1 ? mb.toFixed(1) + " MB" : "<0.1 MB";
    }
    function resetClearBtn() {
      confirmingClear = false;
      if (!el.clearCacheBtn) return;
      el.clearCacheBtn.classList.remove("danger");
      setLabel(el.clearCacheBtn, "Clear cache");
    }
    function refreshCache() {
      if (!el.cacheSize) return;
      if (!connected()) { el.cacheSize.textContent = "server offline"; el.clearCacheBtn.disabled = true; return; }
      el.cacheSize.textContent = "…";
      callServer("cacheInfo", {}).then(
        function (r) { el.cacheSize.textContent = fmtBytes(r.totalBytes); el.clearCacheBtn.disabled = !r.totalBytes; },
        function () { el.cacheSize.textContent = "unavailable"; el.clearCacheBtn.disabled = true; }
      );
    }
    function clearCache() {
      if (!connected()) return;
      if (!confirmingClear) {
        // Two-step confirm: clearing transcripts means the next Load re-bills credits.
        confirmingClear = true;
        el.clearCacheBtn.classList.add("danger");
        setLabel(el.clearCacheBtn, "Really clear? Next Load re-transcribes");
        return;
      }
      resetClearBtn();
      setLoading(el.clearCacheBtn, true, "Clearing…");
      callServer("clearCache", {}).then(
        function (r) {
          setLoading(el.clearCacheBtn, false, "Clear cache");
          toast(r.message || "Cache cleared.", "success");
          refreshCache();
        },
        function (err) {
          setLoading(el.clearCacheBtn, false, "Clear cache");
          toast(err.message, "error");
          refreshCache();
        }
      );
    }
    /* ---- AI usage log modal ---- */
    function fmtUsd(n) {
      if (!n) return "$0.00";
      return n < 0.01 ? "<$0.01" : "$" + n.toFixed(2);
    }
    function fmtDur(sec) {
      if (sec >= 3600) return (sec / 3600).toFixed(1) + " h";
      if (sec >= 60) return Math.round(sec / 60) + " min";
      return Math.round(sec) + " s";
    }
    function fmtWhen(ts) {
      var d = new Date(ts);
      return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    }
    function usageDetails(e) {
      if (e.type === "transcription") return fmtDur(e.seconds || 0) + " of " + (e.media || "audio");
      var bits = [];
      if (e.segments) bits.push(e.segments + " segments");
      if (e.calls > 1) bits.push(e.calls + " calls");
      if (e.inputTokens || e.outputTokens) bits.push(Math.round(((e.inputTokens || 0) + (e.outputTokens || 0)) / 1000) + "k tokens");
      if (e.durationMs) bits.push(Math.round(e.durationMs / 1000) + "s");
      return bits.join(", ") || "1 call";
    }
    function renderUsage(r) {
      var entries = (r && r.entries) || [];
      var rows = "";
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var paid = e.type === "transcription";
        rows += "<tr>" +
          '<td class="when">' + esc(fmtWhen(e.ts)) + "</td>" +
          '<td class="action">' + esc(e.type === "transcription" ? "Transcription" : (e.purpose || "Claude analysis")) + "</td>" +
          "<td>" + esc(e.model || "") + (e.effort ? " / " + esc(e.effort) : "") + "</td>" +
          "<td>" + esc(usageDetails(e)) + "</td>" +
          '<td class="num ' + (paid ? "paid" : "free") + '">' + (paid ? esc(fmtUsd(e.costUsd)) : "included") + "</td>" +
          "</tr>";
      }
      el.usageRows.innerHTML = rows;
      el.usageEmpty.hidden = !!entries.length;
      var t = (r && r.totals) || {};
      el.usageTotals.textContent = entries.length
        ? "Total: " + fmtUsd(t.costUsd || 0) + " transcription (" + fmtDur(t.transcribedSec || 0) + " of audio), " + (t.claudeCalls || 0) + " Claude call(s)"
        : "";
    }
    function openUsage() {
      close(); // the popover
      el.usageModal.hidden = false;
      el.usageRows.innerHTML = "";
      el.usageEmpty.hidden = true;
      el.usageTotals.textContent = "Loading…";
      if (!connected()) { el.usageTotals.textContent = ""; el.usageEmpty.hidden = false; el.usageEmpty.textContent = "Server offline. Usage history is available once the server is running."; return; }
      callServer("usageLog", {}).then(renderUsage, function (err) {
        el.usageTotals.textContent = "";
        el.usageEmpty.hidden = false;
        el.usageEmpty.textContent = "Could not load the usage log: " + err.message;
      });
    }
    function closeUsage() { if (el.usageModal) el.usageModal.hidden = true; }

    /* ---- ElevenLabs API key (status row + add/change modal) ----
     * The key lives in the project .env; the server writes it there (setApiKey)
     * so non-developers never open a dotfile. st.keySet: null = unknown,
     * false = missing (pre-checks open the modal), true = configured. */
    function reflectKey() {
      if (!el.keyState) return;
      if (st.keySet === true) { el.keyState.textContent = "•••• " + (st.keyLast4 || ""); setLabel(el.keyBtn, "Change key"); }
      else if (st.keySet === false) { el.keyState.textContent = "Not set"; setLabel(el.keyBtn, "Add API key"); }
      else { el.keyState.textContent = "…"; }
    }
    function refreshKey() {
      if (!el.keyState) return;
      if (!connected()) { el.keyState.textContent = "server offline"; return; }
      callServer("keyStatus", {}).then(
        function (r) { st.keySet = !!(r && r.set); st.keyLast4 = r && r.last4; reflectKey(); },
        function () { st.keySet = null; reflectKey(); }
      );
    }
    function openKeyModal(reason) {
      close(); // the popover
      if (!el.keyModal) return;
      el.keyModal.hidden = false;
      el.keyReason.hidden = !reason;
      el.keyReason.textContent = reason || "";
      el.keyError.hidden = true;
      el.keyInput.value = "";
      setLoading(el.keySaveBtn, false, "Save key");
      try { el.keyInput.focus(); } catch (e) {}
    }
    function closeKeyModal() { if (el.keyModal) el.keyModal.hidden = true; }
    function keyErrorMsg(msg) { el.keyError.textContent = msg; el.keyError.hidden = false; }
    function saveKey() {
      var key = (el.keyInput.value || "").replace(/^\s+|\s+$/g, "");
      if (!key) { keyErrorMsg("Paste your ElevenLabs API key first."); return; }
      if (!connected()) { keyErrorMsg("Server offline. The key can be saved once the server is running."); return; }
      el.keyError.hidden = true;
      setLoading(el.keySaveBtn, true, "Verifying…");
      callServer("setApiKey", { key: key }).then(
        function (r) {
          st.keySet = true; st.keyLast4 = (r && r.last4) || key.slice(-4);
          reflectKey();
          setLoading(el.keySaveBtn, false, "Save key");
          closeKeyModal();
          toast((r && r.message) || "API key saved.", "success");
        },
        function (err) {
          setLoading(el.keySaveBtn, false, "Save key");
          keyErrorMsg(err.message);
        }
      );
    }
    // True when we KNOW no key is configured — callers open the modal instead
    // of letting the transcription fail with a dotfile error message.
    function keyMissing() { return st.keySet === false; }
    // Recognize a missing/rejected-key failure from any RPC and turn it into the
    // modal. Returns true when handled so the caller can soften its own error UI.
    function handleKeyError(err) {
      var m = err && err.message ? err.message : "";
      if (/ELEVENLABS_API_KEY is not set/i.test(m)) {
        st.keySet = false; reflectKey();
        openKeyModal("Transcription needs an ElevenLabs API key. Add one below and this will work right away.");
        return true;
      }
      if (/ElevenLabs rejected the API key/i.test(m)) {
        openKeyModal("Your saved ElevenLabs key was rejected. Paste a valid key with the speech_to_text permission.");
        return true;
      }
      return false;
    }

    /* ---- Advanced env-var accordion (collapsed by default) ---- */
    function renderAdv(vars) {
      var html = "";
      for (var i = 0; i < vars.length; i++) {
        var v = vars[i];
        html += '<div class="adv-var">' +
          '<span class="adv-key">' + esc(v.key) + (v.restart ? ' <span class="adv-restart">(needs server restart)</span>' : "") + "</span>" +
          '<input type="text" data-envkey="' + esc(v.key) + '" value="' + esc(v.value || "") + '" placeholder="' + esc(v.def || "") + '" spellcheck="false" autocomplete="off" />' +
          '<span class="adv-desc">' + esc(v.desc) + "</span>" +
          "</div>";
      }
      el.advList.innerHTML = html || '<div class="pop-hint">Settings unavailable.</div>';
    }
    function refreshAdv() {
      if (!connected()) { el.advList.innerHTML = '<div class="pop-hint">Server offline.</div>'; return; }
      callServer("envList", {}).then(
        function (r) { renderAdv((r && r.vars) || []); },
        function (err) { el.advList.innerHTML = '<div class="pop-hint">' + esc("Could not load settings: " + err.message) + "</div>"; }
      );
    }
    function toggleAdv() {
      var opening = el.advBody.hidden;
      el.advBody.hidden = !opening;
      el.advToggle.className = "adv-toggle" + (opening ? " open" : "");
      el.advToggle.setAttribute("aria-expanded", opening ? "true" : "false");
      if (opening) refreshAdv();
    }
    function saveAdvInput(input) {
      var key = input.getAttribute("data-envkey");
      var prev = input.getAttribute("data-saved");
      var value = (input.value || "").replace(/^\s+|\s+$/g, "");
      if (prev == null) prev = input.defaultValue || "";
      if (value === prev) return; // unchanged — don't spam saves on every blur
      if (!connected()) { toast("Server offline. The setting was not saved.", "error"); return; }
      callServer("setEnv", { key: key, value: value }).then(
        function (r) { input.setAttribute("data-saved", value); toast((r && r.message) || "Saved.", "success"); },
        function (err) { toast(err.message, "error"); }
      );
    }

    function open() {
      el.aiPop.hidden = false;
      el.aiConfigBtn.classList.add("active");
      el.aiConfigBtn.setAttribute("aria-expanded", "true");
      resetClearBtn(); refreshCache(); refreshKey();
      if (!el.advBody.hidden) refreshAdv();
    }
    function close() {
      if (el.aiPop.hidden) return;
      el.aiPop.hidden = true;
      el.aiConfigBtn.classList.remove("active");
      el.aiConfigBtn.setAttribute("aria-expanded", "false");
      resetClearBtn();
    }
    function wire() {
      ["syncToggle", "aiModel", "aiEffort", "sttModel", "aiCtls", "aiHint", "aiConfigBtn", "aiPop", "cacheSize", "clearCacheBtn",
       "usageBtn", "usageModal", "usageCloseBtn", "usageRows", "usageEmpty", "usageTotals",
       "keyState", "keyBtn", "keyModal", "keyCloseBtn", "keyReason", "keyInput", "keyError", "keySaveBtn",
       "advToggle", "advBody", "advList"]
        .forEach(function (id) { el[id] = $(id); });
      load(); reflect();
      el.syncToggle.addEventListener("change", function () { st.sync = el.syncToggle.checked; persist(); reflect(); updateAllButtons(); });
      el.aiModel.addEventListener("change", function () { st.model = el.aiModel.value; persist(); });
      el.aiEffort.addEventListener("change", function () { st.effort = el.aiEffort.value; persist(); });
      el.sttModel.addEventListener("change", function () { st.sttModel = el.sttModel.value; persist(); });
      el.aiConfigBtn.addEventListener("click", function (e) { e.stopPropagation(); if (el.aiPop.hidden) open(); else close(); });
      el.clearCacheBtn.addEventListener("click", clearCache);
      el.usageBtn.addEventListener("click", openUsage);
      el.usageCloseBtn.addEventListener("click", closeUsage);
      // Backdrop click closes the modal; clicks inside the dialog don't bubble out to it.
      el.usageModal.addEventListener("click", function (e) { if (e.target === el.usageModal) closeUsage(); });
      el.keyBtn.addEventListener("click", function () { openKeyModal(); });
      el.keyCloseBtn.addEventListener("click", closeKeyModal);
      el.keyModal.addEventListener("click", function (e) { if (e.target === el.keyModal) closeKeyModal(); });
      el.keySaveBtn.addEventListener("click", saveKey);
      el.keyInput.addEventListener("keydown", function (e) { if (e.key === "Enter") saveKey(); });
      el.advToggle.addEventListener("click", toggleAdv);
      // Advanced inputs save on blur or Enter (delegated — the list re-renders).
      el.advList.addEventListener("focusout", function (e) { if (e.target && e.target.getAttribute && e.target.getAttribute("data-envkey")) saveAdvInput(e.target); });
      el.advList.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target.getAttribute && e.target.getAttribute("data-envkey")) e.target.blur(); });
      // Click-away + Esc close it (clicks inside stay open; a second confirm click works).
      document.addEventListener("click", function (e) { if (!el.aiPop.hidden && !el.aiPop.contains(e.target) && e.target !== el.aiConfigBtn) close(); });
      document.addEventListener("keydown", function (e) {
        if (e.key !== "Escape") return;
        if (el.keyModal && !el.keyModal.hidden) closeKeyModal();
        else if (el.usageModal && !el.usageModal.hidden) closeUsage();
        else close();
      });
    }
    return {
      wire: wire,
      sync: function () { return st.sync; },
      params: function () { return { model: st.model, effort: st.effort, transcribe_model: st.sttModel }; },
      sttModel: function () { return st.sttModel; },
      keyMissing: keyMissing,
      handleKeyError: handleKeyError,
      openKeyModal: openKeyModal,
      refreshKey: refreshKey,
      // QA-in-a-browser hooks: __editagent.AI.openUsage(); __editagent.AI.renderUsage({entries:[...],totals:{...}});
      // __editagent.AI.renderAdv([{key,value,def,desc,restart}]) after clicking Advanced.
      openUsage: openUsage,
      renderUsage: renderUsage,
      renderAdv: renderAdv,
    };
  })();

  /* ================================================================
   *  TABS
   * ================================================================ */
  var activeTab = "silence";
  var TAB_PANES = ["silence", "retake", "anim"];
  function selectTab(name) {
    var prev = activeTab;
    activeTab = name;
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].className = "tab" + (tabs[i].getAttribute("data-tab") === name ? " active" : "");
    for (i = 0; i < TAB_PANES.length; i++) {
      var pane = $("tab-" + TAB_PANES[i]);
      if (pane) pane.className = "tabpane" + (TAB_PANES[i] === name ? "" : " hidden");
    }
    if (prev === "retake" && name !== "retake") Retake.onHide();
    if (prev === "silence" && name !== "silence") Silence.onHide();
    if (prev === "anim" && name !== "anim") Anim.onHide();
    if (name === "silence") Silence.onShow();
    else if (name === "retake") Retake.onShow();
    else if (name === "anim") Anim.onShow();
  }
  (function wireTabs() {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      (function (b) { b.addEventListener("click", function () { selectTab(b.getAttribute("data-tab")); }); })(tabs[i]);
    }
  })();

  /* ================================================================
   *  REMOVE SILENCES
   * ================================================================ */
  var Silence = (function () {
    var DB_TOP = 0, DB_BOT = -60; // visible dB axis
    var DEFAULT_SPAN = 10;   // initial view span (s) — "zoomed in" by default, not the whole timeline
    var POLL_MS = 300;       // playhead poll cadence (mirrors Retakes)

    var s = {
      loaded: false, scanning: false, applying: false, undoing: false, aiBusy: false, undoAvailable: false,
      data: null,             // { hopSec, clips:[...], stats, defaults, presets }
      settings: { thresholdDb: -36, minSilenceMs: 120, keepTalkMs: 400, marginBeforeMs: 120, marginAfterMs: 120 },
      mode: "remove", transition: "none",
      ranges: [], totalSec: 0,
      full0: 0, full1: 0,     // full timeline extent (s)
      v0: 0, v1: 0,           // current view window (s)
      geom: null,
      // playhead sync (mirrors Retakes' Follow):
      follow: true,           // keep the view scrolled to Premiere's playhead (user toggle, persisted)
      playheadSec: null,      // last known CTI position (s) — drawn as a needle on canvas + overview
      lastDrawnPlayhead: null,// dedupes redraws while the playhead is stationary
      snapNext: false,        // force the next reading to recenter (set on scan/show), even if unmoved
      pollTimer: null, pollInFlight: false,
      pendingConfig: null,
      customPresets: loadCustomPresets(),
    };

    var el = {};

    function cache() {
      ["silScanBtn", "silStopBtn", "silStopBtn2", "silUndoBtn", "silStatus", "silCanvas", "vizEmpty", "silOverview", "ovEnd",
       "thrValue", "thrSlider", "calcAi", "presetRow", "minSilence", "keepTalk",
       "marginBefore", "marginAfter", "silSummary", "cutBtn", "zoomIn", "zoomOut", "zoomFit", "silFollow"
      ].forEach(function (id) { el[id] = $(id); });
    }

    /* ----- detection (MIRRORS server/audio/silence.js detectSilences) ----- */
    function computeSilenceRanges(db, hopSec, o) {
      var n = db ? db.length : 0;
      if (!n || !(hopSec > 0)) return [];
      var thr = o.thresholdDb;
      var minSil = o.minSilenceMs / 1000, keepTalk = o.keepTalkMs / 1000;
      var mBefore = o.marginBeforeMs / 1000, mAfter = o.marginAfterMs / 1000;
      var off = o.offsetSec || 0;
      var loud = new Uint8Array(n), i, k;
      for (i = 0; i < n; i++) loud[i] = db[i] >= thr ? 1 : 0;
      // keepTalk: demote islands shorter than keepTalk to silence, unconditionally
      // (exact AutoCut/TimeBolt semantics; mirrors audio/silence.js).
      var keepWin = keepTalk > 0 ? Math.max(1, Math.round(keepTalk / hopSec)) : 0;
      if (keepWin > 1) {
        i = 0;
        while (i < n) {
          if (!loud[i]) { i++; continue; }
          var j0 = i; while (j0 < n && loud[j0]) j0++;
          if (j0 - i < keepWin) for (k = i; k < j0; k++) loud[k] = 0;
          i = j0;
        }
      }
      var out = [];
      i = 0;
      while (i < n) {
        if (loud[i]) { i++; continue; }
        var j = i; while (j < n && !loud[j]) j++;
        var rs = off + i * hopSec, re = off + j * hopSec;
        if (re - rs >= minSil) {
          var lead = i === 0, trail = j === n;
          var st = rs + (lead ? 0 : mAfter), en = re - (trail ? 0 : mBefore);
          if (en - st > 0.001) out.push({ start: st, end: en, silStart: rs, silEnd: re });
        }
        i = j;
      }
      return out;
    }

    // Speech-anchored (mirrors audio/silence.js estimateThreshold): threshold
    // sits speech−30 on the peak-normalized meter (room for quiet passages),
    // never closer than 10dB to speech, never below noise+6; windows on the
    // −60 envelope clamp are excluded from the percentiles.
    function estimateThreshold(db) {
      var vals = [], i;
      for (i = 0; i < db.length; i++) if (isFinite(db[i]) && db[i] > DB_BOT + 0.5) vals.push(db[i]);
      if (!vals.length) return -36;
      vals.sort(function (a, b) { return a - b; });
      function pct(p) { return vals[clamp(Math.round(p * (vals.length - 1)), 0, vals.length - 1)]; }
      var noise = pct(0.15), speech = pct(0.9);
      var th = Math.max(noise + 6, speech - 30);
      th = Math.min(th, speech - 10);
      return Math.round(clamp(th, -55, -20));
    }

    /* ----- scan / load ----- */
    function scan(refresh) {
      if (!connected() || s.scanning || s.applying || s.undoing || s.aiBusy) return;
      s.scanning = true; updateButtons();
      setLoading(el.silScanBtn, true, "Scanning…");
      setStatus("Reading audio levels…");
      callServer("analyzeLevels", { refresh: !!refresh }, function (m) { setStatus(m); }).then(
        function (res) {
          s.data = res;
          s.loaded = true; s.scanning = false;
          ingest(res);
          setLoading(el.silScanBtn, false, "Rescan");
          el.vizEmpty.style.display = "none";
          var sk = res.skipped && res.skipped.length ? " (" + res.skipped.length + " clip(s) skipped)" : "";
          setStatus(res.clips.length + " clip(s) analyzed" + sk);
          if (s.pendingConfig) { var pc = s.pendingConfig; s.pendingConfig = null; applyPushedConfig(pc); }
          recompute(); updateButtons();
        },
        function (err) {
          s.scanning = false;
          setLoading(el.silScanBtn, false, s.loaded ? "Rescan" : "Scan Audio");
          var cancelled = /cancel/i.test(err.message);
          setStatus(cancelled ? "Scan stopped." : err.message, !cancelled);
          updateButtons();
        }
      );
    }

    function stop() {
      if (!s.scanning && !s.applying && !s.aiBusy) return;
      callServer("cancel", {}).catch(function () {});
      setStatus("Stopping…");
    }

    function ingest(res) {
      var full0 = Infinity, full1 = -Infinity, i;
      for (i = 0; i < res.clips.length; i++) {
        var c = res.clips[i];
        // db[0] sits at source time firstWindowSrcSec; place it on the timeline.
        c._tl0 = c.timelineStartSec + (c.firstWindowSrcSec - c.sourceInSec);
        c._off = c.timelineStartSec - c.sourceInSec; // src -> timeline seconds
        if (c.timelineStartSec < full0) full0 = c.timelineStartSec;
        if (c.timelineEndSec > full1) full1 = c.timelineEndSec;
      }
      if (!isFinite(full0)) { full0 = 0; full1 = 1; }
      s.full0 = full0; s.full1 = full1;
      // Default to a "zoomed-in" ~10s window (not the whole timeline); Follow then
      // tracks the playhead from here. Fit / zoom-out still reach the full extent.
      var initSpan = Math.min(DEFAULT_SPAN, full1 - full0);
      s.v0 = full0; s.v1 = full0 + initSpan;
      s.snapNext = true; // first playhead reading recenters this window on the CTI
      // The audio-derived threshold suggestion applies ONLY on the first scan
      // of a sequence — a Rescan must never clobber the user's slider (that
      // silent reset read as "AI ran by itself" and pinned users to the
      // suggestion forever). "Suggest threshold" stays the explicit way to
      // re-derive it later.
      var sug = res.stats && res.stats.suggestedThresholdDb;
      var firstLoad = s.seqLoaded !== res.sequence;
      s.seqLoaded = res.sequence;
      if (firstLoad) s.settings.thresholdDb = (sug != null ? sug : -36);
      syncControlsFromSettings();
      renderPresets();
      el.ovEnd.textContent = mmss(full1);
    }

    /* ----- live recompute ----- */
    function recompute() {
      var ranges = [], total = 0, i, j;
      if (s.data) {
        for (i = 0; i < s.data.clips.length; i++) {
          var c = s.data.clips[i];
          var o = {
            thresholdDb: s.settings.thresholdDb, minSilenceMs: s.settings.minSilenceMs,
            keepTalkMs: s.settings.keepTalkMs, marginBeforeMs: s.settings.marginBeforeMs,
            marginAfterMs: s.settings.marginAfterMs, offsetSec: c.firstWindowSrcSec,
          };
          var rs = computeSilenceRanges(c.db, c.hopSec, o);
          for (j = 0; j < rs.length; j++) {
            var r = rs[j];
            ranges.push({
              clipId: c.clipId, srcStart: r.start, srcEnd: r.end,
              tlStart: r.start + c._off, tlEnd: r.end + c._off,
              tlSilStart: r.silStart + c._off, tlSilEnd: r.silEnd + c._off,
            });
            total += (r.end - r.start);
          }
        }
      }
      s.ranges = ranges; s.totalSec = total;
      updateSummary(); draw(); updateButtons();
    }

    /* ----- drawing ----- */
    function dbAtTimeline(t) {
      var clips = s.data.clips, i;
      for (i = 0; i < clips.length; i++) {
        var c = clips[i];
        if (t >= c.timelineStartSec && t <= c.timelineEndSec) {
          var k = Math.round((t - c._tl0) / c.hopSec);
          if (k < 0) k = 0; if (k >= c.db.length) k = c.db.length - 1;
          return c.db[k];
        }
      }
      return null;
    }

    function sizeCanvas(c) {
      var rect = c.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      var W = Math.max(40, Math.floor(rect.width)), H = Math.max(20, Math.floor(rect.height));
      c.width = W * dpr; c.height = H * dpr;
      var ctx = c.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx: ctx, W: W, H: H };
    }

    function draw() {
      if (!el.silCanvas) return;
      var g = sizeCanvas(el.silCanvas), ctx = g.ctx, W = g.W, H = g.H;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#141110"; ctx.fillRect(0, 0, W, H);
      if (!s.data) { return; }

      var v0 = s.v0, v1 = s.v1, span = (v1 - v0) || 1;
      var padL = 36, padTop = 14, padBot = 4;
      var plotW = W - padL, plotH = H - padTop - padBot;
      var geom = { padL: padL, padTop: padTop, plotW: plotW, plotH: plotH, v0: v0, v1: v1 };
      s.geom = geom;
      function xOf(t) { return padL + ((t - v0) / span) * plotW; }
      function yOfDb(db) { var d = clamp(db, DB_BOT, DB_TOP); return padTop + (1 - (d - DB_BOT) / (DB_TOP - DB_BOT)) * plotH; }

      // dB gridlines + labels
      ctx.font = "10px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      [0, -20, -40, -60].forEach(function (db) {
        var y = yOfDb(db);
        ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.fillStyle = "#837c71"; ctx.fillText(db + "dB", padL - 3, y);
      });

      // time ruler
      drawRuler(ctx, v0, v1, xOf, padTop, W);

      // white loudness fill
      ctx.fillStyle = "#e9e3d9"; ctx.beginPath(); ctx.moveTo(padL, padTop + plotH);
      var x;
      for (x = padL; x <= W; x++) {
        var t = v0 + ((x - padL) / plotW) * span;
        var db = dbAtTimeline(t);
        ctx.lineTo(x, db == null ? padTop + plotH : yOfDb(db));
      }
      ctx.lineTo(W, padTop + plotH); ctx.closePath(); ctx.fill();

      // margins (green) + silences (red)
      var i, hatch = s.ranges.length <= 80;
      for (i = 0; i < s.ranges.length; i++) {
        var r = s.ranges[i];
        if (r.tlSilEnd < v0 || r.tlSilStart > v1) continue;
        var xs = clamp(xOf(r.tlSilStart), padL, W), xe = clamp(xOf(r.tlSilEnd), padL, W);
        var xrs = clamp(xOf(r.tlStart), padL, W), xre = clamp(xOf(r.tlEnd), padL, W);
        // margin zones flank the removed span
        ctx.fillStyle = "rgba(79,180,119,0.38)";
        if (xrs > xs) ctx.fillRect(xs, padTop, xrs - xs, plotH);
        if (xe > xre) ctx.fillRect(xre, padTop, xe - xre, plotH);
        // removed (red) span
        ctx.fillStyle = "rgba(225,75,75,0.42)";
        ctx.fillRect(xrs, padTop, Math.max(1, xre - xrs), plotH);
        if (hatch && xre - xrs > 3) {
          ctx.save(); ctx.beginPath(); ctx.rect(xrs, padTop, xre - xrs, plotH); ctx.clip();
          ctx.strokeStyle = "rgba(240,135,132,0.32)"; ctx.lineWidth = 1;
          for (var hx = xrs - plotH; hx < xre; hx += 7) { ctx.beginPath(); ctx.moveTo(hx, padTop + plotH); ctx.lineTo(hx + plotH, padTop); ctx.stroke(); }
          ctx.restore();
        }
      }

      // threshold line + knob
      var ty = yOfDb(s.settings.thresholdDb);
      ctx.strokeStyle = "#ec6a41"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(padL, ty); ctx.lineTo(W, ty); ctx.stroke();
      ctx.fillStyle = "#ec6a41"; ctx.beginPath(); ctx.arc(padL + 6, ty, 3.5, 0, Math.PI * 2); ctx.fill();

      // playhead needle — syncs with Premiere's CTI. White line over a dark halo so
      // it reads against both the light waveform fill and the dark background.
      if (s.playheadSec != null && s.playheadSec >= v0 && s.playheadSec <= v1) {
        var px = clamp(xOf(s.playheadSec), padL, W);
        ctx.strokeStyle = "rgba(8,6,5,0.60)"; ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.moveTo(px, padTop); ctx.lineTo(px, padTop + plotH); ctx.stroke();
        ctx.strokeStyle = "#f7f3ec"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px, padTop); ctx.lineTo(px, padTop + plotH); ctx.stroke();
        ctx.fillStyle = "#f7f3ec";
        ctx.beginPath(); ctx.moveTo(px - 4, padTop); ctx.lineTo(px + 4, padTop); ctx.lineTo(px, padTop + 5); ctx.closePath(); ctx.fill();
      }
      s.lastDrawnPlayhead = s.playheadSec;

      drawOverview();
    }

    function drawRuler(ctx, v0, v1, xOf, padTop, W) {
      var span = v1 - v0;
      var step = niceStep(span, (W - 40) / 70);
      var first = Math.ceil(v0 / step) * step;
      ctx.fillStyle = "#837c71"; ctx.font = "9px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (var t = first; t <= v1; t += step) {
        var x = xOf(t);
        ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.beginPath(); ctx.moveTo(x, padTop); ctx.lineTo(x, padTop + 4); ctx.stroke();
        ctx.fillText(mmss(t), x, 1);
      }
    }
    function niceStep(span, target) {
      var raw = span / Math.max(1, target);
      var steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
      for (var i = 0; i < steps.length; i++) if (steps[i] >= raw) return steps[i];
      return steps[steps.length - 1];
    }

    function drawOverview() {
      if (!el.silOverview || !s.data) return;
      var g = sizeCanvas(el.silOverview), ctx = g.ctx, W = g.W, H = g.H;
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#100d0c"; ctx.fillRect(0, 0, W, H);
      var f0 = s.full0, f1 = s.full1, fspan = (f1 - f0) || 1;
      function ox(t) { return ((t - f0) / fspan) * W; }
      // mini envelope
      ctx.strokeStyle = "#6f655b"; ctx.beginPath();
      for (var x = 0; x <= W; x++) {
        var t = f0 + (x / W) * fspan; var db = dbAtTimeline(t);
        var y = db == null ? H : H - clamp((db - DB_BOT) / (DB_TOP - DB_BOT), 0, 1) * H;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // silence ticks
      ctx.fillStyle = "rgba(225,75,75,0.5)";
      for (var i = 0; i < s.ranges.length; i++) { var r = s.ranges[i]; var xs = ox(r.tlStart); ctx.fillRect(xs, 0, Math.max(1, ox(r.tlEnd) - xs), H); }
      // viewport
      var vx = ox(s.v0), vw = Math.max(3, ox(s.v1) - ox(s.v0));
      ctx.strokeStyle = "#ec6a41"; ctx.lineWidth = 1.5; ctx.strokeRect(vx + 0.5, 0.5, vw - 1, H - 1);
      ctx.fillStyle = "rgba(236,106,65,0.14)"; ctx.fillRect(vx, 0, vw, H);
      // playhead position across the whole timeline (so it stays visible when the
      // main view is zoomed past it)
      if (s.playheadSec != null) {
        var phx = ox(s.playheadSec);
        ctx.strokeStyle = "rgba(8,6,5,0.55)"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(phx, 0); ctx.lineTo(phx, H); ctx.stroke();
        ctx.strokeStyle = "#f7f3ec"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(phx, 0); ctx.lineTo(phx, H); ctx.stroke();
      }
    }

    /* ----- summary / status / buttons ----- */
    function setStatus(text, isErr) { el.silStatus.textContent = text || ""; el.silStatus.style.color = isErr ? "var(--bad)" : ""; }
    function updateSummary() {
      if (!s.loaded) { el.silSummary.textContent = ""; return; }
      var n = s.ranges.length, secs = s.totalSec;
      var verb = s.mode === "mute" ? "to mute" : "to remove";
      el.silSummary.textContent = n + " silence" + (n === 1 ? "" : "s") + " · ~" + secs.toFixed(1) + "s " + verb +
        " · threshold " + s.settings.thresholdDb + " dB";
    }
    function cutLabel() {
      return { remove: "Remove Silences", keepSpaces: "Remove Silences (keep gaps)", mute: "Mute Silences", keep: "Keep Silences (no change)" }[s.mode];
    }
    function updateButtons() {
      if (!el.silScanBtn) return;
      var busy = s.scanning || s.applying || s.undoing || s.aiBusy;
      setBusyBar("sil", busy);
      el.silScanBtn.disabled = !connected() || busy;
      el.silStopBtn.style.display = (s.scanning || s.aiBusy) ? "" : "none";  // stop the scan / AI (in the bar)
      el.silStopBtn2.style.display = s.applying ? "" : "none";  // stop the cut (replaces Cut)
      setLabel(el.cutBtn, cutLabel());
      el.cutBtn.style.display = s.applying ? "none" : "";
      el.cutBtn.disabled = !connected() || !s.loaded || busy || s.mode === "keep" || s.ranges.length === 0;
      el.silUndoBtn.style.display = (s.undoAvailable && !s.applying && !s.undoing) ? "" : "none";
      el.silUndoBtn.disabled = !connected() || busy;
      if (el.calcAi) {
        el.calcAi.textContent = s.aiBusy ? "Analyzing…" : "Suggest threshold";
        el.calcAi.classList.toggle("busy", s.aiBusy); // spinner ONLY for the AI call itself
        el.calcAi.classList.toggle("disabled", (busy && !s.aiBusy) || !connected()); // dim + unclickable while scanning/applying/offline
      }
    }

    /* ----- controls ----- */
    function readSettingsFromInputs() {
      s.settings.minSilenceMs = clamp(parseInt(el.minSilence.value, 10) || 0, 0, 60000);
      s.settings.keepTalkMs = clamp(parseInt(el.keepTalk.value, 10) || 0, 0, 60000);
      s.settings.marginBeforeMs = clamp(parseInt(el.marginBefore.value, 10) || 0, 0, 5000);
      s.settings.marginAfterMs = clamp(parseInt(el.marginAfter.value, 10) || 0, 0, 5000);
    }
    function syncControlsFromSettings() {
      el.thrSlider.value = s.settings.thresholdDb;
      el.thrValue.textContent = "−" + Math.abs(s.settings.thresholdDb) + " dB";
      fillSlider();
      el.minSilence.value = s.settings.minSilenceMs;
      el.keepTalk.value = s.settings.keepTalkMs;
      el.marginBefore.value = s.settings.marginBeforeMs;
      el.marginAfter.value = s.settings.marginAfterMs;
      highlightActivePreset();
    }
    function fillSlider() { if (!el.thrSlider) return; var v = parseInt(el.thrSlider.value, 10) || 0; el.thrSlider.style.setProperty("--fill", (((v + 60) / 60) * 100) + "%"); }
    function setThreshold(db, fromDrag) {
      s.settings.thresholdDb = clamp(Math.round(db), -60, 0);
      el.thrSlider.value = s.settings.thresholdDb;
      el.thrValue.textContent = "−" + Math.abs(s.settings.thresholdDb) + " dB";
      fillSlider();
      if (fromDrag) recompute(); // slider 'input' already recomputes
    }

    /* ----- presets ----- */
    function allPresets() {
      var base = (s.data && s.data.presets) || {
        Relaxed: { minSilenceMs: 1000, keepTalkMs: 700, marginBeforeMs: 200, marginAfterMs: 200 },
        Natural: { minSilenceMs: 700, keepTalkMs: 600, marginBeforeMs: 170, marginAfterMs: 170 },
        Balanced: { minSilenceMs: 500, keepTalkMs: 500, marginBeforeMs: 150, marginAfterMs: 150 },
        Brisk: { minSilenceMs: 300, keepTalkMs: 450, marginBeforeMs: 120, marginAfterMs: 120 },
        Rapid: { minSilenceMs: 120, keepTalkMs: 400, marginBeforeMs: 80, marginAfterMs: 80 },
      };
      var merged = {}; var k;
      for (k in base) if (base.hasOwnProperty(k)) merged[k] = base[k];
      for (k in s.customPresets) if (s.customPresets.hasOwnProperty(k)) merged[k] = s.customPresets[k];
      return merged;
    }
    function renderPresets() {
      var presets = allPresets(), html = "", name;
      for (name in presets) if (presets.hasOwnProperty(name)) {
        var custom = s.customPresets.hasOwnProperty(name);
        html += '<button data-preset="' + esc(name) + '"' + (custom ? ' data-custom="1"' : "") + '>' + esc(name) +
          (custom ? '<span class="px" data-del="' + esc(name) + '" data-tip="Delete this preset">×</span>' : "") + "</button>";
      }
      html += '<button class="add" id="addPreset" data-tip="Save the current four values as a named preset">+</button>';
      el.presetRow.innerHTML = html;
      highlightActivePreset();
    }
    function matchesPreset(p) {
      return p.minSilenceMs === s.settings.minSilenceMs && p.keepTalkMs === s.settings.keepTalkMs &&
        p.marginBeforeMs === s.settings.marginBeforeMs && p.marginAfterMs === s.settings.marginAfterMs;
    }
    function highlightActivePreset() {
      if (!el.presetRow) return;
      var presets = allPresets();
      var btns = el.presetRow.querySelectorAll("button[data-preset]");
      for (var i = 0; i < btns.length; i++) {
        var name = btns[i].getAttribute("data-preset");
        btns[i].className = presets[name] && matchesPreset(presets[name]) ? "active" : "";
      }
    }
    function applyPreset(name) {
      var p = allPresets()[name]; if (!p) return;
      s.settings.minSilenceMs = p.minSilenceMs; s.settings.keepTalkMs = p.keepTalkMs;
      s.settings.marginBeforeMs = p.marginBeforeMs; s.settings.marginAfterMs = p.marginAfterMs;
      syncControlsFromSettings(); recompute();
    }
    function saveCurrentAsPreset() {
      // CEP's embedded Chromium doesn't implement window.prompt (it returns
      // null instantly), so the name is collected with an inline input that
      // temporarily replaces the "+" button. Enter saves, Escape cancels,
      // clicking away saves a non-empty name.
      var add = el.presetRow && el.presetRow.querySelector("#addPreset");
      if (!add || el.presetRow.querySelector(".preset-name")) return;
      var input = document.createElement("input");
      input.type = "text";
      input.className = "preset-name";
      input.placeholder = "Preset name";
      input.maxLength = 24;
      add.style.display = "none";
      add.parentNode.insertBefore(input, add);
      var closed = false;
      var done = function (save) {
        if (closed) return;
        closed = true;
        var name = save ? input.value.replace(/^\s+|\s+$/g, "") : "";
        if (input.parentNode) input.parentNode.removeChild(input);
        add.style.display = "";
        if (!name) return;
        s.customPresets[name] = { minSilenceMs: s.settings.minSilenceMs, keepTalkMs: s.settings.keepTalkMs, marginBeforeMs: s.settings.marginBeforeMs, marginAfterMs: s.settings.marginAfterMs };
        persistCustomPresets(); renderPresets();
      };
      input.onkeydown = function (e) {
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") done(false);
      };
      input.onblur = function () { done(true); };
      input.focus();
    }
    function loadCustomPresets() { try { return JSON.parse(window.localStorage.getItem("editagent.silence.presets") || "{}") || {}; } catch (e) { return {}; } }
    function persistCustomPresets() { try { window.localStorage.setItem("editagent.silence.presets", JSON.stringify(s.customPresets)); } catch (e) {} }

    /* ----- Suggest threshold ----- */
    function localEstimate() {
      var all = [], i, j;
      for (i = 0; i < s.data.clips.length; i++) for (j = 0; j < s.data.clips[i].db.length; j++) all.push(s.data.clips[i].db[j]);
      return estimateThreshold(all);
    }
    function calculateByAi() {
      if (s.aiBusy) return;
      if (!s.loaded) { scan(false); toast("Scanning audio first. Click “Suggest threshold” again once the waveform appears."); return; }
      // Sync mode: defer to the Claude Code chat. Drop in an instant local estimate + hint.
      if (AI.sync()) {
        var est = localEstimate();
        setThreshold(est, false); recompute();
        toast("Set −" + Math.abs(est) + " dB locally. In Claude Code chat: “calculate the silence threshold with AI” to refine.");
        setStatus("Sync mode: ask Claude in chat to refine the threshold. It pushes the value here.");
        return;
      }
      // Headless (default): Claude picks a content-aware threshold here, on your subscription.
      if (!connected() || s.scanning || s.applying || s.undoing) return;
      s.aiBusy = true; updateButtons();
      setStatus("Claude is choosing a threshold…");
      callServer("aiThreshold", AI.params(), function (m) { setStatus(m); }).then(
        function (res) {
          s.aiBusy = false;
          setThreshold(res.thresholdDb, false); recompute();
          toast("Claude set the threshold to −" + Math.abs(res.thresholdDb) + " dB.", "success");
          setStatus("Threshold set to −" + Math.abs(res.thresholdDb) + " dB by Claude.");
          updateButtons();
        },
        function (err) {
          s.aiBusy = false;
          var cancelled = /cancel/i.test(err.message);
          setStatus(cancelled ? "AI cancelled." : err.message, !cancelled);
          updateButtons();
        }
      );
    }

    // Server/Claude pushed silence settings (the MCP "Suggest threshold" path).
    function applyPushedConfig(msg) {
      if (!s.loaded) {
        // Don't auto-scan — the user controls when scanning happens. Stash + hint.
        s.pendingConfig = msg;
        var t = msg.settings && msg.settings.thresholdDb;
        var hint = "Claude set the silence settings" + (t != null ? " (threshold −" + Math.abs(Math.round(t)) + " dB)" : "") + ". Click “Scan Audio” to load the waveform and preview.";
        setStatus(hint); toast(hint);
        return;
      }
      var cfg = msg.settings || {};
      if (cfg.thresholdDb != null) s.settings.thresholdDb = clamp(Math.round(cfg.thresholdDb), -60, 0);
      if (cfg.minSilenceMs != null) s.settings.minSilenceMs = cfg.minSilenceMs;
      if (cfg.keepTalkMs != null) s.settings.keepTalkMs = cfg.keepTalkMs;
      if (cfg.marginBeforeMs != null) s.settings.marginBeforeMs = cfg.marginBeforeMs;
      if (cfg.marginAfterMs != null) s.settings.marginAfterMs = cfg.marginAfterMs;
      syncControlsFromSettings(); recompute();
      toast("Claude set the silence settings (threshold −" + Math.abs(s.settings.thresholdDb) + " dB)." + (msg.note ? " " + msg.note : ""));
      if (activeTab !== "silence") setStatus("Claude updated the silence settings. Open the Remove Silences tab.");
    }

    /* ----- apply ----- */
    function cut() {
      if (s.aiBusy || s.scanning || s.applying || s.undoing) return;
      if (s.mode === "keep") { toast("“Keep silences” makes no change."); return; }
      if (!s.ranges.length) { toast("No silences to remove at these settings."); return; }
      s.applying = true; updateButtons();
      setStatus((s.mode === "mute" ? "Muting" : "Cutting") + " " + s.ranges.length + " silence(s)…");
      var payload = s.ranges.map(function (r) { return { clipId: r.clipId, srcStart: r.srcStart, srcEnd: r.srcEnd }; });
      callServer("applySilences", { ranges: payload, mode: s.mode, transition: s.transition }, function (m) { setStatus(m); }).then(
        function (res) {
          s.applying = false;
          if (res.undoable) { s.undoAvailable = true; Retake.clearUndoable(); } // shared single undo point
          toast(res.message || ("Applied " + res.applied + " edit(s)."), "success");
          setStatus(res.message || "Done.");
          if (res.applied > 0) scan(false); // re-read the changed timeline (source unchanged → cache valid)
          else updateButtons();
        },
        function (err) {
          s.applying = false;
          var cancelled = /cancel/i.test(err.message);
          setStatus(cancelled ? "Stopped." : err.message, !cancelled);
          updateButtons();
        }
      );
    }

    // One-click revert of the last apply (server reconstructs from its snapshot).
    function undo() {
      if (!s.undoAvailable || s.undoing) return;
      s.undoing = true; updateButtons();
      setLoading(el.silUndoBtn, true, "Undoing…");
      setStatus("Reverting the timeline…");
      callServer("undoLastApply", {}, function (m) { setStatus(m); }).then(
        function (res) {
          s.undoing = false; setLoading(el.silUndoBtn, false, "Undo last apply");
          if (res.ok) {
            s.undoAvailable = false; Retake.clearUndoable();
            toast(res.message, "success"); setStatus(res.message);
            if (s.loaded) scan(false); else updateButtons();
          } else { toast(res.message, "error"); setStatus(res.message, true); updateButtons(); }
        },
        function (err) { s.undoing = false; setLoading(el.silUndoBtn, false, "Undo last apply"); setStatus(err.message, true); updateButtons(); }
      );
    }

    function markUndoable() { s.undoAvailable = true; updateButtons(); }
    function clearUndoable() { s.undoAvailable = false; updateButtons(); }

    /* ----- zoom / scroll / pointer ----- */
    function setView(v0, v1) {
      var min = 0.5; // minimum visible span (s)
      if (v1 - v0 < min) v1 = v0 + min;
      if (v0 < s.full0) { v1 += s.full0 - v0; v0 = s.full0; }
      if (v1 > s.full1) { v0 -= v1 - s.full1; v1 = s.full1; }
      s.v0 = clamp(v0, s.full0, s.full1); s.v1 = clamp(v1, s.full0, s.full1);
      if (s.v1 <= s.v0) s.v1 = Math.min(s.full1, s.v0 + min);
      draw();
    }
    function zoom(factor) {
      var c = (s.v0 + s.v1) / 2, span = (s.v1 - s.v0) * factor;
      span = clamp(span, 0.5, s.full1 - s.full0);
      setView(c - span / 2, c + span / 2);
    }
    function fit() { setView(s.full0, s.full1); }

    /* ----- playhead follow (mirrors the Retakes tab) ----- */
    function loadFollow() { try { s.follow = window.localStorage.getItem("editagent.silence.follow") !== "0"; } catch (e) { s.follow = true; } }
    function persistFollow() { try { window.localStorage.setItem("editagent.silence.follow", s.follow ? "1" : "0"); } catch (e) {} }
    // Scroll the current view so the playhead sits ~15% from the left (keep span).
    function scrollToPlayhead() {
      var span = s.v1 - s.v0;
      setView(s.playheadSec - span * 0.15, s.playheadSec - span * 0.15 + span);
    }
    // A fresh CTI reading from the poll. Auto-scroll only when it actually MOVED out
    // of view (or a snap was queued) — so a paused playhead never fights manual panning.
    function onPlayhead(sec) {
      var moved = sec !== s.playheadSec;
      s.playheadSec = sec;
      if (sec != null && s.follow && (moved || s.snapNext) && (sec < s.v0 || sec > s.v1)) { s.snapNext = false; scrollToPlayhead(); return; }
      s.snapNext = false;
      if (sec !== s.lastDrawnPlayhead) draw(); // needle moved (playing) → redraw; stationary → skip
    }
    // Toggling Follow on (or showing the tab) snaps to the playhead immediately.
    function snapToPlayhead() {
      if (s.playheadSec == null) return;
      if (s.playheadSec < s.v0 || s.playheadSec > s.v1) scrollToPlayhead(); else draw();
    }
    function pollTick() {
      if (activeTab !== "silence" || !connected() || !s.loaded || s.scanning || s.applying || s.undoing || hostBusy() || s.pollInFlight) return;
      s.pollInFlight = true;
      callHostDirect("getPlayhead", {}, function (r) {
        s.pollInFlight = false;
        if (r && r.status === "OK" && r.result && r.result.seconds != null) onPlayhead(r.result.seconds);
      });
    }
    function startPoll() { if (s.pollTimer) clearInterval(s.pollTimer); s.pollTimer = setInterval(pollTick, POLL_MS); }
    function stopPoll() { if (s.pollTimer) { clearInterval(s.pollTimer); s.pollTimer = null; } }

    function pointerTime(e, canvas) {
      var rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function thresholdY() {
      return s.geom.padTop + (1 - (clamp(s.settings.thresholdDb, DB_BOT, DB_TOP) - DB_BOT) / (DB_TOP - DB_BOT)) * s.geom.plotH;
    }
    function wireCanvas() {
      // Click = seek. Horizontal drag = pan the view. Drag near the orange line =
      // adjust the threshold. Wheel/pinch = zoom; trackpad horizontal scroll = pan.
      var c = el.silCanvas, dragging = null, downX = 0, downY = 0, moved = false, panV0 = 0, panV1 = 0;
      c.addEventListener("mousedown", function (e) {
        if (!s.data || !s.geom) return;
        var p = pointerTime(e, c); downX = p.x; downY = p.y; moved = false;
        dragging = Math.abs(p.y - thresholdY()) <= 8 ? "thr" : "maybe-pan";
        panV0 = s.v0; panV1 = s.v1; // pan is computed from the view at mousedown (no drift)
        e.preventDefault();
      });
      // Hover cursor: resize near the threshold line, crosshair (seek/pan) elsewhere.
      c.addEventListener("mousemove", function (e) {
        if (dragging || !s.data || !s.geom) return;
        var p = pointerTime(e, c);
        c.classList.toggle("thr-hover", Math.abs(p.y - thresholdY()) <= 8);
      });
      document.addEventListener("mousemove", function (e) {
        if (!dragging || !s.geom) return;
        var p = pointerTime(e, c);
        if (Math.abs(p.x - downX) > 3 || Math.abs(p.y - downY) > 3) moved = true;
        if (dragging === "thr") {
          var db = DB_BOT + (1 - (p.y - s.geom.padTop) / s.geom.plotH) * (DB_TOP - DB_BOT);
          setThreshold(db, false); recompute();
        } else if (moved) { // pan: shift the mousedown-time view by the dragged distance
          c.classList.add("panning");
          var dt = -((p.x - downX) / s.geom.plotW) * (panV1 - panV0);
          setView(panV0 + dt, panV1 + dt);
        }
      });
      document.addEventListener("mouseup", function (e) {
        if (!dragging) return;
        if (dragging === "maybe-pan" && !moved && s.geom) {
          var p = pointerTime(e, c);
          if (p.x >= s.geom.padL) {
            var t = s.v0 + ((p.x - s.geom.padL) / s.geom.plotW) * (s.v1 - s.v0);
            callHostDirect("setPlayhead", { seconds: t });
            s.playheadSec = t; draw(); // instant needle feedback (the poll confirms next tick)
            setStatus("Playhead → " + mmss(t));
          }
        }
        dragging = null;
        c.classList.remove("panning");
      });
      // wheel: vertical = zoom, horizontal (trackpad) = pan
      c.addEventListener("wheel", function (e) {
        if (!s.data) return; e.preventDefault();
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          var dt = (e.deltaX / Math.max(1, s.geom ? s.geom.plotW : 1)) * (s.v1 - s.v0);
          setView(s.v0 + dt, s.v1 + dt);
        } else {
          zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2);
        }
      }, { passive: false });
    }

    function wireOverview() {
      var c = el.silOverview, drag = false;
      function jump(e) {
        if (!s.data) return;
        var rect = c.getBoundingClientRect();
        var x = e.clientX - rect.left;
        var t = s.full0 + (x / rect.width) * (s.full1 - s.full0);
        var span = s.v1 - s.v0;
        setView(t - span / 2, t + span / 2);
      }
      c.addEventListener("mousedown", function (e) { drag = true; jump(e); });
      document.addEventListener("mousemove", function (e) { if (drag) jump(e); });
      document.addEventListener("mouseup", function () { drag = false; });
    }

    /* ----- wiring ----- */
    function wire() {
      cache();
      fillSlider();
      renderPresets(); // defaults render immediately (server presets refresh them on scan)
      el.silScanBtn.addEventListener("click", function () { scan(s.loaded); });
      el.thrSlider.addEventListener("input", function () { setThreshold(parseInt(el.thrSlider.value, 10), false); recompute(); });
      el.calcAi.addEventListener("click", calculateByAi);
      ["minSilence", "keepTalk", "marginBefore", "marginAfter"].forEach(function (id) {
        el[id].addEventListener("input", function () { readSettingsFromInputs(); highlightActivePreset(); recompute(); });
      });
      el.presetRow.addEventListener("click", function (e) {
        var del = e.target.closest("[data-del]");
        if (del) { delete s.customPresets[del.getAttribute("data-del")]; persistCustomPresets(); renderPresets(); return; }
        var b = e.target.closest("button"); if (!b) return;
        if (b.id === "addPreset") saveCurrentAsPreset();
        else if (b.getAttribute("data-preset")) applyPreset(b.getAttribute("data-preset"));
      });
      // Segmented controls: the selected pill is a JS-set .on class. (CEP's engine
      // has no :has() support, so a pure-CSS checked style never showed in Premiere.)
      function syncSegCtl(container) {
        var opts = container.querySelectorAll(".segopt");
        for (var i = 0; i < opts.length; i++) {
          var inp = opts[i].querySelector("input");
          opts[i].classList.toggle("on", !!(inp && inp.checked));
        }
      }
      // Silence Management: segmented control + a one-line caption for the choice.
      var MGMT_CAP = {
        remove: "Cut the silences and ripple the timeline tight.",
        keepSpaces: "Cut the silences but leave the gaps in place.",
        mute: "Keep the clips; their audio is muted.",
        keep: "Preview only. Applying makes no change.",
      };
      var mgmtRadios = document.getElementById("mgmtRadios");
      var mgmtCaption = $("mgmtCaption");
      mgmtRadios.addEventListener("change", function (e) {
        if (e.target.name === "mgmt") {
          s.mode = e.target.value;
          syncSegCtl(mgmtRadios);
          if (mgmtCaption) mgmtCaption.textContent = MGMT_CAP[s.mode] || "";
          updateSummary(); updateButtons();
        }
      });
      syncSegCtl(mgmtRadios);
      // Transitions: hovering an option previews its diagram; otherwise show the selection.
      var TRANS_CAP = {
        none: "Hard cut. Clean and instant.",
        jcut: "J-Cut: the next clip's audio leads in under the current video.",
        lcut: "L-Cut: the current audio tails out under the next clip's video.",
        overlap: "Overlap: the two audio tracks overlap evenly across the cut.",
        constant: "Constant Power: an equal-loudness audio crossfade.",
      };
      var transRadios = document.getElementById("transRadios");
      var transCaption = $("transCaption"), transViz = $("transViz");
      function showTransViz(key) {
        if (!transViz) return;
        var svgs = transViz.querySelectorAll("svg[data-viz]");
        for (var i = 0; i < svgs.length; i++) svgs[i].classList.toggle("show", svgs[i].getAttribute("data-viz") === key);
        if (transCaption) transCaption.textContent = TRANS_CAP[key] || "";
      }
      transRadios.addEventListener("change", function (e) {
        if (e.target.name === "trans") { s.transition = e.target.value; syncSegCtl(transRadios); showTransViz(s.transition); }
      });
      transRadios.addEventListener("mouseover", function (e) {
        var opt = e.target.closest(".segopt"); if (!opt) return;
        var input = opt.querySelector("input"); if (input) showTransViz(input.value);
      });
      transRadios.addEventListener("mouseleave", function () { showTransViz(s.transition); });
      syncSegCtl(transRadios);
      showTransViz(s.transition);
      // Parameter fields: hovering/focusing a field highlights its part of the
      // shared diagram and swaps the caption.
      var PARAM_CAP = {
        "": "How a cut is shaped: green margins are kept, the red span is removed.",
        minSilence: "Only quiet stretches at least this long become cuts. Shorter pauses are left alone.",
        keepTalk: "Isolated sounds shorter than this (pops, breaths, mic bumps) count as part of the silence and are removed with it. Short words next to real speech are safe.",
        marginBefore: "Air kept before the next words, so speech never starts abruptly.",
        marginAfter: "Air kept after the last words, so speech never ends clipped.",
      };
      var paramGrid = $("paramGrid"), paramViz = $("paramViz"), paramCaption = $("paramCaption");
      function setParamHl(key) {
        if (!paramViz) return;
        if (key) paramViz.setAttribute("data-hl", key); else paramViz.removeAttribute("data-hl");
        if (paramCaption) paramCaption.textContent = PARAM_CAP[key || ""] || PARAM_CAP[""];
      }
      if (paramGrid) {
        paramGrid.addEventListener("mouseover", function (e) {
          var f = e.target.closest("[data-param]");
          if (f) setParamHl(f.getAttribute("data-param"));
        });
        paramGrid.addEventListener("mouseleave", function () {
          var focused = document.activeElement && paramGrid.contains(document.activeElement) ? document.activeElement.closest("[data-param]") : null;
          setParamHl(focused ? focused.getAttribute("data-param") : null);
        });
        paramGrid.addEventListener("focusin", function (e) {
          var f = e.target.closest("[data-param]");
          if (f) setParamHl(f.getAttribute("data-param"));
        });
        paramGrid.addEventListener("focusout", function () { setParamHl(null); });
      }
      el.cutBtn.addEventListener("click", cut);
      el.silStopBtn.addEventListener("click", stop);
      el.silStopBtn2.addEventListener("click", stop);
      el.silUndoBtn.addEventListener("click", undo);
      el.zoomIn.addEventListener("click", function () { zoom(1 / 1.6); });
      el.zoomOut.addEventListener("click", function () { zoom(1.6); });
      el.zoomFit.addEventListener("click", fit);
      loadFollow();
      if (el.silFollow) {
        el.silFollow.checked = s.follow;
        el.silFollow.addEventListener("change", function () {
          s.follow = el.silFollow.checked; persistFollow();
          if (s.follow) snapToPlayhead();
        });
      }
      wireCanvas(); wireOverview();
      window.addEventListener("resize", function () { if (activeTab === "silence") draw(); });
    }

    function onShow() {
      s.snapNext = true; // re-center on the playhead when the tab comes into view
      draw(); // scan is explicit (the Scan Audio button) — no auto-scan on open
      startPoll(); // playhead follow (self-gates until audio is scanned)
    }
    function onHide() { stopPoll(); }

    return { wire: wire, onShow: onShow, onHide: onHide, updateButtons: updateButtons, applyPushedConfig: applyPushedConfig, markUndoable: markUndoable, clearUndoable: clearUndoable };
  })();

  /* ================================================================
   *  RETAKES (transcript-based; Claude does the analysis)
   * ================================================================ */
  var Retake = (function () {
    var state = {
      segments: [], loaded: false, busy: false, undoAvailable: false,
      // playhead sync + reconciliation:
      follow: true,          // auto-scroll the list to the playhead (user toggle)
      liveMap: {},           // index -> { state:'present'|'partial'|'absent', s:liveStartSec, e:liveEndSec }
      currentIndex: null,    // segment index currently under the playhead
      pollTimer: null, pollInFlight: false,
      mapRefreshAt: 0, mapRefreshing: false,
    };
    var POLL_MS = 300, MAP_LAZY_MS = 4000;
    var expanded = {};
    var groupExpanded = {}; // collapsed runs of consecutive "Removed" segments (key = first seg index)
    var GROUP_COLORS = ["#5a8cff", "#d9a441", "#c77dff", "#4fd1c5", "#f06595", "#9ccc65", "#ff8a65", "#7e9cff"];
    var UNDO_LABEL = "Undo last apply";
    var el = {};

    function cache() {
      ["loadBtn", "aiBtn", "retakeStopBtn", "statusbar", "segments", "removeGaps", "trimExcess", "applyBtn", "softApplyBtn", "clearMarkersBtn", "exportBtn", "undoBtn", "startOverBtn", "summary", "followToggle"].forEach(function (id) { el[id] = $(id); });
    }
    function loadFollow() { try { state.follow = window.localStorage.getItem("editagent.retake.follow") !== "0"; } catch (e) { state.follow = true; } }
    function persistFollow() { try { window.localStorage.setItem("editagent.retake.follow", state.follow ? "1" : "0"); } catch (e) {} }
    function groupColor(g) { return g == null ? "#4fb477" : GROUP_COLORS[Math.abs(g) % GROUP_COLORS.length]; }
    function setStatus(text, isErr) { el.statusbar.textContent = text || ""; el.statusbar.className = "statusbar" + (isErr ? " err" : ""); }
    function setBusy(b) { state.busy = b; updateButtons(); }

    function loadSegments() {
      // Transcription needs an ElevenLabs key — if we know there isn't one,
      // open the key modal instead of letting the load fail with an .env error.
      if (connected() && AI.keyMissing()) { AI.openKeyModal("Loading segments transcribes the timeline with ElevenLabs. Add your API key below, then click Load segments again."); return; }
      setBusy(true); setStatus("Loading…"); setLoading(el.loadBtn, true, "Loading…");
      el.segments.innerHTML = skeletonRows();
      callServer("loadSegments", { transcribe_model: AI.sttModel() }, function (m) { setStatus(m); }).then(
        function (res) {
          state.segments = res.segments || [];
          state.liveMap = {}; // indexes are fresh; a stale map would mislabel rows until refreshMap lands
          state.loaded = true; expanded = {}; groupExpanded = {};
          var fr = res.fragments || {};
          var extra = (fr.autoCut ? " · " + fr.autoCut + " pop(s) auto-cut" : "") + (fr.flagged ? " · " + fr.flagged + " flagged" : "");
          setStatus(state.segments.length + " segments loaded" + extra + (res.skipped && res.skipped.length ? " (" + res.skipped.length + " clip(s) skipped)" : ""));
          setLoading(el.loadBtn, false, "Reload"); render(); setBusy(false);
          refreshMap(true); // reconcile positions for playhead-sync + re-insert state
        },
        function (err) {
          var cancelled = /cancel/i.test(err.message);
          var keyIssue = AI.handleKeyError(err); // missing/rejected key → the key modal explains it
          setStatus(cancelled ? "Stopped." : keyIssue ? "Add your ElevenLabs API key, then Load again." : err.message, !cancelled && !keyIssue);
          setLoading(el.loadBtn, false, state.loaded ? "Reload" : "Load segments"); setBusy(false); render();
        }
      );
    }
    function stop() { if (!state.busy) return; callServer("cancel", {}).catch(function () {}); setStatus("Stopping…"); }
    function analyze() {
      if (state.busy) return;
      // Sync mode: defer to the Claude Code chat (it pushes marks via reviewUpdate).
      if (AI.sync()) {
        toast("In Claude Code chat, ask: “analyze the retakes on my timeline and cut the duplicates.” Claude marks Keep/Cut here; then review and Apply All.");
        setStatus("Sync mode: ask Claude in chat to analyze. Its Keep/Cut marks appear here automatically.");
        return;
      }
      // Headless (default): Claude analyzes here and pushes the marks for review.
      if (!connected()) { setStatus("Not connected.", true); return; }
      // Analyzing an unloaded timeline transcribes first, which needs the key.
      if (!state.loaded && AI.keyMissing()) { AI.openKeyModal("Analyzing transcribes the timeline with ElevenLabs first. Add your API key below, then click Analyze again."); return; }
      setBusy(true); setStatus("Claude is analyzing the retakes…"); setLoading(el.aiBtn, true, "Analyzing…");
      callServer("aiRetakes", AI.params(), function (m) { setStatus(m); }).then(
        function (res) {
          setLoading(el.aiBtn, false, "Analyze w/ Claude"); setBusy(false);
          // The Keep/Cut marks themselves arrive via the reviewUpdate push (markDecisions).
          var cut = (res && res.cut != null) ? res.cut : 0;
          setStatus("Claude marked " + cut + " segment(s) to cut. Review below, then Apply All.");
          toast("Claude analyzed " + (res && res.analyzed != null ? res.analyzed : state.segments.length) + " segment(s) · " + cut + " to cut.", "success");
        },
        function (err) {
          setLoading(el.aiBtn, false, "Analyze w/ Claude"); setBusy(false);
          var cancelled = /cancel/i.test(err.message);
          var keyIssue = AI.handleKeyError(err);
          setStatus(cancelled ? "AI cancelled." : keyIssue ? "Add your ElevenLabs API key, then Analyze again." : err.message, !cancelled && !keyIssue);
        }
      );
    }
    function applyReviewUpdate(segments) {
      if (!Array.isArray(segments)) return;
      state.segments = segments; state.loaded = true;
      if (lblText(el.loadBtn) === "Load segments") setLabel(el.loadBtn, "Reload");
      var cuts = segments.filter(function (s) { return s.decision === "cut" && !s.protected; }).length;
      setStatus("Claude marked " + cuts + " segment(s) to cut. Review below, then Apply All.");
      render();
      refreshMap(true); // the pushed list may be freshly rebuilt; re-reconcile before trusting absent states
    }
    function applyAll() {
      var trimming = el.trimExcess && el.trimExcess.checked;
      var cuts = state.segments.filter(function (s) { return s.decision === "cut" && !s.protected; });
      if (!cuts.length && !trimming) { toast("Nothing marked Cut."); return; }
      if (cuts.length && !cuts.some(function (s) { return !isAbsent(s); }) && !trimming) {
        toast("Those cuts are already removed from the timeline. Nothing left to apply.", "info");
        return;
      }
      setBusy(true); setStatus("Applying…"); setLoading(el.applyBtn, true, "Applying…");
      var payload = state.segments.map(function (s) { return { index: s.index, startFrame: s.startFrame, endFrame: s.endFrame, decision: s.decision, protected: s.protected }; });
      callServer("applyDecisions", { segments: payload, removeGaps: el.removeGaps.checked, trimExcess: trimming }, function (m) { setStatus(m); }).then(
        function (res) {
          if (res.undoable) { state.undoAvailable = true; Silence.clearUndoable(); } // shared single undo point
          setStatus(res.message || "Applied.");
          toast(res.message || ("Applied " + res.applied + " cut(s)."), "success");
          setLoading(el.applyBtn, false, "Apply All"); setBusy(false);
          refreshMap(true); // cuts removed → refresh Removed badges + live positions
        },
        function (err) {
          var cancelled = /cancel/i.test(err.message);
          setStatus(cancelled ? "Stopped." : err.message, !cancelled);
          setLoading(el.applyBtn, false, "Apply All"); setBusy(false);
        }
      );
    }

    // Soft Apply: mark the retake groups on the timeline (colored sequence markers)
    // instead of deleting — a gentler companion to Apply All. Review and trim by hand.
    function softApply() {
      if (state.busy) return;
      if (!connected()) { setStatus("Not connected.", true); return; }
      var hasCuts = state.segments.some(function (s) { return s.decision === "cut" && !s.protected; });
      if (!hasCuts) { toast("Nothing to mark yet. Run “Analyze w/ Claude” to find retake groups."); return; }
      setBusy(true); setStatus("Marking the timeline…"); setLoading(el.softApplyBtn, true, "Marking…");
      var payload = state.segments.map(function (s) { return { index: s.index, decision: s.decision, protected: s.protected, group: s.group }; });
      callServer("softApply", { segments: payload }, function (m) { setStatus(m); }).then(
        function (res) {
          setLoading(el.softApplyBtn, false, "Soft Apply"); setBusy(false);
          setStatus(res.message || ("Marked " + (res.created || 0) + " span(s) on the timeline."));
          toast(res.message || "Marked the timeline.", res.created ? "success" : "info");
        },
        function (err) {
          setLoading(el.softApplyBtn, false, "Soft Apply"); setBusy(false);
          var cancelled = /cancel/i.test(err.message);
          setStatus(cancelled ? "Stopped." : err.message, !cancelled);
        }
      );
    }

    // Remove the markers Soft Apply added (server clears only OpenCutAgent-tagged markers,
    // never the user's own).
    function clearMarkers() {
      if (state.busy || !connected()) return;
      setBusy(true); setLoading(el.clearMarkersBtn, true, "Clearing…");
      callServer("clearMarkers", {}).then(
        function (res) {
          setLoading(el.clearMarkersBtn, false, "Clear markers"); setBusy(false);
          toast(res.message || "Cleared markers.", "success"); setStatus(res.message || "Cleared markers.");
        },
        function (err) {
          setLoading(el.clearMarkersBtn, false, "Clear markers"); setBusy(false);
          setStatus(err.message, true);
        }
      );
    }

    // Export the kept speech ("what's actually on the timeline") as a YouTube-ready .srt
    // subtitle file. Honors the ripple checkbox: checked => caption times match the
    // tightened cut (gaps closed); unchecked => absolute timeline positions.
    function exportTranscript() {
      if (state.busy) return;
      if (!connected()) { setStatus("Not connected.", true); return; }
      if (!state.loaded) { toast("Load segments first."); return; }
      var hasSpeech = state.segments.some(function (s) {
        return s.decision !== "cut" && s.fragment !== "empty" && s.wordCount > 0 && s.text && String(s.text).trim();
      });
      if (!hasSpeech) { toast("No kept speech to export. Analyze or keep some segments first."); return; }
      setBusy(true); setLoading(el.exportBtn, true, "Exporting…"); setStatus("Building the transcript…");
      callServer("exportTranscript", { compact: el.removeGaps.checked }).then(
        function (res) {
          setLoading(el.exportBtn, false, "Export transcript"); setBusy(false);
          if (!res || !res.cues || !res.srt) { toast((res && res.message) || "Nothing to export.", "info"); setStatus((res && res.message) || ""); return; }
          saveTextFile(res.filename || "transcript.srt", "srt", res.srt, function (ok, pathOut, err) {
            if (ok) { toast("Saved " + res.cues + " captions to " + pathOut, "success"); setStatus("Transcript (" + res.cues + " captions) saved to " + pathOut); }
            else if (err === "cancelled") { setStatus("Export cancelled."); }
            else { toast("Couldn't save the file: " + err, "error"); setStatus("Couldn't save the transcript: " + err, true); }
          });
        },
        function (err) {
          setLoading(el.exportBtn, false, "Export transcript"); setBusy(false);
          toast(err.message, "error"); setStatus(err.message, true);
        }
      );
    }

    // One-click revert of the last apply (server reconstructs from its snapshot).
    function undo() {
      if (!state.undoAvailable || state.busy) return;
      setBusy(true); setStatus("Reverting the timeline…"); setLoading(el.undoBtn, true, "Undoing…");
      callServer("undoLastApply", {}, function (m) { setStatus(m); }).then(
        function (res) {
          setLoading(el.undoBtn, false, UNDO_LABEL); setBusy(false);
          if (res.ok) { state.undoAvailable = false; Silence.clearUndoable(); toast(res.message, "success"); setStatus(res.message); loadSegments(); }
          else { toast(res.message, "error"); setStatus(res.message, true); }
        },
        function (err) { setLoading(el.undoBtn, false, UNDO_LABEL); setBusy(false); setStatus(err.message, true); }
      );
    }
    function markUndoable() { state.undoAvailable = true; updateButtons(); }
    function clearUndoable() { state.undoAvailable = false; updateButtons(); }
    function startOver() { if (state.busy) return; loadSegments(); }

    /* ----- playhead sync + live reconciliation (shared by highlight + re-insert) ----- */
    function setMap(arr) {
      var m = {};
      for (var i = 0; arr && i < arr.length; i++) { var e = arr[i]; m[e.index] = { state: e.state, s: e.liveStartSec, e: e.liveEndSec }; }
      state.liveMap = m;
    }
    // Pull a fresh present/partial/absent + live-position map from the server.
    // render=true rebuilds rows (Removed badge / Re-insert buttons); else just re-highlights.
    function refreshMap(doRender) {
      if (!connected() || !state.loaded || state.mapRefreshing) return;
      state.mapRefreshing = true; state.mapRefreshAt = Date.now();
      callServer("timelineMap", {}).then(
        function (res) { state.mapRefreshing = false; setMap(res && res.map); if (doRender) render(); else reapplyCurrent(); },
        function () { state.mapRefreshing = false; } // keep the last good map on failure
      );
    }
    function reapplyCurrent() {
      if (state.currentIndex == null || !el.segments) return;
      var row = el.segments.querySelector('.seg[data-i="' + state.currentIndex + '"]');
      if (row) row.classList.add("current");
    }
    function updateHighlight(sec) {
      var found = null, i, m;
      for (i = 0; i < state.segments.length; i++) {
        m = state.liveMap[state.segments[i].index];
        if (!m || m.state === "absent" || m.s == null) continue;
        if (sec >= m.s && sec < m.e) { found = state.segments[i].index; break; }
      }
      if (found === state.currentIndex) return;
      var prev = el.segments.querySelector(".seg.current");
      if (prev) prev.classList.remove("current");
      state.currentIndex = found;
      if (found == null) return;
      var row = el.segments.querySelector('.seg[data-i="' + found + '"]');
      if (!row) return;
      row.classList.add("current");
      if (state.follow) {
        var r = row.getBoundingClientRect(), cr = el.segments.getBoundingClientRect();
        if (r.top < cr.top || r.bottom > cr.bottom) row.scrollIntoView({ block: "nearest" });
      }
    }
    function pollTick() {
      if (activeTab !== "retake" || !connected() || !state.loaded || state.busy || hostBusy() || state.pollInFlight) return;
      if (Date.now() - state.mapRefreshAt > MAP_LAZY_MS) refreshMap(false); // catch edits made outside the panel
      state.pollInFlight = true;
      callHostDirect("getPlayhead", {}, function (r) {
        state.pollInFlight = false;
        if (r && r.status === "OK" && r.result && r.result.seconds != null) updateHighlight(r.result.seconds);
      });
    }
    function startPoll() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = setInterval(pollTick, POLL_MS); }
    function stopPoll() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }
    function onShow() { if (state.loaded) refreshMap(true); startPoll(); }
    function onHide() {
      stopPoll();
      state.currentIndex = null;
      var prev = el.segments ? el.segments.querySelector(".seg.current") : null;
      if (prev) prev.classList.remove("current");
    }

    // Move Premiere's playhead to where this segment currently sits (click-to-seek).
    function seekTo(index) {
      var m = state.liveMap[index];
      var sec = (m && m.s != null) ? m.s : null;
      if (sec == null) { var sg = segByIndex(index); if (sg) sec = sg.startSec; } // fallback to original start
      if (sec != null) { callHostDirect("setPlayhead", { seconds: sec }); setStatus("Playhead → " + mmss(sec)); }
    }
    // Re-insert a removed cut right before the next surviving clip.
    function doReinsert(index, btnEl) {
      if (state.busy) return;
      // Busy like every other timeline mutation: keeps Apply/Analyze/Load
      // disabled and pauses the poll's map refreshes while the host inserts
      // (a poll-started refresh would make the success refreshMap(true) below
      // early-return and leave the row list stale with a stuck spinner).
      setBusy(true);
      if (btnEl) { btnEl.disabled = true; setLoading(btnEl, true, "Re-inserting…"); }
      var settle = function () {
        setBusy(false);
        if (btnEl) { btnEl.disabled = false; setLoading(btnEl, false, "Re-insert"); }
      };
      callServer("reinsertSegment", { index: index }, function (msg) { setStatus(msg); }).then(
        function (res) {
          settle();
          if (res && res.ok) {
            var s = segByIndex(index);
            if (s) { s.decision = "keep"; s.manual = true; }
            toast(res.message || "Re-inserted. Cmd+Z in Premiere to undo.", "success");
            setStatus(res.message || "Re-inserted.");
          } else {
            toast((res && res.message) || "Re-insert didn't land.", "error");
            setStatus((res && res.message) || "Re-insert didn't land.", true);
          }
          refreshMap(true); // fresh positions + buttons either way
        },
        function (err) {
          settle();
          toast(err.message, "error"); setStatus(err.message, true);
        }
      );
    }

    function updateButtons() {
      if (!el.loadBtn) return;
      setBusyBar("ret", state.busy);
      el.loadBtn.disabled = !connected() || state.busy;
      el.aiBtn.disabled = !connected() || state.busy;
      el.retakeStopBtn.style.display = state.busy ? "" : "none";
      // Only cuts still ON the timeline count — after an apply the marked segments
      // go "absent" and there is nothing left for Apply All / Soft Apply to do.
      // With "Remove excess" checked, Apply also has trim work even with zero cuts.
      var hasCuts = state.segments.some(function (s) { return isPendingCut(s); });
      var trimming = state.loaded && el.trimExcess && el.trimExcess.checked;
      el.applyBtn.disabled = !connected() || state.busy || (!hasCuts && !trimming);
      // Soft Apply marks the same content non-destructively (cuts incl. no-speech empties).
      if (el.softApplyBtn) el.softApplyBtn.disabled = !connected() || state.busy || !hasCuts;
      if (el.clearMarkersBtn) {
        el.clearMarkersBtn.style.display = state.loaded ? "" : "none"; // always available once loaded
        el.clearMarkersBtn.disabled = !connected() || state.busy;
      }
      el.startOverBtn.disabled = state.busy || !state.loaded;
      // Export the kept speech as .srt — available once there's a loaded timeline.
      if (el.exportBtn) el.exportBtn.disabled = !connected() || state.busy || !state.loaded;
      el.undoBtn.style.display = (state.undoAvailable && !state.busy) ? "" : "none";
      el.undoBtn.disabled = !connected();
      updateSummary();
    }
    // Estimated seconds "Remove excess" would trim: the non-speech air around the
    // words of each pending Keep. Mirrors the server's computeExcessRanges defaults
    // (0.15s pad, 0.2s minimum span); an estimate, so the footer shows "~".
    function excessEstimateSec() {
      var PAD = 0.15, MIN = 0.2, total = 0;
      for (var i = 0; i < state.segments.length; i++) {
        var s = state.segments[i];
        if (s.decision === "cut" || s.protected || !(s.wordCount > 0)) continue;
        if (s.sourceSpeechInSec == null || s.sourceSpeechOutSec == null || s.sourceInSec == null || s.sourceOutSec == null) continue;
        if (isAbsent(s)) continue;
        var lead = (s.sourceSpeechInSec - PAD) - s.sourceInSec;
        var trail = s.sourceOutSec - (s.sourceSpeechOutSec + PAD);
        if (lead >= MIN) total += lead;
        if (trail >= MIN) total += trail;
      }
      return total;
    }
    function updateSummary() {
      if (!state.loaded) { el.summary.textContent = ""; return; }
      // Pending cuts (still on the timeline) and already-removed ones are different
      // stories: counting removed cuts as "to cut" made Apply All look broken.
      var pending = state.segments.filter(function (s) { return isPendingCut(s); });
      var removed = state.segments.filter(function (s) { return s.decision === "cut" && !s.protected && isAbsent(s); }).length;
      var secs = pending.reduce(function (a, s) { return a + (s.durationSec || 0); }, 0);
      var flagged = state.segments.filter(function (s) { return s.fragment === "short"; }).length;
      var excess = (el.trimExcess && el.trimExcess.checked) ? excessEstimateSec() : 0;
      el.summary.textContent =
        state.segments.length + " segments · " + pending.length + " to cut · ~" + secs.toFixed(1) + "s to remove" +
        (excess >= 0.2 ? " · ~" + excess.toFixed(1) + "s excess" : "") +
        (removed ? " · " + removed + " removed" : "") +
        (flagged ? " · " + flagged + " flagged" : "");
    }
    function isAbsent(s) { var lm = state.liveMap[s.index]; return !!(lm && lm.state === "absent"); } // removed from timeline → re-insertable
    function isPendingCut(s) { return s.decision === "cut" && !s.protected && !isAbsent(s); } // cut mark with footage still on the timeline
    function segRowHtml(s) {
      var isCut = s.decision === "cut" && !s.protected;
      var open = !!expanded[s.index];
      var absent = isAbsent(s);
      // Times prefer the LIVE reconciled position: after any apply the stored
      // startSec/endSec go stale (everything downstream ripples left). Absent
      // segments keep their original times as a historical reference.
      var lm = state.liveMap[s.index];
      var live = !absent && lm && lm.s != null;
      var tStart = live ? lm.s : s.startSec;
      var tEnd = live && lm.e != null ? lm.e : s.endSec;
      // "open" un-truncates the main-row text via CSS — the detail pane only adds
      // meta + actions, never a second copy of the text.
      var html = '<div class="seg' + (isCut ? " cut" : "") + (s.fragment ? " frag" : "") + (absent ? " absent" : "") + (open ? " open" : "") + '" data-i="' + s.index + '">';
      html += '<div class="seg-main" data-act="expand">';
      html += '<span class="seg-dot" style="background:' + groupColor(s.group) + '"></span>';
      html += '<span class="seg-time" data-act="seek" title="Jump the playhead here">' + mmss(tStart) + "</span>";
      html += '<span class="seg-text">' + esc(s.text) + "</span>";
      html += '<span class="seg-badges">';
      if (absent) html += '<span class="badge removed">Removed</span>';
      if (s.fragment === "empty") html += '<span class="badge frag">No speech</span>';
      else if (s.fragment === "short") html += '<span class="badge frag">Short</span>';
      if (s.protected) html += '<span class="badge prot"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>Protected</span>';
      if (s.manual) html += '<span class="badge manual">Manual</span>';
      html += '<span class="badge ' + (isCut ? "cut" : "keep") + '">' + (isCut ? "Cut" : "Keep") + "</span>";
      html += "</span></div>";
      if (open) {
        html += '<div class="seg-detail">';
        html += '<div class="seg-meta">' + mmss(tStart) + " – " + mmss(tEnd) + (s.reason ? " · " + esc(s.reason) : "") + (s.protected ? " · [Protected]" : "") + "</div>";
        html += '<div class="seg-actions">';
        if (absent && !s.protected) html += '<button data-act="reinsert" class="reinsert"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.7 3L3 13"/></svg><span class="lbl">Re-insert</span></button>';
        else html += '<button data-act="toggle">Mark as ' + (s.decision === "cut" ? "Keep" : "Cut") + "</button>";
        html += '<button data-act="protect">' + (s.protected ? "Unprotect" : "Protect") + "</button>";
        html += "</div></div>";
      }
      html += "</div>";
      return html;
    }
    // A run of consecutive similar segments collapses into one accordion (closed by
    // default). Used for "Removed" runs and for auto-cut no-speech runs (pops).
    function runGroupHtml(run, countLabel, tip) {
      var key = run[0].index, openG = !!groupExpanded[key];
      var range = mmss(run[0].startSec) + " – " + mmss(run[run.length - 1].startSec);
      var html = '<div class="seg-group' + (openG ? " open" : "") + '">';
      html += '<div class="seg-group-head" data-act="grp" data-grp="' + key + '" data-tip="' + esc(tip) + '">';
      html += '<svg class="grp-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
      html += '<span class="grp-count">' + run.length + " " + countLabel + "</span>";
      html += '<span class="grp-range">' + range + "</span></div>";
      if (openG) {
        html += '<div class="seg-group-body">';
        for (var k = 0; k < run.length; k++) html += segRowHtml(run[k]);
        html += "</div>";
      }
      html += "</div>";
      return html;
    }
    // Auto-cut no-speech clips (pops, breaths) that are still on the timeline; a
    // stretch of them is noise in the list, so it folds into one accordion row.
    function isEmptyCut(s) { return s.fragment === "empty" && s.decision === "cut" && !s.protected && !isAbsent(s); }
    function render() {
      if (!state.segments.length) {
        el.segments.innerHTML = '<div class="empty-state"><div class="es-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg></div><div class="es-title">No segments loaded</div><div class="es-sub">Open a sequence in Premiere, then <b>Load segments</b> to transcribe the timeline.</div></div>';
        updateButtons(); return;
      }
      var html = "", i = 0, j, run;
      while (i < state.segments.length) {
        if (isAbsent(state.segments[i])) {
          j = i; while (j < state.segments.length && isAbsent(state.segments[j])) j++;
          run = state.segments.slice(i, j);
          html += run.length >= 2 ? runGroupHtml(run, "removed", "A stretch of cuts already removed from the timeline. Click to review them or re-insert one.") : segRowHtml(run[0]); // group only a real "bunch"
          i = j;
        } else if (isEmptyCut(state.segments[i])) {
          j = i; while (j < state.segments.length && isEmptyCut(state.segments[j])) j++;
          run = state.segments.slice(i, j);
          html += run.length >= 2 ? runGroupHtml(run, "no speech", "Clips with no detected words (pops, breaths), cut automatically. Click to review; open one to keep it.") : segRowHtml(run[0]);
          i = j;
        } else {
          html += segRowHtml(state.segments[i]); i++;
        }
      }
      el.segments.innerHTML = html;
      updateButtons();
      reapplyCurrent();
    }
    function segByIndex(i) { for (var k = 0; k < state.segments.length; k++) if (state.segments[k].index === i) return state.segments[k]; return null; }

    function wire() {
      cache();
      el.segments.addEventListener("click", function (ev) {
        var actEl = ev.target.closest("[data-act]"); if (!actEl) return;
        var act = actEl.getAttribute("data-act");
        if (act === "grp") { var key = actEl.getAttribute("data-grp"); groupExpanded[key] = !groupExpanded[key]; render(); return; }
        var segEl = ev.target.closest(".seg"); if (!segEl) return;
        var i = parseInt(segEl.getAttribute("data-i"), 10);
        var s = segByIndex(i); if (!s) return;
        if (act === "seek") { seekTo(i); }
        else if (act === "reinsert") { doReinsert(i, actEl); }
        else if (act === "expand") { seekTo(i); expanded[i] = !expanded[i]; render(); } // click a segment -> move the playhead there + toggle detail
        else if (act === "toggle") { s.decision = s.decision === "cut" ? "keep" : "cut"; s.manual = true; if (s.decision === "cut") s.protected = false; render(); }
        else if (act === "protect") { s.protected = !s.protected; s.manual = true; if (s.protected) s.decision = "keep"; render(); }
      });
      el.loadBtn.addEventListener("click", loadSegments);
      el.aiBtn.addEventListener("click", analyze);
      el.retakeStopBtn.addEventListener("click", stop);
      el.applyBtn.addEventListener("click", applyAll);
      if (el.trimExcess) el.trimExcess.addEventListener("change", updateButtons); // re-gate Apply + refresh the excess estimate
      el.softApplyBtn.addEventListener("click", softApply);
      el.clearMarkersBtn.addEventListener("click", clearMarkers);
      el.startOverBtn.addEventListener("click", startOver);
      if (el.exportBtn) el.exportBtn.addEventListener("click", exportTranscript);
      el.undoBtn.addEventListener("click", undo);
      if (el.followToggle) {
        loadFollow();
        el.followToggle.checked = state.follow;
        el.followToggle.addEventListener("change", function () { state.follow = el.followToggle.checked; persistFollow(); });
      }
    }

    // setMap is exposed for browser QA (inject a fake reconcile map alongside
    // applyReviewUpdate to exercise Removed badges / stale-cut states, no server).
    // segments/liveMap/isLoaded feed the Animation tab's segment picker (one
    // shared loaded transcript; the Animation tab never re-transcribes).
    return {
      wire: wire, updateButtons: updateButtons, applyReviewUpdate: applyReviewUpdate, setMap: setMap,
      markUndoable: markUndoable, clearUndoable: clearUndoable, onShow: onShow, onHide: onHide, refreshMap: refreshMap,
      segments: function () { return state.segments; },
      liveMap: function () { return state.liveMap; },
      isLoaded: function () { return state.loaded; },
    };
  })();

  /* ================================================================
   *  ANIMATION — pick a contiguous run of segments, then chat with a
   *  headless Claude agent (subscription) that builds a Remotion
   *  animation for that range; the server renders it and places the
   *  clip on V2 automatically when the agent signals it's ready.
   *  Segments come from the Retakes tab's loaded transcript (shared).
   * ================================================================ */
  var Anim = (function () {
    var MAX_IMGS = 4, MAX_IMG_BYTES = 8 * 1024 * 1024;
    var state = {
      styles: [], stylesLoaded: false,
      style: "excalidraw", background: "solid",
      jobs: [], stateLoaded: false,
      activeJobId: null,
      selection: [], anchor: null,
      busy: false,          // a create / chat turn / render is in flight
      pendingImgs: [],      // [{name, data(base64)}] queued for the next message
      liveText: null,       // the streaming assistant bubble's text node
      liveMsg: null,        // the streaming assistant bubble element
    };
    var el = {};

    function cache() {
      ["animStyle", "animBgCtl", "animBackBtn", "animSelect", "animStatus", "animJobs", "animSegs",
       "animSelSummary", "animCreateBtn", "animChatWrap", "animJobInfo", "animChatLog", "animChatStatus",
       "animAttach", "animText", "animSendBtn", "animStopBtn", "animImgBtn", "animFile"]
        .forEach(function (id) { el[id] = $(id); });
    }
    function loadPrefs() {
      try {
        state.style = window.localStorage.getItem("editagent.anim.style") || "excalidraw";
        state.background = window.localStorage.getItem("editagent.anim.bg") === "transparent" ? "transparent" : "solid";
      } catch (e) {}
    }
    function persistPrefs() {
      try {
        window.localStorage.setItem("editagent.anim.style", state.style);
        window.localStorage.setItem("editagent.anim.bg", state.background);
      } catch (e) {}
    }
    function setStatus(text, isErr) { el.animStatus.textContent = text || ""; el.animStatus.className = "statusbar" + (isErr ? " err" : ""); }
    function setChatStatus(text) { el.animChatStatus.textContent = text || ""; }
    function activeJob() { for (var i = 0; i < state.jobs.length; i++) if (state.jobs[i].id === state.activeJobId) return state.jobs[i]; return null; }

    /* ---- eligible segments: the loaded transcript minus removed ones ---- */
    function eligible() {
      var segs = Retake.segments() || [];
      var lm = Retake.liveMap() || {};
      var out = [], i, m;
      for (i = 0; i < segs.length; i++) {
        m = lm[segs[i].index];
        if (m && m.state === "absent") continue; // gone from the timeline — nothing to animate over
        out.push(segs[i]);
      }
      return out;
    }
    function segTimes(s) {
      var lm = Retake.liveMap() || {};
      var m = lm[s.index];
      return { s: m && m.s != null ? m.s : s.startSec, e: m && m.e != null ? m.e : s.endSec };
    }

    /* ---- contiguous selection (click = start/extend/shrink, shift-click = range) ---- */
    function toggleSelect(i, shift) {
      var ord = eligible().map(function (s) { return s.index; });
      var pos = ord.indexOf(i);
      if (pos < 0) return;
      var sel = state.selection;
      if (shift && state.anchor != null && ord.indexOf(state.anchor) >= 0) {
        var a = ord.indexOf(state.anchor);
        state.selection = ord.slice(Math.min(a, pos), Math.max(a, pos) + 1);
      } else if (sel.length && sel.indexOf(i) >= 0) {
        // clicking an endpoint shrinks the run; clicking inside (or a single) clears it
        if (sel.length > 1 && i === sel[0]) state.selection = sel.slice(1);
        else if (sel.length > 1 && i === sel[sel.length - 1]) state.selection = sel.slice(0, -1);
        else { state.selection = []; state.anchor = null; }
      } else if (sel.length) {
        var first = ord.indexOf(sel[0]), last = ord.indexOf(sel[sel.length - 1]);
        if (pos === first - 1) state.selection = [i].concat(sel);       // grow left
        else if (pos === last + 1) state.selection = sel.concat([i]);   // grow right
        else { state.selection = [i]; state.anchor = i; }               // not adjacent — start over
      } else {
        state.selection = [i]; state.anchor = i;
      }
      renderSegs(); updateButtons();
    }
    function selectionSpan() {
      if (!state.selection.length) return null;
      var segs = Retake.segments() || [];
      var byIdx = {}, i;
      for (i = 0; i < segs.length; i++) byIdx[segs[i].index] = segs[i];
      var first = byIdx[state.selection[0]], last = byIdx[state.selection[state.selection.length - 1]];
      if (!first || !last) return null;
      return { start: segTimes(first).s, end: segTimes(last).e };
    }

    /* ---- rendering: jobs list, segment picker, chat ---- */
    function jobBadge(j) {
      if (j.placed && j.placed.ok) return '<span class="badge keep">On V' + ((j.placed.trackIndex || 1) + 1) + " · v" + esc(j.placed.version) + "</span>";
      if (j.lastRenderedVersion) return '<span class="badge manual">Rendered v' + esc(j.lastRenderedVersion) + "</span>";
      return '<span class="badge frag">Draft</span>';
    }
    function renderJobs() {
      if (!state.jobs.length) { el.animJobs.innerHTML = ""; return; }
      var html = '<div class="anim-jobs-title">Animations in this project</div>', i;
      for (i = 0; i < state.jobs.length; i++) {
        var j = state.jobs[i];
        html += '<div class="anim-job" data-job="' + esc(j.id) + '">' +
          '<span class="anim-job-name">' + esc(j.id) + "</span>" +
          '<span class="anim-job-meta">' + (j.durationSec != null ? j.durationSec.toFixed(1) + "s" : "") +
          (j.range ? " · " + mmss(j.range.startSec) + "–" + mmss(j.range.endSec) : "") +
          " · " + esc(j.background === "transparent" ? "no bg" : "solid") + "</span>" +
          '<span class="seg-badges">' + jobBadge(j) + "</span>" +
          "</div>";
      }
      el.animJobs.innerHTML = html;
    }
    function renderSegs() {
      var loaded = Retake.isLoaded();
      if (!loaded) {
        el.animSegs.innerHTML = '<div class="empty-state"><div class="es-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><rect x="3" y="16" width="18" height="5" rx="1.5"/></svg></div><div class="es-title">No segments loaded</div><div class="es-sub">Load segments in the <b>Retakes</b> tab first, then pick a run of neighboring segments here to animate over.</div></div>';
        return;
      }
      var segs = eligible();
      if (!segs.length) {
        el.animSegs.innerHTML = '<div class="empty-state"><div class="es-title">Nothing on the timeline</div><div class="es-sub">Every loaded segment was removed. Reload segments in the Retakes tab.</div></div>';
        return;
      }
      var selSet = {}, i;
      for (i = 0; i < state.selection.length; i++) selSet[state.selection[i]] = 1;
      var html = '<div class="anim-hint">Click a segment to start a selection, then click neighbors (or shift-click) to extend it. The animation covers the whole selected run.</div>';
      for (i = 0; i < segs.length; i++) {
        var s = segs[i];
        var t = segTimes(s);
        html += '<div class="seg anim-segrow' + (selSet[s.index] ? " sel" : "") + '" data-i="' + s.index + '">' +
          '<div class="seg-main">' +
          '<span class="anim-check">' + (selSet[s.index] ? '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : "") + "</span>" +
          '<span class="seg-time">' + mmss(t.s) + "</span>" +
          '<span class="seg-text">' + esc(s.text || "(no speech)") + "</span>" +
          '<span class="seg-badges">' + (s.decision === "cut" && !s.protected ? '<span class="badge cut">Cut</span>' : "") + "</span>" +
          "</div></div>";
      }
      el.animSegs.innerHTML = html;
      updateSelSummary();
    }
    function updateSelSummary() {
      if (!state.selection.length) { el.animSelSummary.textContent = Retake.isLoaded() ? "Nothing selected" : ""; return; }
      var span = selectionSpan();
      var dur = span ? span.end - span.start : 0;
      el.animSelSummary.textContent = state.selection.length + " segment(s) · " + dur.toFixed(1) + "s · " + (span ? mmss(span.start) + "–" + mmss(span.end) : "");
    }

    function fmtStyleOption(s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>"; }
    function renderStyles() {
      var html = "", i;
      for (i = 0; i < state.styles.length; i++) html += fmtStyleOption(state.styles[i]);
      el.animStyle.innerHTML = html || '<option value="excalidraw">Excalidraw</option>';
      el.animStyle.value = state.style;
      if (el.animStyle.value !== state.style) { state.style = el.animStyle.value || "excalidraw"; persistPrefs(); }
    }
    function syncBgCtl() {
      var inputs = el.animBgCtl.querySelectorAll("input[name=animBg]"), i;
      for (i = 0; i < inputs.length; i++) {
        inputs[i].checked = inputs[i].value === state.background;
        // CEP has no :has() — the selected pill is a JS-set class (see styles.css .segctl)
        inputs[i].parentNode.className = "segopt" + (inputs[i].checked ? " on" : "");
      }
    }

    /* ---- chat rendering ---- */
    function scrollChat() { try { el.animChatLog.scrollTop = el.animChatLog.scrollHeight; } catch (e) {} }
    function chipHtml(t) {
      return '<span class="anim-chip"><svg class="ic ic-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>' +
        esc(t.name) + (t.detail ? '<span class="anim-chip-d">' + esc(t.detail) + "</span>" : "") + "</span>";
    }
    function msgHtml(m) {
      if (m.role === "user") {
        return '<div class="anim-msg user"><div class="anim-bubble">' + esc(m.text) +
          (m.images && m.images.length ? '<div class="anim-msg-imgs">📎 ' + esc(m.images.join(", ")) + "</div>" : "") +
          "</div></div>";
      }
      if (m.role === "assistant") {
        var chips = "";
        if (m.tools && m.tools.length) {
          var i; chips = '<div class="anim-chips">';
          for (i = 0; i < m.tools.length; i++) chips += chipHtml(m.tools[i]);
          chips += "</div>";
        }
        return '<div class="anim-msg assistant">' + chips + '<div class="anim-bubble">' + esc(m.text) + "</div></div>";
      }
      // system notices (created / placed / errors)
      return '<div class="anim-msg system"><span>' + esc(m.text) + "</span></div>";
    }
    function renderChat() {
      var job = activeJob();
      if (!job) return;
      el.animJobInfo.innerHTML =
        '<span class="anim-job-name">' + esc(job.id) + "</span>" +
        '<span class="anim-job-meta">' + job.durationSec.toFixed(1) + "s · " + mmss(job.range.startSec) + "–" + mmss(job.range.endSec) +
        " · " + esc(job.background === "transparent" ? "no bg" : "solid bg") + " · " + esc(job.style) + "</span>" +
        '<span class="seg-badges">' + jobBadge(job) + "</span>";
      var html = "", i;
      var chat = job.chat || [];
      for (i = 0; i < chat.length; i++) html += msgHtml(chat[i]);
      if (!chat.length || (chat.length === 1 && chat[0].role === "system")) {
        html += '<div class="anim-msg system"><span>Tell the agent what to build for this narration. It knows the transcript and the exact duration; attach reference images if it helps.</span></div>';
      }
      el.animChatLog.innerHTML = html;
      state.liveMsg = null; state.liveText = null;
      scrollChat();
    }
    function appendUserBubble(text, imgs) {
      el.animChatLog.insertAdjacentHTML("beforeend", msgHtml({ role: "user", text: text, images: imgs.map(function (im) { return im.name; }) }));
      scrollChat();
    }
    function appendSystemBubble(text, isErr) {
      el.animChatLog.insertAdjacentHTML("beforeend", '<div class="anim-msg system' + (isErr ? " err" : "") + '"><span>' + esc(text) + "</span></div>");
      scrollChat();
    }
    // The streaming assistant bubble: deltas append into a text node; tool chips
    // collect above it. Created lazily so a reconnect mid-turn still renders.
    function ensureLiveBubble() {
      if (state.liveMsg && state.liveMsg.parentNode) return;
      var wrap = document.createElement("div");
      wrap.className = "anim-msg assistant live";
      var chips = document.createElement("div"); chips.className = "anim-chips"; chips.style.display = "none";
      var bubble = document.createElement("div"); bubble.className = "anim-bubble";
      var textNode = document.createTextNode("");
      bubble.appendChild(textNode);
      wrap.appendChild(chips); wrap.appendChild(bubble);
      el.animChatLog.appendChild(wrap);
      state.liveMsg = wrap; state.liveText = textNode;
    }
    function finishLiveBubble(finalText) {
      if (state.liveMsg) {
        state.liveMsg.className = "anim-msg assistant";
        if (finalText != null && state.liveText && !state.liveText.nodeValue.trim()) state.liveText.nodeValue = finalText;
        if (state.liveText && !state.liveText.nodeValue.trim() && state.liveMsg.querySelector(".anim-chips").style.display === "none") {
          state.liveMsg.parentNode.removeChild(state.liveMsg); // nothing arrived — drop the empty bubble
        }
      }
      state.liveMsg = null; state.liveText = null;
    }

    /* ---- attachments ---- */
    function renderAttach() {
      var html = "", i;
      for (i = 0; i < state.pendingImgs.length; i++) {
        html += '<span class="anim-pill" data-img="' + i + '">' + esc(state.pendingImgs[i].name) + '<span class="anim-pill-x">×</span></span>';
      }
      el.animAttach.innerHTML = html;
      el.animAttach.style.display = html ? "" : "none";
    }
    function addFiles(files) {
      var added = 0, i;
      for (i = 0; i < files.length; i++) {
        if (state.pendingImgs.length + added >= MAX_IMGS) { toast("Up to " + MAX_IMGS + " images per message.", "info"); break; }
        (function (f) {
          if (!/^image\//.test(f.type)) { toast("Skipped " + f.name + " (not an image).", "info"); return; }
          if (f.size > MAX_IMG_BYTES) { toast("Skipped " + f.name + " (images up to 8 MB).", "info"); return; }
          var r = new FileReader();
          r.onload = function () {
            var s = String(r.result || "");
            state.pendingImgs.push({ name: f.name, data: s.slice(s.indexOf(",") + 1) });
            renderAttach(); updateButtons();
          };
          r.readAsDataURL(f);
        })(files[i]);
        added++;
      }
    }

    /* ---- state + server flows ---- */
    function upsertJob(job) {
      for (var i = 0; i < state.jobs.length; i++) if (state.jobs[i].id === job.id) { state.jobs[i] = job; return; }
      state.jobs.push(job);
    }
    function refreshState() {
      if (!connected()) { setStatus("Not connected."); return; }
      if (!state.stylesLoaded) {
        callServer("animStyles", {}).then(function (r) {
          state.styles = (r && r.styles) || [];
          state.stylesLoaded = true;
          renderStyles();
        }, function () {});
      }
      callServer("animState", {}).then(function (r) {
        state.stateLoaded = true;
        state.jobs = (r && r.jobs) || [];
        if (r && r.busy && !state.busy) { state.busy = true; } // a turn survives a panel reload
        if (r && r.error) setStatus(r.error);
        else if (!state.jobs.length) setStatus("");
        renderJobs();
        if (state.activeJobId) {
          if (!activeJob()) closeJob(); // the job folder disappeared
          else renderChat();
        }
        updateButtons();
      }, function (err) { setStatus(err.message, true); });
    }
    function openJob(id) {
      state.activeJobId = id;
      el.animSelect.className = "hidden";
      el.animChatWrap.className = "anim-chatwrap";
      el.animBackBtn.style.display = "";
      el.animStyle.disabled = true;
      renderChat();
      updateButtons();
      try { el.animText.focus(); } catch (e) {}
    }
    function closeJob() {
      state.activeJobId = null;
      el.animChatWrap.className = "anim-chatwrap hidden";
      el.animSelect.className = "";
      el.animBackBtn.style.display = "none";
      el.animStyle.disabled = false;
      setChatStatus("");
      renderSegs(); renderJobs(); updateButtons();
    }
    function create() {
      if (!connected() || state.busy || !state.selection.length) return;
      state.busy = true; updateButtons();
      setLoading(el.animCreateBtn, true, "Creating…");
      setStatus("Creating the animation…");
      var p = AI.params();
      callServer("animCreate", { segments: state.selection, style: state.style, background: state.background, model: p.model, effort: p.effort }, function (m) { setStatus(m); }).then(
        function (res) {
          state.busy = false;
          setLoading(el.animCreateBtn, false, "Start animation chat");
          setStatus("");
          state.selection = []; state.anchor = null;
          if (res && res.job) { upsertJob(res.job); renderJobs(); openJob(res.job.id); }
          toast((res && res.message) || "Animation created.", "success");
          updateButtons();
        },
        function (err) {
          state.busy = false;
          setLoading(el.animCreateBtn, false, "Start animation chat");
          var cancelled = /cancel/i.test(err.message);
          setStatus(cancelled ? "Stopped." : err.message, !cancelled);
          if (!cancelled) toast(err.message, "error");
          updateButtons();
        }
      );
    }
    function send() {
      var text = (el.animText.value || "").replace(/^\s+|\s+$/g, "");
      if (!connected() || state.busy || !state.activeJobId) return;
      if (!text && !state.pendingImgs.length) return;
      var jobId = state.activeJobId;
      state.busy = true; updateButtons();
      appendUserBubble(text, state.pendingImgs);
      var images = state.pendingImgs;
      state.pendingImgs = []; renderAttach();
      el.animText.value = "";
      setChatStatus("Thinking…");
      ensureLiveBubble();
      var p = AI.params();
      callServer("animChat", { jobId: jobId, text: text, images: images, model: p.model, effort: p.effort }, function (m) { setChatStatus(m); }).then(
        function (res) {
          state.busy = false;
          finishLiveBubble(res && res.text);
          setChatStatus("");
          if (res && res.placed) toast(res.placed, "success");
          refreshState(); // pick up the persisted chat + placed/render state
          updateButtons();
        },
        function (err) {
          state.busy = false;
          finishLiveBubble(null);
          setChatStatus("");
          var cancelled = /cancel/i.test(err.message);
          appendSystemBubble(cancelled ? "Stopped." : err.message, !cancelled);
          if (!cancelled) toast(err.message, "error");
          refreshState();
          updateButtons();
        }
      );
    }
    function stop() { if (!state.busy) return; callServer("animCancel", {}).catch(function () {}); setChatStatus("Stopping…"); }

    /* ---- server pushes (streamed turn events) ---- */
    function onEvent(msg) {
      if (!msg || msg.jobId !== state.activeJobId) {
        // still surface a finished placement for a job that's not open
        if (msg && msg.event && msg.event.kind === "placed") toast(msg.event.text || "Animation placed on the timeline.", "success");
        return;
      }
      var ev = msg.event || {};
      if (ev.kind === "delta") {
        ensureLiveBubble();
        state.liveText.nodeValue += ev.text || "";
        scrollChat();
      } else if (ev.kind === "tool") {
        ensureLiveBubble();
        var chips = state.liveMsg.querySelector(".anim-chips");
        chips.style.display = "";
        chips.insertAdjacentHTML("beforeend", chipHtml(ev));
        scrollChat();
      } else if (ev.kind === "status") {
        setChatStatus(ev.text || "");
      } else if (ev.kind === "placed") {
        appendSystemBubble(ev.text || "Placed on the timeline.");
        setChatStatus("");
      } else if (ev.kind === "assistantDone") {
        finishLiveBubble(ev.text);
      } else if (ev.kind === "turnDone") {
        setChatStatus("");
      }
    }
    // Segments changed (reviewUpdate push): the picker's rows may be stale.
    function onSegments() {
      state.selection = []; state.anchor = null;
      if (activeTab === "anim" && !state.activeJobId) { renderSegs(); updateButtons(); }
    }

    function updateButtons() {
      if (!el.animCreateBtn) return;
      setBusyBar("anim", state.busy);
      var conn = connected();
      el.animCreateBtn.disabled = !conn || state.busy || !state.selection.length;
      el.animSendBtn.disabled = !conn || state.busy || !state.activeJobId;
      el.animSendBtn.style.display = state.busy && state.activeJobId ? "none" : "";
      el.animStopBtn.style.display = state.busy && state.activeJobId ? "" : "none";
      el.animImgBtn.disabled = state.busy;
      el.animStyle.disabled = !!state.activeJobId;
      var inputs = el.animBgCtl.querySelectorAll("input"), i;
      for (i = 0; i < inputs.length; i++) inputs[i].disabled = !!state.activeJobId || state.busy;
      updateSelSummary();
    }
    function onShow() {
      renderSegs();
      syncBgCtl();
      refreshState();
      updateButtons();
    }
    function onHide() { /* nothing to stop — chat pushes are cheap and keyed to the open job */ }

    function wire() {
      cache();
      loadPrefs();
      syncBgCtl();
      renderStyles();
      renderAttach();
      el.animSegs.addEventListener("click", function (ev) {
        var row = ev.target.closest ? ev.target.closest(".seg") : null;
        if (!row) return;
        toggleSelect(parseInt(row.getAttribute("data-i"), 10), ev.shiftKey);
      });
      el.animJobs.addEventListener("click", function (ev) {
        var row = ev.target.closest ? ev.target.closest(".anim-job") : null;
        if (row) openJob(row.getAttribute("data-job"));
      });
      el.animStyle.addEventListener("change", function () { state.style = el.animStyle.value; persistPrefs(); });
      el.animBgCtl.addEventListener("change", function () {
        var checked = el.animBgCtl.querySelector("input:checked");
        state.background = checked && checked.value === "transparent" ? "transparent" : "solid";
        persistPrefs(); syncBgCtl();
      });
      el.animCreateBtn.addEventListener("click", create);
      el.animBackBtn.addEventListener("click", closeJob);
      el.animSendBtn.addEventListener("click", send);
      el.animStopBtn.addEventListener("click", stop);
      el.animText.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      });
      el.animImgBtn.addEventListener("click", function () { el.animFile.click(); });
      el.animFile.addEventListener("change", function () { addFiles(el.animFile.files || []); el.animFile.value = ""; });
      el.animAttach.addEventListener("click", function (ev) {
        var pill = ev.target.closest ? ev.target.closest(".anim-pill") : null;
        if (!pill || !ev.target.className || String(ev.target.className).indexOf("anim-pill-x") < 0) return;
        state.pendingImgs.splice(parseInt(pill.getAttribute("data-img"), 10), 1);
        renderAttach(); updateButtons();
      });
      // Drag-and-drop reference images onto the chat.
      el.animChatWrap.addEventListener("dragover", function (e) { e.preventDefault(); el.animChatWrap.classList.add("dragging"); });
      el.animChatWrap.addEventListener("dragleave", function () { el.animChatWrap.classList.remove("dragging"); });
      el.animChatWrap.addEventListener("drop", function (e) {
        e.preventDefault();
        el.animChatWrap.classList.remove("dragging");
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      });
    }

    // onEvent/setJobs/openJob are exposed for browser QA (no server needed):
    // __editagent.Anim.setJobs([{id:"anim-x",durationSec:10,range:{...},chat:[...]}]);
    // __editagent.Anim.openJob("anim-x"); __editagent.Anim.onEvent({jobId:"anim-x", event:{kind:"delta", text:"…"}})
    return {
      wire: wire, updateButtons: updateButtons, onShow: onShow, onHide: onHide,
      onEvent: onEvent, onSegments: onSegments, openJob: openJob, refreshState: refreshState,
      setJobs: function (jobs) { state.jobs = jobs || []; renderJobs(); if (state.activeJobId) renderChat(); },
    };
  })();

  /* ---------- init ---------- */
  Silence.wire();
  Retake.wire();
  Anim.wire();
  AI.wire();
  selectTab("silence");
  connect();
  // Debug handle for browser-based QA (the gallery/QA flow drives the real panel
  // outside CEP, where there's no server to push data): lets a console inject
  // segments/config, e.g. __editagent.Retake.applyReviewUpdate([...]).
  window.__editagent = { Retake: Retake, Silence: Silence, AI: AI, Anim: Anim };
})();
