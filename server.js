const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const SECRET = process.env.REBUILD_SECRET || "changeme";
const SUPA = process.env.SUPABASE_URL || "";
const KEY = process.env.SUPABASE_ANON_KEY || "";

// allow the Studio (any origin) to call /rebuild
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
  }
  return browserPromise;
}

app.get("/health", (req, res) => res.send("ok"));

// Rebuild the recognition library from all markers in Supabase.
app.get("/rebuild", async (req, res) => {
  if (req.query.token !== SECRET) return res.status(401).json({ error: "bad token" });
  if (!SUPA || !KEY) return res.status(500).json({ error: "SUPABASE_URL / SUPABASE_ANON_KEY not set" });

  let page;
  const started = Date.now();
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.evaluateOnNewDocument((cfg) => { window.__CFG = cfg; }, { supa: SUPA, key: KEY });
    await page.goto(`http://localhost:${PORT}/compile.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction("window.__done === true || !!window.__err", { timeout: 240000, polling: 500 });
    const out = await page.evaluate(() => ({ done: window.__done, err: window.__err, info: window.__info }));
    if (out.err) return res.status(500).json({ error: out.err, seconds: ((Date.now() - started) / 1000) | 0 });
    res.json({ ok: true, info: out.info, seconds: ((Date.now() - started) / 1000) | 0 });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

app.listen(PORT, () => console.log("ADREC AR compile service listening on " + PORT));
