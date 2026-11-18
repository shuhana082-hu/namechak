"use strict";
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config (set these in Render > Environment) ----
// UPSTREAM_URL: তোমার ডেটা সোর্স। {uid} ও {region} প্লেসহোল্ডার ব্যবহার করা যাবে।
// উদাহরণ: https://your-data-source.example/api/info?uid={uid}&region={region}
const UPSTREAM_URL = process.env.UPSTREAM_URL || "";
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || ""; // থাকলে Authorization: Bearer ... যাবে
const UPSTREAM_KEY_HEADER = process.env.UPSTREAM_KEY_HEADER || "Authorization"; // যেমন x-api-key
const API_KEYS = (process.env.API_KEYS || "").split(",").map(s => s.trim()).filter(Boolean); // খালি = ওপেন
const DEFAULT_REGION = process.env.DEFAULT_REGION || "BD";
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_SECONDS) || 300) * 1000;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 60;

app.set("trust proxy", 1);
app.use(cors());

// ---- Rate limit ----
app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  limit: RATE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, slow down." },
}));

// ---- Simple in-memory cache ----
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { cache.delete(key); return null; }
  return hit.val;
}
function cacheSet(key, val) {
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  cache.set(key, { val, exp: Date.now() + CACHE_TTL_MS });
}

// ---- Optional API key check ----
function auth(req, res, next) {
  if (API_KEYS.length === 0) return next();
  const key = req.get("x-api-key") || req.query.key;
  if (key && API_KEYS.includes(key)) return next();
  return res.status(401).json({ success: false, error: "Invalid or missing API key." });
}

// ---- Provider: upstream থেকে ডেটা আনে ও স্ট্যান্ডার্ড ফরম্যাটে সাজায় ----
async function fetchPlayer(uid, region) {
  if (!UPSTREAM_URL) {
    const e = new Error("UPSTREAM_URL is not configured on the server.");
    e.status = 503;
    throw e;
  }
  const url = UPSTREAM_URL.replace("{uid}", encodeURIComponent(uid)).replace("{region}", encodeURIComponent(region));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: UPSTREAM_KEY ? { [UPSTREAM_KEY_HEADER]: UPSTREAM_KEY_HEADER.toLowerCase() === "authorization" ? `Bearer ${UPSTREAM_KEY}` : UPSTREAM_KEY } : {},
    });
    if (r.status === 404) { const e = new Error("Player not found."); e.status = 404; throw e; }
    if (!r.ok) { const e = new Error(`Upstream error (${r.status}).`); e.status = 502; throw e; }
    return normalize(await r.json(), uid, region);
  } catch (err) {
    if (err.name === "AbortError") { const e = new Error("Upstream timeout."); e.status = 504; throw e; }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// বিভিন্ন সোর্সের ফিল্ড নাম আলাদা হতে পারে, তাই কয়েকটা সম্ভাব্য নাম চেক করা হয়।
function pick(o, ...keys) {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k];
  return null;
}
function ts(v) {
  const n = Number(v);
  return n > 1e9 && n < 1e11 ? new Date(n * 1000).toISOString() : (v ?? null);
}
function normalize(raw, uid, region) {
  // ফরম্যাট ১: basicinfo / basicInfo (lowercase বা camelCase দুটোই চলবে)
  const bi = raw && (raw.basicinfo || raw.basicInfo);
  if (bi) {
    const c = raw.clanbasicinfo || raw.clanBasicInfo || {};
    const so = raw.socialinfo || raw.socialInfo || {};
    const b = bi;
    const name = pick(b, "nickname");
    if (!name) { const e = new Error("Player not found."); e.status = 404; throw e; }
    return {
      success: true,
      uid: String(pick(b, "accountid", "accountId") || uid),
      name,
      level: pick(b, "level"),
      likes: pick(b, "liked"),
      region: pick(b, "region") || region,
      signature: pick(so, "signature"),
      last_login: ts(pick(b, "lastloginat", "lastLoginAt")),
      created_at: ts(pick(b, "createat", "createAt")),
      battle_royale: { max_rank: pick(b, "maxrank", "maxRank"), points: pick(b, "rankingpoints", "rankingPoints") },
      clash_squad: { max_rank: pick(b, "csmaxrank", "csMaxRank"), points: pick(b, "csrankingpoints", "csRankingPoints") },
      guild: {
        id: pick(c, "clanid", "clanId"), name: pick(c, "clanname", "clanName"), level: pick(c, "clanlevel", "clanLevel"),
        member_count: pick(c, "membernum", "memberNum"), capacity: pick(c, "capacity"),
      },
      release_version: pick(b, "releaseversion", "releaseVersion"),
      fetched_at: new Date().toISOString(),
    };
  }
  // ফরম্যাট ২: AccountInfo / flat / player ধরনের সোর্স
  const d = raw.player || raw.data || raw.AccountInfo || raw;
  const acc = raw.AccountInfo || d;
  const guild = raw.GuildInfo || d.guild || {};
  const name = pick(acc, "name", "nickname", "AccountName");
  if (!name) { const e = new Error("Player not found."); e.status = 404; throw e; }
  return {
    success: true,
    uid: String(uid),
    name,
    level: pick(acc, "level", "AccountLevel"),
    likes: pick(acc, "likes", "liked", "AccountLikes"),
    region: pick(acc, "region", "AccountRegion") || region,
    signature: pick(d, "signature") || pick(raw.SocialInfo || {}, "signature"),
    last_login: pick(acc, "last_login", "AccountLastLogin"),
    created_at: pick(acc, "created_at", "AccountCreateTime"),
    battle_royale: { max_rank: pick(d, "br_max_rank", "BrMaxRank"), points: pick(d, "br_rank_point", "BrRankPoint") },
    clash_squad: { max_rank: pick(d, "cs_max_rank", "CsMaxRank"), points: pick(d, "cs_rank_point", "CsRankPoint") },
    guild: {
      id: pick(guild, "id", "GuildID"), name: pick(guild, "name", "GuildName"),
      level: pick(guild, "level", "GuildLevel"), member_count: pick(guild, "member_count", "GuildMember"),
      capacity: pick(guild, "capacity", "GuildCapacity"),
    },
    fetched_at: new Date().toISOString(),
  };
}

// ---- Routes ----
const HOME_HTML = [
'<!doctype html><html lang="bn"><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>FF Name Check</title>',
'<style>',
':root{--bg:#0a0e17;--card:#111826;--line:#1f2a3d;--text:#e6edf3;--mut:#8b97a8;--acc:#ff6a3d}',
'*{box-sizing:border-box}',
'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}',
'.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}',
'h1{margin:0 0 4px;font-size:22px}',
'p.sub{margin:0 0 20px;color:var(--mut);font-size:14px}',
'form{display:flex;flex-direction:column;gap:10px}',
'input{width:100%;padding:14px;font-size:16px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);outline:none}',
'input:focus{border-color:var(--acc)}',
'button{padding:14px;font-size:16px;font-weight:600;border:0;border-radius:10px;background:var(--acc);color:#fff;cursor:pointer}',
'button:disabled{opacity:.6;cursor:wait}',
'#out{margin-top:18px;min-height:24px;padding:14px;border-radius:10px;background:var(--bg);border:1px dashed var(--line);font-size:18px;text-align:center;word-break:break-word;display:none}',
'#out.err{color:#ff7b72;font-size:15px}',
'#out small{display:block;color:var(--mut);font-size:12px;margin-bottom:4px}',
'</style></head><body><main class="card">',
'<h1>Free Fire Name Check</h1>',
'<p class="sub">প্লেয়ারের UID দিন, নাম দেখুন।</p>',
'<form id="f"><input id="uid" inputmode="numeric" autocomplete="off" placeholder="UID লিখুন" maxlength="15" required>',
'<button id="btn" type="submit">Check</button></form>',
'<div id="out" role="status" aria-live="polite"></div>',
'</main><script>',
'var f=document.getElementById("f"),u=document.getElementById("uid"),b=document.getElementById("btn"),o=document.getElementById("out");',
'function show(t,e,label){o.style.display="block";o.className=e?"err":"";o.textContent="";',
'if(label){var s=document.createElement("small");s.textContent=label;o.appendChild(s);}',
'o.appendChild(document.createTextNode(t));}',
'f.addEventListener("submit",function(ev){ev.preventDefault();',
'var v=u.value.replace(/\\D/g,"");',
'if(v.length<5){show("সঠিক UID দিন (শুধু সংখ্যা)",true);return;}',
'b.disabled=true;b.textContent="Checking...";',
'fetch("/api/check?uid="+encodeURIComponent(v)).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})',
'.then(function(x){if(x.ok&&x.j.name){show(x.j.name,false,"Player Name");}else{show(x.j.error||"কিছু ভুল হয়েছে",true);}})',
'.catch(function(){show("সার্ভারে সংযোগ হয়নি, আবার চেষ্টা করুন",true);})',
'.then(function(){b.disabled=false;b.textContent="Check";});});',
'</script></body></html>'
].join("\n");

app.get("/", (req, res) => res.type("html").send(HOME_HTML));

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

async function handle(req, res, onlyName) {
  const uid = String(req.query.uid || "").trim();
  const region = String(req.query.region || DEFAULT_REGION).trim().toUpperCase();
  if (!/^\d{5,15}$/.test(uid)) {
    return res.status(400).json({ success: false, error: "Invalid uid. Use digits only (5-15 digits)." });
  }
  try {
    const key = `${region}:${uid}`;
    let data = cacheGet(key);
    const cached = !!data;
    if (!data) { data = await fetchPlayer(uid, region); cacheSet(key, data); }
    if (onlyName) return res.json({ success: true, uid: data.uid, name: data.name, region: data.region, cached });
    res.json({ ...data, cached });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message || "Internal error" });
  }
}

// শুধু নাম দেয়, API key লাগে না (ওয়েব পেজের জন্য)। রেট লিমিট আছে।
app.get("/api/check", async (req, res) => {
  const uid = String(req.query.uid || "").trim();
  const region = String(req.query.region || DEFAULT_REGION).trim().toUpperCase();
  if (!/^\d{5,15}$/.test(uid)) return res.status(400).json({ success: false, error: "সঠিক UID দিন (শুধু সংখ্যা)" });
  try {
    const key = region + ":" + uid;
    let data = cacheGet(key);
    if (!data) { data = await fetchPlayer(uid, region); cacheSet(key, data); }
    res.json({ success: true, name: data.name });
  } catch (err) {
    const msg = err.status === 404 ? "প্লেয়ার পাওয়া যায়নি" : err.status === 503 ? "সার্ভার এখনো সেট করা হয়নি" : "সোর্স সার্ভার থেকে তথ্য আনা যায়নি, একটু পরে চেষ্টা করুন";
    res.status(err.status || 500).json({ success: false, error: msg });
  }
});

app.get("/api/player", auth, (req, res) => handle(req, res, false));
app.get("/api/name", auth, (req, res) => handle(req, res, true));

app.use((req, res) => res.status(404).json({ success: false, error: "Not found." }));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
