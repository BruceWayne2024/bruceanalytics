# Analytics Standalone

Self-contained session analytics: tracker script + admin dashboard + API.

> **Deploying with Render (free) + Netlify Drop + cron-job.org? Follow [SETUP.md](SETUP.md).**

## What’s included

| Path | Purpose |
|------|---------|
| `server.js` | Express API: tracking, admin list/stats/sites, SSE live updates, IP lookup |
| `public/index.html` | Admin dashboard UI (served by the Render server itself) |
| `netlify-drop/index.html` | Same dashboard, pointed at the Render URL, for hosting on Netlify |
| `tracker.js` | Drop-in script for sites you want to monitor |

**Not included** (kept in the main Backend repo): chat, funnel page, timezone/landing iframe, Amplify/S3 tooling.

## Setup

```bash
cd "Analytics Standalone"
cp .env.example .env
# edit .env — at minimum set REDIS_URL
npm install
npm start
```

Open **http://localhost:3000/** for the admin UI. Requires Node 18+.

## Env vars

| Variable | Required | Notes |
|----------|----------|--------|
| `REDIS_URL` | Yes | Session + timeline storage |
| `PORT` | No | Default `3000` |
| `ADMIN_PASSWORD` | No | **Leave unset if the dashboard is on Netlify.** Protects the dashboard, `/admin/*` API and live stream with HTTP Basic auth (any username). Tracking endpoints stay public. |
| `IPAPI_IS_KEY` | No | [ipapi.is](https://ipapi.is) key for IP enrichment |

## Dashboard

- **Website picker** (top bar) — pick one, several, or all websites. The table *and* the KPI cards (Unique visitors, Active now, Total clicks, Avg duration) follow the selection. Your selection is remembered in the browser. Hover a site and click **only** to jump to just that one.
- **Date** — IST day, with previous/next and Today shortcuts.
- Click any row for the session timeline and mouse replay. `Esc` closes it.
- Light/dark toggle in the top-right.

A “website” is the page’s hostname (lower-cased, `www.` stripped), so `www.shop.com` and `shop.com` count as one site.

## Track a site

```html
<script>
  window.__TRACKER_BACKEND__ = "https://your-analytics-host.onrender.com";
</script>
<script src="https://your-analytics-host.onrender.com/tracker.js"></script>
```

Or just load `tracker.js` from your analytics host — it detects the backend from its own URL.

## API

All admin endpoints accept `from` / `to` (epoch ms) and `sites` (comma-separated hostnames, omit for all).

| Endpoint | Purpose |
|----------|---------|
| `GET /admin/analytics?page=&pageSize=` | Sessions, newest first |
| `GET /admin/analytics/stats` | KPI numbers |
| `GET /admin/analytics/sites` | Websites seen, with visitor/session counts for the range |
| `GET /admin/analytics/session/:id/events` | Timeline events for one session |
| `DELETE /admin/analytics/ip/:ip` | Delete an IP’s sessions and ignore it for 48 h |
| `GET /admin/stream` | Server-sent events for live updates |

## Deploy (e.g. Render)

1. Set root to this folder (or deploy this folder as its own service).
2. Add `REDIS_URL`, `NODE_VERSION=22` (and optionally `IPAPI_IS_KEY`).
3. Start command: `npm start`
4. Point sites’ `tracker.js` / `__TRACKER_BACKEND__` at this service URL.

`public/index.html` uses an empty `BACKEND`, so it works when opened from the Render URL. `netlify-drop/index.html` has `BACKEND` set to the Render URL, so it works from Netlify.
