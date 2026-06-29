const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 10000;
const SECRET = process.env.REBUILD_SECRET || "changeme";
const SUPA = process.env.SUPABASE_URL || "";
const KEY = process.env.SUPABASE_ANON_KEY || "";

// --- AI "Ask the report" config (additive; does not affect compile routes) ---
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || "";          // set at deploy time, never in code
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL   || "claude-haiku-4-5-20251001";
const KB_URL          = process.env.KB_URL || "https://adrec-ar.web.app/report-knowledge.json";

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Inline compile page. Reads window.__CFG:
//   { supa, key }                      -> compile ALL markers -> library.mind
//   { supa, key, singleImg, outName }  -> compile ONE image   -> outName (e.g. cover.mind)
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

    var imgs, outName;
    if (CFG.singleImg){
      outName = CFG.outName || "single.mind";
      console.log("[c] single image -> " + outName);
      imgs = [ await downscale(await loadImg(CFG.singleImg), 512) ];
    } else {
      outName = "library.mind";
      const rows = await (await fetch(SUPA + "/rest/v1/markers?select=marker_url&order=created_at.asc", { headers: AUTH })).json();
      if (!Array.isArray(rows) || rows.length === 0){ window.__info={targets:0, note:"no markers"}; window.__done=true; return; }
      console.log("[c] markers=" + rows.length);
      imgs = await Promise.all(rows.map(r => loadImg(r.marker_url)));
      imgs = await Promise.all(imgs.map(i => downscale(i, 384)));
    }
    console.log("[c] compiling " + imgs.length + " @ " + imgs.map(i=>i.naturalWidth+"x"+i.naturalHeight).join(","));
    const compiler = new window.MINDAR.IMAGE.Compiler();
    await compiler.compileImageTargets(imgs, (p)=>{ if(Math.round(p*100)%20===0) console.log("[c] progress " + Math.round(p*100) + "%"); });
    console.log("[c] compiled, exporting");
    const buf = compiler.exportData();
    console.log("[c] exported bytes=" + buf.byteLength);

    await fetch(SUPA + "/storage/v1/object/ar/" + outName, { method:"DELETE", headers: AUTH }).catch(()=>{});
    const up = await fetch(SUPA + "/storage/v1/object/ar/" + outName, { method:"POST", headers: { ...AUTH, "x-upsert":"true", "Content-Type":"application/octet-stream" }, body: buf });
    if (up.status >= 300) throw new Error("upload status " + up.status);
    window.__info = { out: outName, targets: imgs.length, bytes: buf.byteLength, upload: up.status };
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
      protocolTimeout: 600000,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
             "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
             "--disable-backgrounding-occluded-windows",
             "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
             "--enable-webgl", "--ignore-gpu-blocklist"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
  }
  return browserPromise;
}

app.get("/health", (req, res) => res.send("ok"));

async function runCompile(res, cfg) {
  let page;
  const started = Date.now();
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    page.on("console", (m) => console.log("[page] " + m.text()));
    page.on("pageerror", (e) => console.log("[pageerror] " + e.message));
    await page.evaluateOnNewDocument((c) => { window.__CFG = c; }, cfg);
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
}

// Rebuild the shared library from all published markers.
app.get("/rebuild", (req, res) => {
  if (req.query.token !== SECRET) return res.status(401).json({ error: "bad token" });
  if (!SUPA || !KEY) return res.status(500).json({ error: "SUPABASE_URL / SUPABASE_ANON_KEY not set" });
  runCompile(res, { supa: SUPA, key: KEY });
});

// Compile a single image into a named .mind  e.g. /compile-one?img=URL&out=cover.mind
app.get("/compile-one", (req, res) => {
  if (req.query.token !== SECRET) return res.status(401).json({ error: "bad token" });
  if (!SUPA || !KEY) return res.status(500).json({ error: "SUPABASE_URL / SUPABASE_ANON_KEY not set" });
  if (!req.query.img) return res.status(400).json({ error: "missing img" });
  runCompile(res, { supa: SUPA, key: KEY, singleImg: req.query.img, outName: req.query.out || "single.mind" });
});

// ===================== AI: "Ask the report" =====================
// POST /ask  { question: "..." }  -> { answer, citations:[pages] }
// Grounded ONLY on report-knowledge.json. Key lives in ANTHROPIC_API_KEY env var.
let KB_CACHE = null, KB_AT = 0;
async function getKB() {
  if (KB_CACHE && (Date.now() - KB_AT) < 3600000) return KB_CACHE;
  const r = await fetch(KB_URL, { cache: "no-store" });
  if (!r.ok) throw new Error("KB fetch " + r.status);
  KB_CACHE = await r.text(); KB_AT = Date.now();
  return KB_CACHE;
}

function systemPrompt(kb) {
  return [
    "You are the ADREC Report Assistant, embedded in an augmented-reality experience for the Abu Dhabi Real Estate Centre (ADREC) 2025 Market Report.",
    "You answer questions about THIS report only, using ONLY the verified data in the JSON knowledge base below.",
    "",
    "RULES (strict):",
    "1) Use ONLY facts present in the knowledge base. NEVER invent, estimate, or extrapolate a number. If a figure isn't there, say it isn't in the report.",
    "2) SCOPE: the report covers Abu Dhabi Emirate in 2025 only. If asked about other emirates (e.g. Dubai), other years, or topics outside the report, say it's outside this report and offer what the report does cover.",
    "3) NO ADVICE: never give personalized investment, financial, or legal advice, or a buy/sell/hold recommendation. Share the report's facts, then add one short sentence that this is information from the report, not advice.",
    "4) ALWAYS cite the report page number(s) you used, like (p.46).",
    "5) Keep answers short and conversational — 1-4 sentences, suitable for a phone screen. Use AED for money.",
    "6) INTENT QUESTIONS: for open or judgement-style questions (e.g. 'where should I invest', 'what are the hot areas', 'best place to buy', 'is it a good time'), do NOT recommend. Interpret the intent and SYNTHESISE the report's relevant standouts — top districts by price, price growth, FDI and expat demand, off-plan activity, supply and rents — combining facts across sections, and present them as what the report highlights, ending with the not-advice caveat.",
    "7) Be genuinely helpful and conversational: understand paraphrases and follow-ups, connect related figures, and reason over the data — but never go beyond what the knowledge base contains.",
    "",
    "KNOWLEDGE BASE (JSON):",
    kb
  ].join("\n");
}

app.post("/ask", async (req, res) => {
  try {
    const question = (req.body && req.body.question || "").toString().slice(0, 600).trim();
    if (!question) return res.status(400).json({ error: "missing question" });
    if (!ANTHROPIC_KEY) return res.status(503).json({ error: "AI not configured", hint: "set ANTHROPIC_API_KEY" });
    const kb = await getKB();
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 650,
        system: systemPrompt(kb),
        messages: [{ role: "user", content: question }]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: (data && data.error && data.error.message) || ("AI status " + r.status) });
    const answer = (data.content || []).map(b => b.text || "").join("").trim();
    const citations = (answer.match(/p\.?\s?(\d{1,3})/gi) || []).map(s => s.replace(/[^\d]/g, ""));
    res.json({ answer, citations: [...new Set(citations)] });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.listen(PORT, () => console.log("ADREC AR compile service listening on " + PORT));
