require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const Redis = require("ioredis");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

if (!process.env.REDIS_URL) {
  console.error("[startup] REDIS_URL is not set — falling back to redis://localhost:6379");
}
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 500, 10_000),
  maxRetriesPerRequest: null,
});
redis.on("error", (err) => console.error("[redis]", err.message));

const app = express();
app.disable("x-powered-by");
app.use(cors());
// text/plain is accepted so the tracker can use navigator.sendBeacon on page exit
// (sendBeacon can't send application/json cross-origin without a preflight).
app.use(express.json({ limit: "256kb", type: ["application/json", "text/plain"] }));

// ─── Optional admin password (HTTP Basic auth) ────────────────────
// Public endpoints: tracking + tracker script + health. Everything else
// (dashboard page, /admin/* API, SSE stream) needs the password when set.
const PUBLIC_PATHS = new Set(["/track", "/track/events", "/tracker.js", "/health"]);

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

app.use((req, res, next) => {
  if (!ADMIN_PASSWORD || PUBLIC_PATHS.has(req.path) || req.method === "OPTIONS") return next();
  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const pass = decoded.slice(decoded.indexOf(":") + 1);
    if (safeEqual(pass, ADMIN_PASSWORD)) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Analytics", charset="UTF-8"');
  res.status(401).send("Authentication required");
});

// Admin UI (same-origin → BACKEND can be "")
app.use(express.static(path.join(__dirname, "public")));

// ─── Analytics ────────────────────────────────────────────────────

const KEY_ANALYTICS         = "analytics:sessions";
const ANALYTICS_MAX         = 3000;
const ANALYTICS_SESSION_TTL = 48 * 3600;
const ACTIVE_WINDOW_MS      = 45 * 1000;

const keySession       = (id) => `analytics:session:${id}`;
const keySessionEvents = (id) => `analytics:session:${id}:events`;
const MAX_TIMELINE_EVENTS = 2000;
const MAX_EVENTS_PER_REQUEST = 300;

const sseClients = new Set();

function broadcastSSE(type, data) {
  if (!sseClients.size) return;
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function clientIp(req) {
  const raw =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    req.socket.remoteAddress ||
    "unknown";
  // Node reports IPv4 clients on dual-stack sockets as "::ffff:1.2.3.4"
  return String(raw).replace(/^::ffff:/, "");
}

/** Normalised hostname used as the "website" key (lower-case, no leading www.). */
function hostOf(u) {
  if (!u) return "";
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function siteOf(s) {
  return s.site || hostOf(s.url) || hostOf(s.origin) || "unknown";
}

function validSessionId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);
}

/** Active (visible) seconds for a session, with a timestamp fallback when no heartbeat arrived. */
function activeDurationOf(s) {
  let dur = Number(s.duration) || 0;
  if (dur === 0 && s.startTime && s.lastSeen) {
    dur = Math.max(0, Math.floor((Number(s.lastSeen) - Number(s.startTime)) / 1000));
  }
  return Math.max(0, dur - (Number(s.hiddenDuration) || 0));
}

function getScoreRange(from, to) {
  const minScore = from && !isNaN(Number(from)) ? Number(from) : "-inf";
  const maxScore = to   && !isNaN(Number(to))   ? Number(to)   : "+inf";
  return { minScore, maxScore };
}

/** ?sites=a.com,b.com → Set, or null for "all sites". */
function parseSites(q) {
  if (!q) return null;
  const list = String(q).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? new Set(list) : null;
}

/**
 * Load every session hash in a time range (newest first). The index is capped
 * at ANALYTICS_MAX entries so this stays cheap. Index entries whose hash has
 * expired are pruned on the way through.
 */
async function loadSessions(minScore, maxScore) {
  const ids = await redis.zrevrangebyscore(KEY_ANALYTICS, maxScore, minScore);
  if (!ids.length) return [];
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(keySession(id));
  const results = await pipeline.exec();

  const sessions = [];
  const dangling = [];
  results.forEach(([err, s], i) => {
    if (!err && s && s.id) {
      s.site = siteOf(s);
      sessions.push(s);
    } else if (!err) {
      dangling.push(ids[i]);
    }
  });
  if (dangling.length) redis.zrem(KEY_ANALYTICS, ...dangling).catch(() => {});
  return sessions;
}

// ─── Tracking ─────────────────────────────────────────────────────

app.post("/track", async (req, res) => {
  try {
    const body = req.body || {};
    const { sessionId, event } = body;
    if (!validSessionId(sessionId) || !event || typeof event !== "string") {
      return res.status(400).json({ error: "sessionId and event required" });
    }

    const ip = clientIp(req);
    const isBlocked = await redis.get(`analytics:blocked:${ip}`);
    if (isBlocked) return res.status(200).json({ ok: true });

    const now = Date.now();
    const sKey = keySession(sessionId);
    const existing = await redis.hgetall(sKey);
    const str = (v, max = 2048) => String(v == null ? "" : v).slice(0, max);

    if (event === "init" || !existing || !existing.id) {
      const url = str(body.url);
      const origin = str(req.headers.origin, 512);
      const session = {
        id:          sessionId,
        event:       str(event, 32),
        ip,
        userAgent:   str(req.headers["user-agent"], 512),
        origin,
        site:        hostOf(url) || hostOf(origin) || "unknown",
        timezone:    str(body.timezone, 64),
        gclid:       str(body.gclid, 256),
        url,
        referrer:    str(body.referrer),
        language:    str(body.language, 32),
        screenWidth:    Number(body.screenWidth)    || 0,
        screenHeight:   Number(body.screenHeight)   || 0,
        viewportWidth:  Number(body.viewportWidth)  || 0,
        viewportHeight: Number(body.viewportHeight) || 0,
        startTime:    now,
        lastSeen:     now,
        duration:     0,
        clicks:       0,
        isFullscreen: "false",
        hadFullscreen:"false",
        isHidden:       "false",
        hiddenCount:    0,
        hiddenDuration: 0,
        lastHiddenTs:   0,
        escCount:       0,
        textCount:      0,
        hadMouseMove:   "false",
      };
      const tx = redis.multi();
      tx.hset(sKey, session);
      tx.expire(sKey, ANALYTICS_SESSION_TTL);
      tx.zadd(KEY_ANALYTICS, now, sessionId);
      // Drop index entries older than the session TTL (their hashes are gone)
      tx.zremrangebyscore(KEY_ANALYTICS, "-inf", now - ANALYTICS_SESSION_TTL * 1000);
      tx.zremrangebyrank(KEY_ANALYTICS, 0, -(ANALYTICS_MAX + 1));
      await tx.exec();
      broadcastSSE("session", session);
    } else {
      const updates = { lastSeen: now, event: str(event, 32) };
      if (body.duration       !== undefined) updates.duration    = Number(body.duration)    || 0;
      if (body.clicks         !== undefined) updates.clicks      = Number(body.clicks)      || 0;
      if (body.viewportWidth  !== undefined) updates.viewportWidth  = Number(body.viewportWidth)  || 0;
      if (body.viewportHeight !== undefined) updates.viewportHeight = Number(body.viewportHeight) || 0;
      if (body.isFullscreen   !== undefined) {
        updates.isFullscreen = String(body.isFullscreen === true || body.isFullscreen === "true");
        if (updates.isFullscreen === "true") updates.hadFullscreen = "true";
      }
      if (body.isHidden !== undefined) {
        updates.isHidden = String(body.isHidden === true || body.isHidden === "true");
      }
      if (body.timezone) updates.timezone = str(body.timezone, 64);
      if (body.gclid)    updates.gclid    = str(body.gclid, 256);
      if (body.url) {
        updates.url = str(body.url);
        if (!existing.site) updates.site = hostOf(updates.url) || siteOf(existing);
      }

      const tx = redis.multi();
      tx.hset(sKey, updates);
      tx.expire(sKey, ANALYTICS_SESSION_TTL);
      await tx.exec();
      const merged = { ...existing, ...updates, id: sessionId };
      merged.site = siteOf(merged);
      broadcastSSE("update", merged);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[track]", err.message);
    res.status(500).json({ error: "tracking failed" });
  }
});

app.post("/track/events", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    let { events } = req.body || {};
    if (!validSessionId(sessionId) || !Array.isArray(events) || !events.length) {
      return res.status(400).json({ error: "sessionId and events[] required" });
    }
    events = events
      .filter((ev) => ev && typeof ev === "object" && typeof ev.type === "string")
      .slice(0, MAX_EVENTS_PER_REQUEST);
    if (!events.length) return res.status(200).json({ ok: true });

    const sKey = keySession(sessionId);
    // Ignore events for unknown sessions (or blocked IPs). Previously these
    // created orphan hashes via HINCRBY that never expired.
    const [exists, blocked] = await Promise.all([
      redis.hexists(sKey, "id"),
      redis.get(`analytics:blocked:${clientIp(req)}`),
    ]);
    if (!exists || blocked) return res.status(200).json({ ok: true });

    const eKey = keySessionEvents(sessionId);
    const tx = redis.multi();
    for (const ev of events) tx.rpush(eKey, JSON.stringify(ev).slice(0, 2048));
    tx.ltrim(eKey, -MAX_TIMELINE_EVENTS, -1);
    tx.expire(eKey, ANALYTICS_SESSION_TTL);
    await tx.exec();

    const hiddenIncrements = events.filter((ev) => ev.type === "page_hidden").length;
    const escIncrements    = events.filter((ev) => ev.type === "key" && (ev.data || {}).key === "Escape").length;
    const textIncrements   = events.filter((ev) => ev.type === "key" && (ev.data || {}).key === "[text]").length;
    const hasMouseMove     = events.some((ev) => ev.type === "mouse");

    let hiddenDurationDelta = 0;
    let lastHiddenTs = null;
    const hasRelevantEvents = events.some(
      (ev) => ev.type === "page_hidden" || ev.type === "page_visible" || ev.type === "end"
    );
    if (hasRelevantEvents) {
      lastHiddenTs = Number(await redis.hget(sKey, "lastHiddenTs")) || 0;
      for (const ev of events) {
        if (ev.type === "page_hidden") {
          lastHiddenTs = Number(ev.t) || 0;
        } else if ((ev.type === "page_visible" || ev.type === "end") && lastHiddenTs > 0) {
          hiddenDurationDelta += Math.max(0, Math.floor((Number(ev.t) - lastHiddenTs) / 1000));
          lastHiddenTs = 0;
        }
      }
    }

    const changed = hiddenIncrements || escIncrements || textIncrements || hasMouseMove || hiddenDurationDelta;
    if (changed || lastHiddenTs !== null) {
      const ux = redis.multi();
      if (hiddenIncrements)    ux.hincrby(sKey, "hiddenCount", hiddenIncrements);
      if (escIncrements)       ux.hincrby(sKey, "escCount", escIncrements);
      if (textIncrements)      ux.hincrby(sKey, "textCount", textIncrements);
      if (hasMouseMove)        ux.hset(sKey, "hadMouseMove", "true");
      if (lastHiddenTs !== null) ux.hset(sKey, "lastHiddenTs", lastHiddenTs);
      if (hiddenDurationDelta) ux.hincrby(sKey, "hiddenDuration", hiddenDurationDelta);
      ux.expire(sKey, ANALYTICS_SESSION_TTL);
      await ux.exec();
    }

    if (changed) {
      const u = await redis.hmget(sKey, "hiddenCount", "escCount", "hiddenDuration", "textCount", "hadMouseMove");
      broadcastSSE("update", {
        id:             sessionId,
        hiddenCount:    u[0] || "0",
        escCount:       u[1] || "0",
        hiddenDuration: u[2] || "0",
        textCount:      u[3] || "0",
        hadMouseMove:   u[4] || "false",
      });
    }

    broadcastSSE("events", { sessionId, events });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[track/events]", err.message);
    res.status(500).json({ error: "failed" });
  }
});

// ─── Admin API ────────────────────────────────────────────────────

app.get("/admin/analytics/session/:id/events", async (req, res) => {
  try {
    const raw = await redis.lrange(keySessionEvents(req.params.id), 0, -1);
    const events = raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/analytics/clear-stale", async (req, res) => {
  try {
    const ids = await redis.zrevrange(KEY_ANALYTICS, 0, -1);
    const cutoff = Date.now() - 5 * 60 * 1000;
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hget(keySession(id), "lastSeen");
    const results = await pipeline.exec();
    const stale = ids.filter((id, i) => !results[i][1] || Number(results[i][1]) < cutoff);
    if (stale.length) {
      const tx = redis.multi();
      for (const id of stale) {
        tx.del(keySession(id));
        tx.del(keySessionEvents(id));
        tx.zrem(KEY_ANALYTICS, id);
      }
      await tx.exec();
    }
    res.json({ cleared: stale.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** List of websites seen, with counts for the requested range. */
app.get("/admin/analytics/sites", async (req, res) => {
  try {
    const { minScore, maxScore } = getScoreRange(req.query.from, req.query.to);
    const all = await loadSessions("-inf", "+inf");
    const lo = minScore === "-inf" ? -Infinity : minScore;
    const hi = maxScore === "+inf" ? Infinity : maxScore;
    const now = Date.now();

    const map = new Map();
    for (const s of all) {
      const key = s.site;
      if (!map.has(key)) map.set(key, { site: key, sessions: 0, visitors: new Set(), active: new Set(), totalSessions: 0, lastSeen: 0 });
      const e = map.get(key);
      e.totalSessions++;
      e.lastSeen = Math.max(e.lastSeen, Number(s.lastSeen) || 0);
      const st = Number(s.startTime) || 0;
      if (st >= lo && st <= hi) {
        e.sessions++;
        e.visitors.add(s.ip);
        if (now - Number(s.lastSeen) < ACTIVE_WINDOW_MS) e.active.add(s.ip);
      }
    }
    const sites = [...map.values()]
      .map((e) => ({ ...e, visitors: e.visitors.size, active: e.active.size }))
      .sort((a, b) => b.sessions - a.sessions || b.totalSessions - a.totalSessions || a.site.localeCompare(b.site));
    res.json({ sites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/analytics", async (req, res) => {
  try {
    const { from, to, page = "1", pageSize = "50" } = req.query;
    const { minScore, maxScore } = getScoreRange(from, to);
    const sites  = parseSites(req.query.sites);
    const limit  = Math.max(1, Math.min(Number(pageSize) || 50, 100));
    const pageN  = Math.max(1, Number(page) || 1);
    const offset = (pageN - 1) * limit;

    let sessions = await loadSessions(minScore, maxScore);
    if (sites) sessions = sessions.filter((s) => sites.has(s.site));

    res.json({
      sessions: sessions.slice(offset, offset + limit),
      total: sessions.length,
      page: pageN,
      pageSize: limit,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/analytics/stats", async (req, res) => {
  try {
    const { minScore, maxScore } = getScoreRange(req.query.from, req.query.to);
    const sites = parseSites(req.query.sites);

    let sessions = await loadSessions(minScore, maxScore);
    if (sites) sessions = sessions.filter((s) => sites.has(s.site));

    let withGclid = 0, totalClicks = 0, totalDuration = 0, durCount = 0;
    const uniqueIPs = new Set();
    const activeIPs = new Set();
    const gclidIPs  = new Set();
    const now = Date.now();
    for (const s of sessions) {
      const ip = s.ip || "unknown";
      uniqueIPs.add(ip);
      if (now - Number(s.lastSeen) < ACTIVE_WINDOW_MS) activeIPs.add(ip);
      if ((s.gclid || "").trim()) { withGclid++; gclidIPs.add(ip); }
      totalClicks += Number(s.clicks) || 0;
      const activeDur = activeDurationOf(s);
      if (activeDur > 0) { totalDuration += activeDur; durCount++; }
    }

    res.json({
      total:       sessions.length,
      uniqueIPs:   uniqueIPs.size,
      active:      activeIPs.size,
      withGclid,
      gclidIPs:    gclidIPs.size,
      totalClicks,
      avgDuration: durCount ? Math.round(totalDuration / durCount) : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/admin/analytics/ip/:ip", async (req, res) => {
  try {
    const ip = req.params.ip; // Express already URL-decodes params
    const ids = await redis.zrevrange(KEY_ANALYTICS, 0, -1);

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hget(keySession(id), "ip");
    const results = await pipeline.exec();

    const toDelete = ids.filter((id, i) => results[i][1] === ip);

    if (toDelete.length) {
      const tx = redis.multi();
      for (const id of toDelete) {
        tx.del(keySession(id));
        tx.del(keySessionEvents(id));
        tx.zrem(KEY_ANALYTICS, id);
      }
      await tx.exec();
    }

    await redis.setex(`analytics:blocked:${ip}`, 48 * 3600, "1");
    broadcastSSE("ip-deleted", { ip });
    res.json({ deleted: toDelete.length, ip });
  } catch (err) {
    console.error("[delete-ip]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── IP enrichment (ipapi.is) ─────────────────────────────────────

app.get("/admin/ip-info/:ip", async (req, res) => {
  const { ip } = req.params;
  const cacheKey = `ipinfo:${ip}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const apiKey = process.env.IPAPI_IS_KEY;
    if (!apiKey) return res.status(503).json({ error: "IPAPI_IS_KEY not set" });

    const r = await fetch(`https://api.ipapi.is/?q=${encodeURIComponent(ip)}&key=${encodeURIComponent(apiKey)}`);
    if (!r.ok) return res.status(502).json({ error: `ipapi.is returned ${r.status}` });
    const data = await r.json();

    if (data.error) return res.status(400).json({ error: data.error });

    const loc     = data.location || {};
    const asn     = data.asn      || {};
    const company = data.company  || {};

    const is_proxy      = !!data.is_proxy;
    const is_vpn        = !!data.is_vpn;
    const is_tor        = !!data.is_tor;
    const is_datacenter = !!data.is_datacenter;
    const is_mobile     = !!data.is_mobile;

    let connection_type;
    if      (is_tor)         connection_type = "Tor";
    else if (is_vpn)         connection_type = "VPN";
    else if (is_proxy)       connection_type = "Proxy";
    else if (is_datacenter)  connection_type = "Datacenter";
    else if (is_mobile)      connection_type = "Mobile";
    else {
      const t = (asn.type || company.type || "").toLowerCase();
      if      (t === "isp")        connection_type = "Residential";
      else if (t === "hosting")    connection_type = "Datacenter";
      else if (t === "education")  connection_type = "Education";
      else if (t === "government") connection_type = "Government";
      else if (t === "business")   connection_type = "Business";
      else if (t === "banking")    connection_type = "Banking";
      else                         connection_type = "Residential";
    }

    // ipapi.is returns location.country as a full name and location.country_code as ISO-2
    const result = {
      ip,
      country:         loc.country || "",
      country_code:    loc.country_code || asn.country || "",
      city:            loc.city    || "",
      region:          loc.state   || loc.region || "",
      isp:             asn.org     || company.name || "",
      org:             company.name || asn.org || "",
      asn:             asn.asn     ? String(asn.asn) : "",
      connection_type,
      is_proxy,
      is_vpn,
      is_tor,
      is_datacenter,
    };

    await redis.setex(cacheKey, 24 * 3600, JSON.stringify(result));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/admin/ip-info-cache", async (req, res) => {
  try {
    // SCAN instead of KEYS so a big keyspace doesn't block Redis
    let deleted = 0;
    const stream = redis.scanStream({ match: "ipinfo:*", count: 200 });
    for await (const keys of stream) {
      if (keys.length) { deleted += keys.length; await redis.del(...keys); }
    }
    res.json({ deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // stop nginx/Render proxies buffering the stream
  res.flushHeaders();
  res.write("retry: 3000\n: connected\n\n");

  sseClients.add(res);
  const keepalive = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { clearInterval(keepalive); }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

app.get("/tracker.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(path.join(__dirname, "tracker.js"));
});

app.get("/health", (_req, res) => res.json({ status: "ok", redis: redis.status }));

app.listen(PORT, () => {
  console.log(`Analytics standalone running on port ${PORT}`);
  console.log(`  Admin UI:  http://localhost:${PORT}/`);
  console.log(`  Tracker:   http://localhost:${PORT}/tracker.js`);
  if (!ADMIN_PASSWORD) console.warn("  ⚠ ADMIN_PASSWORD not set — the dashboard and /admin API are public");
});
