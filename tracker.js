/**
 * tracker.js — drop this on any frontend page you want to monitor.
 *
 * Usage:
 *   <script src="https://YOUR-ANALYTICS-HOST/tracker.js"></script>
 *
 * Override backend:
 *   <script>window.__TRACKER_BACKEND__ = "https://YOUR-ANALYTICS-HOST";</script>
 *   <script src="...tracker.js"></script>
 */
(function () {
  if (window.__TRACKER_LOADED__) return; // guard against the snippet being included twice
  window.__TRACKER_LOADED__ = true;

  function detectBackend() {
    if (window.__TRACKER_BACKEND__) return String(window.__TRACKER_BACKEND__).replace(/\/$/, "");
    var cur = document.currentScript && document.currentScript.src;
    if (cur && /tracker\.js(\?|$)/.test(cur)) return cur.replace(/\/tracker\.js(\?.*)?$/, "");
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || "";
      if (/tracker\.js(\?|$)/.test(src)) return src.replace(/\/tracker\.js(\?.*)?$/, "");
    }
    return "";
  }
  var BACKEND = detectBackend();
  if (!BACKEND) {
    console.warn("[tracker] set window.__TRACKER_BACKEND__ or load this script from your analytics host");
    return;
  }

  // Fresh session ID every page load — every visit is its own row
  var sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  var startTime = Date.now();
  var clickCount = 0;
  var ended = false;

  // POST JSON. On page exit use sendBeacon (survives unload far more reliably
  // than fetch); text/plain avoids a CORS preflight — the server accepts it.
  function post(path, body, onExit) {
    var json = JSON.stringify(body);
    if (onExit && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(BACKEND + path, new Blob([json], { type: "text/plain" }))) return;
      } catch (_) {}
    }
    try {
      fetch(BACKEND + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json,
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  }

  // ── Timeline event buffer ─────────────────────────────────────────────
  var eventBuffer = [];
  var flushTimer = null;

  function recordEvent(type, data) {
    eventBuffer.push({ t: Date.now(), type: type, data: data || {} });
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushEvents, 2000);
    if (eventBuffer.length >= 100) flushEvents(); // keep payloads small
  }

  function flushEvents(onExit) {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!eventBuffer.length) return;
    var events = eventBuffer.splice(0);
    post("/track/events", { sessionId: sid, events: events }, onExit);
  }

  // ── gclid ─────────────────────────────────────────────────────────────
  // sessionStorage can throw (sandboxed iframes, blocked storage) — never let
  // that kill the tracker.
  var gclidMemo = "";
  function getGclid() {
    if (gclidMemo) return gclidMemo;
    try {
      var stored = sessionStorage.getItem("_t_gc");
      if (stored) return (gclidMemo = stored);
    } catch (_) {}
    try {
      var p = new URLSearchParams(window.location.search).get("gclid");
      if (p) {
        gclidMemo = p;
        try { sessionStorage.setItem("_t_gc", p); } catch (_) {}
        return p;
      }
    } catch (_) {}
    return "";
  }
  getGclid();

  function isFullscreenNow() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
  }

  // ── Session-level send (state snapshot) ───────────────────────────────
  function send(event, extra, onExit) {
    var tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) {}
    var payload = Object.assign({
      sessionId: sid,
      event: event,
      timezone: tz,
      gclid: getGclid(),
      url: window.location.href,
      referrer: document.referrer || "",
      screenWidth:    screen.width,
      screenHeight:   screen.height,
      viewportWidth:  window.innerWidth,
      viewportHeight: window.innerHeight,
      language: navigator.language || "",
      duration: Math.floor((Date.now() - startTime) / 1000),
      clicks: clickCount,
      isFullscreen: isFullscreenNow(),
      isHidden: document.hidden,
    }, extra || {});
    post("/track", payload, onExit);
  }

  // ── Init ─────────────────────────────────────────────────────────────
  send("init");
  recordEvent("init", { url: window.location.href, referrer: document.referrer || "" });

  // ── Clicks ────────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    clickCount++;
    recordEvent("click", { x: Math.round(e.clientX), y: Math.round(e.clientY) });
  }, true);

  // ── Mouse movement (sampled max 1/sec, min 15px delta) ───────────────
  var lastMX = -1, lastMY = -1, mouseSampleTimer = null;
  document.addEventListener("mousemove", function (e) {
    if (mouseSampleTimer) return;
    mouseSampleTimer = setTimeout(function () { mouseSampleTimer = null; }, 1000);
    var dx = e.clientX - lastMX, dy = e.clientY - lastMY;
    if (lastMX < 0 || Math.sqrt(dx * dx + dy * dy) > 15) {
      lastMX = e.clientX; lastMY = e.clientY;
      recordEvent("mouse", { x: Math.round(e.clientX), y: Math.round(e.clientY) });
    }
  }, { passive: true });

  // ── Keyboard ─────────────────────────────────────────────────────────
  // Single-char keys typed inside inputs are masked as "[text]" to avoid
  // capturing passwords/form data. Navigation keys (Enter, Arrows, etc.)
  // are always logged regardless of focus.
  var SKIP_KEYS = { Shift: 1, Control: 1, Alt: 1, Meta: 1, CapsLock: 1, Dead: 1, Unidentified: 1 };
  document.addEventListener("keydown", function (e) {
    if (!e.key || SKIP_KEYS[e.key]) return; // e.key is undefined for some autofill events
    var el = document.activeElement || {};
    var tag = (el.tagName || "").toUpperCase();
    var isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el.isContentEditable;
    var isSpecial = e.key.length > 1; // "Enter", "ArrowDown", "F5", etc.
    var key = (isInput && !isSpecial) ? "[text]" : e.key;
    recordEvent("key", { key: key });
  });

  // ── Fullscreen ────────────────────────────────────────────────────────
  function onFullscreenChange() {
    var isFS = isFullscreenNow();
    send("fullscreen", { isFullscreen: isFS });
    recordEvent(isFS ? "fullscreen_enter" : "fullscreen_exit", {});
  }
  document.addEventListener("fullscreenchange",       onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  document.addEventListener("mozfullscreenchange",    onFullscreenChange);

  // ── Visibility ────────────────────────────────────────────────────────
  document.addEventListener("visibilitychange", function () {
    // Browsers fire "hidden" right after pagehide — don't let it overwrite "end"
    if (ended) return;
    recordEvent(document.hidden ? "page_hidden" : "page_visible", {});
    // When hiding, flush via beacon — mobile browsers often never fire unload
    flushEvents(document.hidden);
    send("visibility", null, document.hidden);
  });

  // ── Heartbeat — 15 s so stale sessions go gray within ~35 s of closing ─
  setInterval(function () {
    if (ended) return;
    send("heartbeat");
    flushEvents();
  }, 15000);

  // ── End ───────────────────────────────────────────────────────────────
  // pagehide fires reliably on mobile + bfcache; beforeunload is a fallback.
  function onEnd() {
    if (ended) return;
    ended = true;
    recordEvent("end", {});
    flushEvents(true);
    send("end", null, true);
  }
  window.addEventListener("pagehide", onEnd);
  window.addEventListener("beforeunload", onEnd);
  // Page restored from back/forward cache — resume as the same session
  window.addEventListener("pageshow", function (e) {
    if (e.persisted && ended) {
      ended = false;
      send("heartbeat");
    }
  });
})();
