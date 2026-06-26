const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 10000;
const SECRET = process.env.REBUILD_SECRET || "changeme";
const SUPA = process.env.SUPABASE_URL || "";
const KEY = process.env.SUPABASE_ANON_KEY || "";

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  next();
});

// The compile page is served inline (no separate file needed).
const COMPILE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<script src="https://aframe.io/releases/1.5.0/aframe.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-aframe.prod.js"></script>
</head><body><script>
function loadImg(u){return new Promise((res,rej)=>{const im=new Image();im.crossOrigin="anonymous";im.onload=()=>res(im);im.onerror=()=>rej(new Error("img load "+u));im.src=u;});}
function downscale(im,max){return new Promise(res=>{let w=im.naturalWidth,h=im.naturalHeight;if(Math.max(w,h)<=max){res(im);return;}let s=max/Math.max(w,h);let c=document.createElement("canvas");c.width=Math.round(w*s);c.height=Math.round(h*s);c.getContext("2d").drawImage(im,0,0,c.width,c.height);let o=new Image();o.onload=()=>res(o);o.src=c.toDataURL("image/jpeg",0.9);});}
(async()=>{
  try{
    const CFG = window.__CFG || {};
    const SUPA = CFG.supa, KEY = CFG.key;
    const AUTH = { apikey: KEY, Authorization: "Bearer " + KEY };
    for (let i=0; i<200 && !(window.MINDAR && window.MINDAR.IMAGE && window.MINDAR.IMAGE.Compiler); i++){ await new Promise(r=>setTimeout(r,250)); }
    if (!(window.MINDAR && window.MINDAR.IMAGE && window.MINDAR.IMAGE.Compiler)) throw new Error("MindAR compiler not available");
    console.log("[c] compiler ready, aframe=" + (typeof window.AFRAME));
    const rows = await (await fetch(SUPA + "/rest/v1/markers?select=marker_url&order=created_at.asc", { headers: AUTH })).json();
    if (!Array.isArray(rows) || rows.length === 0){ window.__info={targets:0, note:"no markers"}; window.__done=true; return; }
    console.log("[c] markers=" + rows.length);
    let imgs = await Promise.all(rows.map(r => loadImg(r.marker_url)));
    imgs = await Promise.all(imgs.map(i => downscale(i, 384)));
    console.log("[c] images ready, compiling " + imgs.length + " @ " + imgs.map(i=>i.naturalWidth+"x"+i.naturalHeight).join(","));
    const compiler = new window.MINDAR.IMAGE.Compiler();
    await compiler.compileImageTargets(imgs, (p)=>{ if(Math.round(p*100)%20===0) console.log("[c] progress " + Math.round(p*100) + "%"); });
    console.log("[c] compiled, exporting");
    const buf = compiler.exportData();
    console.log("[c] exported bytes=" + buf.byteLength);
    await fetch(SUPA + "/storage/v1/object/ar/library.mind", { method:"DELETE", headers: AUTH }).catch(()=>{});
    const up = await fetch(SUPA + "/storage/v1/object/ar/library.mind", { method:"POST", headers: { ...AUTH, "x-upsert":"true", "Content-Type":"application/octet-stream" }, body: buf });
    if (up.status >= 300) throw new Error("upload status " + up.status);
    window.__info = { targets: imgs.length, bytes: buf.byteLength, upload: up.status };
    window.__done = true;
  } catch (e) { window.__err = String((e && e.message) || e); console.log("[c] ERROR " + window.__err); }
})();
</script></body></html>`;

app.get("/compile.html", (req, res) => { res.type("html").send(COMPILE_HTML); });

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      protocolTimeout: 600000, // 10 min — don't time out mid-compile
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
             "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
             "--disable-backgrounding-occluded-windows"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
  }
  return browserPromise;
}

app.get("/health", (req, res) => res.send("ok"));

app.get("/rebuild", async (req, res) => {
  if (req.query.token !== SECRET) return res.status(401).json({ error: "bad token" });
  if (!SUPA || !KEY) return res.status(500).json({ error: "SUPABASE_URL / SUPABASE_ANON_KEY not set" });
  let page;
  const started = Date.now();
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    page.on("console", (m) => console.log("[page] " + m.text()));
    page.on("pageerror", (e) => console.log("[pageerror] " + e.message));
    await page.evaluateOnNewDocument((cfg) => { window.__CFG = cfg; }, { supa: SUPA, key: KEY });
    await page.goto(`http://localhost:${PORT}/compile.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction("window.__done === true || !!window.__err", { timeout: 540000, polling: 500 });
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
