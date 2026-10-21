# Setup guide — Render (free) + Netlify Drop + cron-job.org

How it fits together:

```
 Your websites ──(tracker.js)──▶  Render server  ◀──(reads data)──  Dashboard on Netlify
                                       │
                                     Redis
 cron-job.org ──(pings /health every few min)──▶ Render server  (keeps it awake)
```

What's in this zip:

| Path | Goes to | Purpose |
|------|---------|---------|
| `server.js`, `tracker.js`, `package.json`, `public/`, `.gitignore`, `.env.example` | GitHub → Render | The analytics server |
| `netlify-drop/index.html` | Netlify Drop | The dashboard page, already pointed at your Render URL |
| `SETUP.md`, `README.md` | — | Instructions |

**Wherever you see `<your-render-url>` below, put your own Render URL (from Step 2), e.g. `https://my-analytics.onrender.com`.**

You need: a GitHub account, a Render account, a Netlify account, a cron-job.org account, and your Redis connection URL.

---

## Step 1 — Put the code on GitHub

Render's free web services deploy from a Git repo, so this step is required.

**Option A — in the browser (no Terminal):**
1. Unzip this file.
2. On github.com click **New repository**, give it a name (e.g. `analytics-standalone`), keep it **Private**, and don't add a README. Click **Create repository**.
3. On the next page click **uploading an existing file**.
4. Open the unzipped `analytics-standalone` folder and drag **everything inside it** onto the page: `server.js`, `tracker.js`, `package.json`, the `public` folder, and the rest.
   - On a Mac, Finder hides `.gitignore` and `.env.example`. Press **Cmd + Shift + .** to show them. They're optional, but nice to have.
5. Click **Commit changes**.

**Option B — with Terminal:**
```bash
cd ~/Downloads/analytics-standalone
git init
git add .
git commit -m "Analytics server"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

> If you already have the repo from before, just replace the files and push. Render redeploys automatically.

---

## Step 2 — Create the free Render web service

1. Go to **dashboard.render.com → New → Web Service**.
2. Connect GitHub and pick the repo from Step 1.
3. Fill in:

   | Setting | Value |
   |---|---|
   | Name | `analytics-standalone` (this sets your URL) |
   | Region | Same region as your Redis, if your Redis is on Render |
   | Branch | `main` |
   | Root directory | *(leave empty)* |
   | Runtime | Node |
   | Build command | `npm install` |
   | Start command | `npm start` |
   | Instance type | **Free** |

4. Under **Environment Variables**, add:

   | Key | Value | Notes |
   |---|---|---|
   | `REDIS_URL` | your Redis URL | Required. Copy the exact same value your old server used. |
   | `NODE_VERSION` | `22` | Makes Render use a supported Node version. |
   | `IPAPI_IS_KEY` | your ipapi.is key | Optional. Adds country and VPN labels. |

   - **Do not add `ADMIN_PASSWORD`.** The Netlify dashboard can't send a password, so it would stop working.
   - **Do not add `PORT`.** Render sets it for you.

5. Click **Create Web Service** and wait for the log to say `Analytics standalone running on port …`.
6. Under **Settings → Health Check Path**, enter `/health`.
7. Copy the URL at the top of the service page, e.g. `https://my-analytics.onrender.com`.
   This is **your Render URL**. You'll paste it in Step 3, Step 4 and Step 5.
   > Render builds it from the service name. If the name is taken, Render adds a random suffix (e.g. `my-analytics-ab12.onrender.com`). Always copy the exact URL Render shows.

**Test it:** open `<your-render-url>/health`. You should see:
```json
{"status":"ok","redis":"ready"}
```
If it says `connecting` or `reconnecting`, the `REDIS_URL` is wrong.

> **About your Redis URL:**
> - A Render Redis/Key Value **internal** URL (`redis://red-xxxx:6379`) only works if the web service is in the same region.
> - Otherwise use the **external** URL (`rediss://…`), and allow outside connections in the Redis settings.
> - Upstash and Redis Cloud URLs (`rediss://…`) work as they are.

---

## Step 3 — Keep it awake with cron-job.org

Free Render services go to sleep after **15 minutes** with no traffic. The first request after that takes 30–60 seconds, and visits during that time are lost. A regular ping prevents this.

> **Every 10 seconds isn't possible.** cron-job.org's shortest interval is **every 1 minute**. You don't need it that often anyway: anything under 15 minutes keeps the server awake. **Every 5 minutes** is a safe choice.

1. Log in at **cron-job.org → Cronjobs → Create cronjob**.
2. Fill in:

   | Field | Value |
   |---|---|
   | Title | `Keep analytics awake` |
   | URL | `<your-render-url>/health` |
   | Schedule | **Every 5 minutes** (or every 1 minute if you prefer) |
   | Request method | GET (in the Advanced tab; it's the default) |
   | Headers / authentication | **leave empty** |

3. Turn on **Notify me when the job fails**. If Render or Redis goes down, you'll get an email.
4. Click **Create**, then **Test run**. You should see `200 OK`.

> **Free plan limit:** Render gives **750 free hours per month** per workspace. One service running all the time uses about 744 hours, so this fits, but only if it's your **only** free web service. A second free service kept awake would run out of hours late in the month. If that happens, move one to the Starter plan.

---

## Step 4 — Put the dashboard on Netlify Drop

1. **Put your Render URL into the dashboard file (required).** Open `netlify-drop/index.html` in a text editor (VS Code, Notepad, or TextEdit). In TextEdit, use **Format → Make Plain Text** first.
   Search for `var BACKEND`. You'll find:
   ```js
   var BACKEND = "https://YOUR-RENDER-SERVICE.onrender.com";
   ```
   Replace the placeholder with your Render URL from Step 2, keeping the quotes:
   ```js
   var BACKEND = "https://my-analytics.onrender.com";
   ```
   It must start with `https://` and have **no `/` at the end**. Save the file.
   > If you forget this step, the dashboard shows **"Render URL not set"** and a **NOT CONFIGURED** badge.
2. **Log in to Netlify first** at app.netlify.com.
   > Without logging in, a Netlify Drop site is **deleted after 1 hour**.
3. Go to **app.netlify.com/drop** and drag the whole **`netlify-drop` folder** onto the page. Drag the folder itself, not the zip.
4. Netlify gives you a URL like `https://random-name-123.netlify.app`. Open it. Within a few seconds you should see the dashboard with a green **LIVE** badge.
5. *(Optional)* Under **Site configuration → Change site name**, pick a nicer name.

**To update the dashboard later:** in Netlify, open your site, go to the **Deploys** tab, and drag the updated `netlify-drop` folder onto the drop area there.
> Don't use app.netlify.com/drop again: that creates a new site with a new URL.

---

## Step 5 — Add the tracker to your websites

Paste this before `</body>` on every page you want to track:

```html
<script src="<your-render-url>/tracker.js"></script>
```

Each website shows up automatically in the dashboard's **website picker** after its first visit.

---

## Checklist

- [ ] `<your-render-url>/health` shows `"redis":"ready"`
- [ ] cron-job.org test run returns `200`, scheduled every 5 minutes (or 1)
- [ ] Netlify dashboard shows a green **LIVE** badge
- [ ] Open one of your tracked sites in another tab: a new row appears on the dashboard within a few seconds

## Troubleshooting

| Problem | Cause / fix |
|---|---|
| Dashboard says **Render URL not set** / **NOT CONFIGURED** | You haven't replaced the placeholder in `netlify-drop/index.html` yet. See Step 4.1. |
| Dashboard says **RECONNECTING** and shows 0 | `BACKEND` in `netlify-drop/index.html` doesn't match your Render URL exactly, **or** `ADMIN_PASSWORD` is set on Render. Remove it. |
| Dashboard is slow to load the first time | Render was asleep. Check that the cron job is enabled and succeeding. |
| `/health` shows `reconnecting` | Wrong `REDIS_URL`, a region mismatch (internal URL), or the Redis firewall blocking Render. |
| No rows for one website | The tracker snippet isn't on that site, or it has the wrong URL. Open the site, press F12, and check the Network tab for a `track` request. |
| The Netlify site disappeared | It was dropped without logging in. Log in and drop it again. |

## Security note

With no password, anyone who finds your Netlify URL can see visitor data and delete IPs. Don't share the link, and choose a site name that's hard to guess.
