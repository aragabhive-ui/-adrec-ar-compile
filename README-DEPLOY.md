# ADREC AR — Compile Service (Render)

This is the server-side recognition compiler. It runs the exact MindAR compiler
in headless Chrome on a server, so publishing a marker never freezes your browser
and dense markers (like page 13) compile fine.

You deploy this once. Then publishing in the Studio just calls it.

---

## What it does
`GET /rebuild?token=YOUR_SECRET` → pulls all markers from Supabase, compiles
`library.mind`, uploads it back. Returns `{ ok:true, info:{ targets, bytes } }`.

---

## Deploy on Render (web UI — no command line needed)

### 1. Put these files in a GitHub repo
1. Go to **github.com** → **New repository** → name it `adrec-ar-compile` → Create.
2. On the new repo page click **"uploading an existing file"**.
3. Drag in **everything inside this `compile-service` folder**, keeping structure:
   - `server.js`
   - `package.json`
   - `Dockerfile`
   - `public/compile.html`   (create the `public` folder in the upload, or upload the file into a `public/` path)
4. Commit.

### 2. Create the Render service
1. Go to **dashboard.render.com** → **New +** → **Web Service**.
2. Connect your GitHub and pick the `adrec-ar-compile` repo.
3. Settings:
   - **Runtime / Environment:** Docker (Render auto-detects the `Dockerfile`)
   - **Instance type:** Free
4. Add **Environment Variables** (Advanced → Add Environment Variable):

   | Key | Value |
   |-----|-------|
   | `SUPABASE_URL` | `https://kptiytswkvlkaozsnfpe.supabase.co` |
   | `SUPABASE_ANON_KEY` | `sb_publishable_BwWNScuWMxtNVjP33hcKXQ_GlVHAoND` |
   | `REBUILD_SECRET` | pick any password-like string, e.g. `adrec-rebuild-7Kq2` |

5. **Create Web Service.** Wait for the first build (~3–5 min). It's live when status = "Live".

### 3. Test it
Render gives you a URL like `https://adrec-ar-compile.onrender.com`.
Open in a browser (replace the token with your secret):
```
https://adrec-ar-compile.onrender.com/rebuild?token=adrec-rebuild-7Kq2
```
You should get: `{"ok":true,"info":{"targets":2,"bytes":...}}` after ~10–60s.
(First call after idle is slow — the free instance "wakes up" ~50s. That's normal.)

---

## Then send me:
- your **Render URL** (e.g. `https://adrec-ar-compile.onrender.com`)
- the **REBUILD_SECRET** you chose

I'll wire the Studio's **Publish** + **Rebuild** to call this service, redeploy,
re-add page 13, and from then on publishing auto-rebuilds server-side — no browser
freezing, ever.

*(The Supabase URL and anon key above are the public, browser-safe values — fine to
put in Render. The REBUILD_SECRET is just to stop randoms from triggering rebuilds.)*
