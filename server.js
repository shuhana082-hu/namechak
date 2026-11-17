"use strict";
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config (Render > Environment) ----
// FF_API_KEY: developers.freefirecommunity.com থেকে নেওয়া তোমার API key (বাধ্যতামূলক)
const FF_API_BASE = (process.env.FF_API_BASE || "https://developers.freefirecommunity.com/api/v1").replace(/\/+$/, "");
const FF_API_KEY = process.env.FF_API_KEY || "";
// তোমার নিজের ক্লায়েন্টদের জন্য key (খালি = ওপেন)
const API_KEYS = (process.env.API_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const DEFAULT_REGION = (process.env.DEFAULT_REGION || "BD").toUpperCase();
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_SECONDS) || 1800) * 1000;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 60;

// Upstream শুধু sg / ind / br বোঝে। BD → sg (Southeast Asia server)।
const REGION_MAP = { BD: "sg", SG: "sg", IND: "ind", IN: "ind", BR: "br" };
const UPSTREAM_REGIONS = ["sg", "ind", "br"];

app.set("trust proxy", 1);
app.use(cors());

app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  limit: RATE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, slow down." },
}));

// ---- In-memory cache ----
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

// ---- Optional client auth ----
function auth(req, res, next) {
  if (API_KEYS.length === 0) return next();
  const key = req.get("x-api-key") || req.query.key;
  if (key && API_KEYS.includes(key)) return next();
  return res.status(401).json({ success: false, error: "Invalid or missing API key." });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---- Upstream call (Free Fire Community API) ----
async function callUpstream(endpoint, params) {
  if (!FF_API_KEY) throw httpError(503, "FF_API_KEY is not configured on the server.");
  const qs = new URLSearchParams(params).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${FF_API_BASE}/${endpoint}?${qs}`, {
      signal: ctrl.signal,
      headers: { "x-api-key": FF_API_KEY, Accept: "application/json" },
    });
    if (r.status === 404) throw httpError(404, "Player not found.");
    if (r.status === 429) throw httpError(429, "Upstream rate limit reached. Try again later.");
    if (r.status === 401) throw httpError(502, "Upstream rejected the server's FF_API_KEY.");
    if (r.status === 400) throw httpError(400, "Upstream rejected the request parameters.");
    if (!r.ok) throw httpError(502, `Upstream error (${r.status}).`);
    const json = await r.json();
    if (json && json.status === "error") throw httpError(404, json.message || "Player not found.");
    return json && json.data ? json.data : json;
  } catch (err) {
    if (err.name === "AbortError") throw httpError(504, "Upstream timeout.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Region মিলতে হয়, তাই প্রথমে mapped region, না পেলে বাকি দুটো চেষ্টা করা হয়।
async function callWithRegion(endpoint, uid, region) {
  const first = REGION_MAP[region] || region.toLowerCase();
  const order = [first, ...UPSTREAM_REGIONS.filter(r => r !== first)];
  let lastErr;
  for (const r of order) {
    try {
      const data = await callUpstream(endpoint, { region: r, uid });
      return { data, usedRegion: r };
    } catch (err) {
      lastErr = err;
      if (err.status !== 404) throw err; // শুধু not-found হলে পরের region
    }
  }
  throw lastErr || httpError(404, "Player not found.");
}

function normalizePlayer(d, uid, usedRegion) {
  const name = d.name || d.nickname;
  if (!name) throw httpError(404, "Player not found.");
  return {
    success: true,
    uid: String(d.uid || uid),
    name,
    level: d.level ?? null,
    likes: d.likes ?? null,
    region: d.region || usedRegion,
    rank: d.rank ?? null,
    tier: d.tier ?? null,
    signature: d.signature ?? null,
    guild: { id: d.guildId ?? null, name: typeof d.guild === "string" ? d.guild : (d.guild && d.guild.name) || null },
    badges: Array.isArray(d.badges) ? d.badges : [],
    equipped_pet: d.equippedPet ?? null,
    equipped_character: d.equippedCharacter ?? null,
    fetched_at: new Date().toISOString(),
  };
}

// ---- Routes ----
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Name Check API</title>
<body style="font-family:system-ui;background:#0a0e17;color:#e6edf3;max-width:640px;margin:10vh auto;padding:0 16px">
<h1>✅ API Running</h1>
<p>Free Fire name check API is live.</p>
<pre style="background:#111826;padding:12px;border-radius:8px;overflow:auto">GET /api/player?uid=PLAYER_UID&amp;region=BD
GET /api/name?uid=PLAYER_UID
GET /api/stats?uid=PLAYER_UID
GET /api/ban?uid=PLAYER_UID
GET /api/wishlist?uid=PLAYER_UID
GET /health</pre></body>`);
});

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), upstream_configured: !!FF_API_KEY }));

function parseQuery(req) {
  const uid = String(req.query.uid || "").trim();
  const region = String(req.query.region || DEFAULT_REGION).trim().toUpperCase();
  if (!/^\d{9,10}$/.test(uid)) throw httpError(400, "Invalid uid. Use 9-10 digits only.");
  return { uid, region };
}

// cache + error wrapper
function route(endpoint, build) {
  return async (req, res) => {
    try {
      const { uid, region } = parseQuery(req);
      const key = `${endpoint}:${region}:${uid}`;
      let out = cacheGet(key);
      const cached = !!out;
      if (!out) {
        const { data, usedRegion } = endpoint === "bancheck"
          ? { data: await callUpstream("bancheck", { uid, lang: String(req.query.lang || "en") }), usedRegion: null }
          : await callWithRegion(endpoint, uid, region);
        out = build(data, uid, usedRegion);
        cacheSet(key, out);
      }
      res.json({ ...out, cached });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, error: err.message || "Internal error" });
    }
  };
}

const playerRoute = route("info", normalizePlayer);
app.get("/api/player", auth, playerRoute);
app.get("/api/name", auth, async (req, res) => {
  // শুধু নাম ফেরত দেয়, একই cache ব্যবহার করে
  const send = res.json.bind(res);
  res.json = (body) => send(body && body.success
    ? { success: true, uid: body.uid, name: body.name, region: body.region, cached: body.cached }
    : body);
  return playerRoute(req, res);
});
app.get("/api/stats", auth, route("stats", (d, uid, r) => ({ success: true, uid, region: r, stats: d })));
app.get("/api/wishlist", auth, route("wishlist", (d, uid, r) => ({ success: true, uid, region: r, wishlist: d.wishlist || [] })));
app.get("/api/ban", auth, route("bancheck", (d, uid) => ({ success: true, uid, ban: d })));

app.use((req, res) => res.status(404).json({ success: false, error: "Not found." }));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
